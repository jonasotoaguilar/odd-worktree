'use strict';
// `gh` client for the `/prs` panel (T1, S1-S3): the pull request sibling of
// lib/gh-issues.js. `/prs` reads, mutates and opens pull requests through this
// module alone, so it keeps the issue client's whole contract:
//
// - Every spawn is `child_process.execFile` with an argv array and NO shell
//   string, under a bounded timeout (invariant 9). Nothing here prints or
//   persists a token; authentication stays inside `gh`.
// - Every exported call returns `{ok:true, ...}` or `{ok:false, error}` and
//   never throws — a missing binary, a non-zero exit, an empty body, malformed
//   JSON and a rejected runner all fail closed.
// - The repository identity is PINNED and validated exactly as
//   lib/gh-issues.js validates a pin (invariant 6): the caller hands back the
//   identity it already displayed, it is normalized to `<host>/<owner>/<repo>`,
//   it travels as `GH_REPO` and it ALWAYS wins over an ambient `GH_REPO`; a pin
//   the live environment cannot honour refuses the call BEFORE any child runs.
//   A write always resolves its scope fresh, so an action never runs on a
//   cached identity.
// - Capabilities fail closed (invariant 7): only a literal permission role
//   confirms one, and merge additionally needs a non-draft pull request and at
//   least one method the repository allows.
//
// THE ISSUE CLIENT IS INJECTED, NEVER REQUIRED. lib/gh-issues.js holds
// process-wide state (its runner seam, repository-scope cache and session
// gate), and the extension owns exactly ONE instance of it, loaded through its
// own cache-purging `libRequire`. A plain Node `require` of that file from here
// would be a DIFFERENT instance, so `tools/package-surface.test.js` pins that no
// `lib/` module pulls the issue client that way. Every seam this client needs
// therefore arrives as the injected `issues` module:
//
//   const client = createPrsClient({ issues });   // issues = lib/gh-issues.js
//   const client = bindIssuesClient(issues);      // same, for the convenience exports
//
// The injected module supplies `runGh`, `setGhRunner`, `normalizeScopeIdentity`,
// `reportedRepoName` and `checkoutRepoScope` (the fork override over gh's base
// answer) as it exports them; a seam the injected module does not export falls
// back to a local copy below, verbatim in behavior, which must be kept in step
// with its original. Unbound, the module-level exports work the same way
// against the local copies (gh's own resolution, no fork override).
//
// Structured data comes from `gh --json` and GraphQL. Verified shapes:
// - `gh pr view <n> --json` accepts number,title,state,isDraft,author,assignees,
//   labels,createdAt,updatedAt,comments,reactionGroups,url,body,baseRefName,
//   headRefName,headRepositoryOwner,additions,deletions,changedFiles,commits,
//   reviewDecision,reviewRequests,latestReviews,statusCheckRollup,mergeable,
//   mergeStateStatus,closingIssuesReferences.
// - `gh pr comment <n> --body …`, `gh pr close <n>`,
//   `gh pr merge <n> --merge|--squash|--rebase [--subject …] [--body …]` (a
//   rebase merge takes neither proposal) and `gh pr edit <n> --add-label …
//   --remove-label … | --add-assignee … --remove-assignee … | --body …`.
// - The three scoped buckets are `search(type: ISSUE)` over
//   `repo:<r> is:pr is:open <qualifier>`; the lazy `all` bucket is the
//   `repository.pullRequests(states: OPEN)` connection, which reports an exact
//   `totalCount` and pages past the search API's 1000-match cap.
// - `repository.viewerPermission`, `mergeCommitAllowed`, `squashMergeAllowed`
//   and `rebaseMergeAllowed` are the repo-level facts the capabilities and the
//   merge methods are derived from.
// - `gh label list/create` and `repository.assignableUsers` are
//   repository-level, not issue-level, so their local copies here are
//   unchanged.

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PAGE_SIZE = 30;
// The largest page a single GraphQL request may ask for; a larger caller budget
// is filled by walking several server pages.
const MAX_PAGE_SIZE = 100;
// The search API answers at most 1000 matches. A bucket past that cap is a
// FAILED read, never a silently truncated list.
const SEARCH_MATCH_CAP = 1000;
// Search-syntax qualifier: this client asks `gh` for last-update ordering so
// every consumer inherits it, and a caller's own `sort:` is never doubled.
const LAST_UPDATED_SORT = 'sort:updated-desc';
// The rail's per-bucket row window and the linked-issue window each row carries.
const RAIL_WINDOW_DEFAULT = 50;
const RAIL_WINDOW_MAX = 100;
const LINKED_ISSUE_WINDOW = 100;
const LABEL_FETCH_MAX = 500;
// Runaway guard for a cursor walk that never ends, never a data cutoff.
const SNAPSHOT_MAX_PAGES = 2500;

const MERGE_FLAGS = { merge: '--merge', squash: '--squash', rebase: '--rebase' };
const MERGE_METHODS = ['merge', 'squash', 'rebase'];
const PERMITTED_ROLES = ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'];
const MERGE_ROLES = ['WRITE', 'MAINTAIN', 'ADMIN'];

// The three S1 buckets, as the repository-search qualifier each one asks for.
// `involved` excludes authorship exactly as the issues reader does: GitHub's
// `involves:@me` includes the pull requests you opened, and a bucket named for
// the ones you take part in must not repeat your own list.
const BUCKET_QUALIFIERS = {
  mine: 'author:@me',
  review: 'review-requested:@me',
  involved: 'involves:@me -author:@me',
};

// The row of a list, and the head of the pane: the issue row's keys plus the
// two pull-request ones the panel's list draws.
const ROW_FIELDS = `
  number
  title
  state
  isDraft
  url
  createdAt
  updatedAt
  author { login }
  labels(first: 50) { nodes { name color description } }
  assignees(first: 10) { nodes { login } }
  comments { totalCount }
  reactionGroups { content users { totalCount } }
  reviewDecision`;

const SEARCH_PAGE_QUERY = `query($search: String!, $first: Int!, $cursor: String) {
  search(query: $search, type: ISSUE, first: $first, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node { ... on PullRequest { ${ROW_FIELDS} } } }
  }
}`;

const CONNECTION_PAGE_QUERY = `query($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { cursor node { ${ROW_FIELDS} } }
    }
  }
}`;

const DETAIL_JSON_FIELDS = [
  'number', 'title', 'state', 'isDraft', 'author', 'assignees', 'labels',
  'createdAt', 'updatedAt', 'comments', 'reactionGroups', 'url', 'body',
  'baseRefName', 'headRefName', 'headRepositoryOwner', 'additions', 'deletions',
  'changedFiles', 'commits', 'reviewDecision', 'reviewRequests', 'latestReviews',
  'statusCheckRollup', 'mergeable', 'mergeStateStatus', 'closingIssuesReferences',
].join(',');

const LABEL_JSON_FIELDS = 'name,color,description';

// The repo-level facts ONE read answers: the viewer's role (the capability
// map), the merge methods the repository allows, whether the pull request is a
// draft (merge refuses one) and the linked issues with their truncation flag.
const PULL_REQUEST_METADATA_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    pullRequest(number: $number) {
      isDraft
      state
      closingIssuesReferences(first: ${LINKED_ISSUE_WINDOW}) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }
    }
  }
}`;

// S2/D2: the repository role every write reads for itself before it runs, so a
// capability that lapsed after the pane painted never reaches `gh`. It is the
// cheapest answer to "may this viewer write here?": no pull request is named.
const REPOSITORY_PERMISSION_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { viewerPermission }
}`;

// S2/D20: the role AND the fresh state of the pull request the write will name,
// in the same round trip, so a merged, closed or vanished pull request is
// refused by the one read that authorizes the write.
const REPOSITORY_WRITE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) { state }
  }
}`;

// The permission read `editAssignees` needs, plus the authenticated login: the
// SAME request names the viewer, so a toggle for the viewer's own account is
// reported by the client instead of guessed from a display name.
const ASSIGNEE_ACCESS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) { state }
  }
  viewer { login }
}`;

const ASSIGNABLE_USERS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 100, after: $cursor) {
      nodes { login name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const RAIL_ALIAS_QUALIFIERS = [
  ['mine', BUCKET_QUALIFIERS.mine],
  ['review', BUCKET_QUALIFIERS.review],
];

// ---------------------------------------------------------------------------
// Runner seam and the child-process helpers (local copies of lib/gh-issues.js).
// ---------------------------------------------------------------------------

let runnerOverride = null;
let boundIssues = null;
let boundClient = null;

// Test seam: inject `fn(bin, argv, runOpts)` (may be sync or async), or
// `null`/`undefined` to restore the default `execFile` runner. It moves the
// injected issue module's own seam too, so the seams this client delegates to
// it (the identity reads, the scope resolver) run the injected runner as well.
function setGhRunner(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== 'function') {
    throw new TypeError('setGhRunner requires a function or null');
  }
  runnerOverride = fn === null || fn === undefined ? null : fn;
  forwardRunner(boundIssues);
}

function forwardRunner(issues) {
  if (issues && typeof issues === 'object' && typeof issues.setGhRunner === 'function') {
    issues.setGhRunner(runnerOverride);
  }
}

function ghBinary(opts = {}) {
  if (typeof opts.ghBin === 'string' && opts.ghBin.length > 0) return opts.ghBin;
  const env = opts.env || process.env;
  const fromEnv = env && env.GH_BIN_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return 'gh';
}

// Default runner over execFile: argv array, no shell, bounded timeout.
// Always resolves to {status, stdout, stderr, error}; never throws.
function defaultRunner(bin, argv, runOpts = {}) {
  const timeout = Number.isFinite(runOpts.timeoutMs) && runOpts.timeoutMs > 0
    ? Math.floor(runOpts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const spawnOpts = {
      cwd: runOpts.cwd,
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    };
    if (runOpts.env) spawnOpts.env = runOpts.env;
    try {
      execFile(bin, argv, spawnOpts, (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: null });
          return;
        }
        if (err.code === 'ENOENT' || /ENOENT/i.test(err.message || '')) {
          resolve({
            status: null,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: `spawn ${bin} ENOENT: gh CLI is not available`,
          });
          return;
        }
        if (err.killed) {
          resolve({
            status: null,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: `gh timed out after ${timeout}ms`,
          });
          return;
        }
        resolve({
          status: typeof err.code === 'number' ? err.code : null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: null,
        });
      });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
    }
  });
}

// The env a gh child runs with: the caller's own environment plus the scope as
// GH_REPO. A scope ALWAYS wins over an ambient GH_REPO, so an environment
// variable can never move a read or a write to another repository behind a
// displayed identity's back.
function scopedEnv(opts, scope) {
  if (!scope) return opts.env;
  const base = opts.env || process.env || {};
  return { ...base, GH_REPO: scope };
}

// S2/D23, D28: the API host a call can PROVE it targets. `gh api`/GraphQL take
// their host from GH_HOST or `--hostname`, NEVER from GH_REPO's host, so every
// `api` child has to carry it explicitly — github.com included, because gh's own
// default may itself be an Enterprise server. A host is proven by an explicit
// pin, by GH_HOST or by the host half of GH_REPO; an ambient repository proves
// nothing here (its host comes from the repository lookup, which is exactly the
// child that must keep the caller's environment verbatim).
function provenHost(opts = {}) {
  const scope = typeof opts.scope === 'string' ? opts.scope.trim() : '';
  if (scope !== '') {
    const parts = scope.split('/');
    return parts.length === 3 ? canonicalHost(parts[0]) : '';
  }
  const env = opts.env || process.env || {};
  const selected = ghHostOf(env);
  if (selected !== '') return canonicalHost(selected);
  const repo = typeof env.GH_REPO === 'string' ? env.GH_REPO.trim() : '';
  const parts = repo.split('/');
  return parts.length === 3 ? canonicalHost(parts[0]) : '';
}

// The host a host-qualified identity names (`<host>/<owner>/<repo>`).
function hostOfIdentity(identity) {
  if (typeof identity !== 'string') return '';
  const parts = identity.split('/');
  return parts.length === 3 ? canonicalHost(parts[0]) : '';
}

// The host a `gh repo view` URL names, or '' when the answer carries none.
function hostOfUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  try {
    return canonicalHost(new URL(raw).host);
  } catch {
    return '';
  }
}

// The options one host-qualified scope needs for the ONE resolution that
// validates it: `normalizeScopeIdentity` refuses an enterprise pin unless
// GH_HOST names the same server.
function withHostOptions(opts, host) {
  if (host === '' || host === 'github.com') return opts;
  const base = opts.env || process.env || {};
  return { ...opts, env: { ...base, GH_HOST: host } };
}

// One child, with the host `gh` cannot read from GH_REPO: an `api` child gets
// `--hostname <host>` (after its own flags, so the `-f query=…` slot is
// unchanged) and every child of that scope gets GH_HOST. S2/D28: the host is
// named even when it IS github.com, so a public scope can never drift to an
// Enterprise default and an Enterprise one never drifts to api.github.com.
function withHost(argv, opts = {}, host) {
  if (typeof host !== 'string' || host === '') return { argv, opts };
  const base = opts.env || process.env || {};
  return {
    argv: Array.isArray(argv) && argv[0] === 'api' ? [...argv, '--hostname', host] : argv,
    opts: { ...opts, env: { ...base, GH_HOST: host } },
  };
}

// The same, for a runner this client does not resolve the scope of (the injected
// issue client's own `runGh`): the host has to be proven by the call's own pin or
// environment. A caller environment that selects ANOTHER server is left exactly
// as given, so the identity resolution still refuses it before any child runs.
function withScopeHost(argv, opts = {}) {
  const host = provenHost(opts);
  if (host === '') return { argv, opts };
  const selected = ghHostOf(opts.env || process.env || {});
  return withHost(argv, opts, selected !== '' && selected !== host ? '' : host);
}

// The child runner, parameterized by the scope resolver: the fallback used when
// the injected issue module does not export `runGh`. Same shape, same
// fail-closed scope handling.
async function runGhWith(scopeResolve, argv, opts = {}) {
  const bin = ghBinary(opts);
  const scopeResult = await scopeResolve(opts);
  // Fail closed: when the identity cannot be proven, no gh command runs at all.
  if (scopeResult.ok !== true) {
    return { bin, argv, status: null, stdout: '', stderr: '', error: scopeResult.error };
  }
  // S2/D28: the host is named AFTER the identity is resolved, so a checkout or
  // ambient repository on any server hands its own host to every child, and the
  // validation above still saw the caller's environment unchanged.
  const identity = scopeResult.identity || null;
  const hosted = withHost(argv, opts, identity === null ? provenHost(opts) : hostOfIdentity(identity));
  const env = scopedEnv(hosted.opts, identity);
  const runOpts = { cwd: opts.cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS };
  if (env) runOpts.env = env;
  const run = runnerOverride || defaultRunner;
  let raw;
  try {
    raw = await run(bin, hosted.argv, runOpts);
  } catch (err) {
    return {
      bin, argv: hosted.argv, status: null, stdout: '', stderr: '',
      error: (err && err.message) || String(err),
    };
  }
  const outcome = raw && typeof raw === 'object' ? raw : {};
  return {
    bin,
    argv: hosted.argv,
    status: typeof outcome.status === 'number' ? outcome.status : null,
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
    stderr: typeof outcome.stderr === 'string' ? outcome.stderr : '',
    error: outcome.error === null || outcome.error === undefined ? null : String(outcome.error),
  };
}

// ---------------------------------------------------------------------------
// Identity (local copy of lib/gh-issues.js: invariant 6's pin rules).
// ---------------------------------------------------------------------------

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function ghHostOf(env) {
  const raw = env && typeof env.GH_HOST === 'string' ? env.GH_HOST.trim().toLowerCase() : '';
  return raw.replace(/\/+$/, '');
}

function canonicalHost(raw) {
  const host = String(raw || '').trim().toLowerCase().replace(/\/+$/, '');
  return host === 'www.github.com' ? 'github.com' : host;
}

// The server a pin may target. github.com is gh's default. Any other server is
// only reachable CONSISTENTLY when GH_HOST names it: repository-scoped commands
// take a host from GH_REPO, but `gh api`/GraphQL (every search and connection
// read) use the default host. With GH_HOST set, the pin must name that EXACT
// server; a different host is the same `owner/name` somewhere else.
function hostVerdict(authority, env) {
  const required = ghHostOf(env);
  if (required !== '') {
    if (authority === required) return { ok: true };
    return { ok: false, error: `is on ${authority}, but GH_HOST selects ${required}` };
  }
  if (GITHUB_HOSTS.has(authority)) return { ok: true };
  if (authority.endsWith('.ghe.com') || authority.startsWith('github.') || authority.includes('.github.')) {
    return { ok: false, error: `is on ${authority}, which gh reaches only when GH_HOST selects it` };
  }
  return { ok: false, error: `is on ${authority}, which is not a GitHub host` };
}

// A caller-supplied identity (`GH_REPO`, or the identity a caller already
// displayed) normalized to the HOST-QUALIFIED `<host>/<owner>/<repo>` form. A
// bare `owner/name` is qualified with the host gh would use (GH_HOST, else
// github.com). A value that names one server while GH_HOST selects another, or
// a host that is not provably GitHub, fails closed: a pin is never redirected.
function normalizeScopeIdentity(value, env = process.env) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text === '') return { ok: false, error: 'no repository identity was given' };
  const segments = text.split('/');
  let host;
  let owner;
  let name;
  if (segments.length === 2) {
    host = ghHostOf(env) || 'github.com';
    owner = segments[0];
    name = segments[1];
  } else if (segments.length === 3) {
    host = canonicalHost(segments[0]);
    owner = segments[1];
    name = segments[2];
  } else {
    return { ok: false, error: `repository identity "${text}" is not in [HOST/]OWNER/REPO form` };
  }
  const verdict = hostVerdict(host, env);
  if (verdict.ok !== true) return { ok: false, error: verdict.error, host };
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(name)
    || name === '.' || name === '..' || owner === '.' || owner === '..') {
    return { ok: false, error: 'names an invalid GitHub repository', host };
  }
  const nameWithOwner = `${owner}/${name}`;
  return { ok: true, host, nameWithOwner, identity: `${host}/${nameWithOwner}` };
}

function namesCheckout(opts) {
  return typeof opts.cwd === 'string' && opts.cwd.length > 0;
}

// ---------------------------------------------------------------------------
// Parsing and normalizing helpers (local copies of lib/gh-issues.js).
// ---------------------------------------------------------------------------

function exitError(outcome, what) {
  const stderr = (outcome.stderr || '').trim();
  if (stderr) return `${what}: ${stderr.split('\n')[0].slice(0, 500)}`;
  if (outcome.status !== null) return `${what}: gh exited with status ${outcome.status}`;
  return `${what}: gh failed`;
}

function parseJsonBody(stdout, what) {
  const text = (stdout || '').trim();
  if (!text) return { ok: false, error: `${what}: gh returned an empty body` };
  try {
    return { ok: true, doc: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${what}: gh returned unparseable output` };
  }
}

function asLogin(author) {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && typeof author.login === 'string') return author.login;
  return '';
}

function asLabel(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  return {
    name: typeof entry.name === 'string' ? entry.name : '',
    color: typeof entry.color === 'string' ? entry.color : '',
    description: typeof entry.description === 'string' ? entry.description : '',
  };
}

function sumReactions(reactionGroups) {
  let total = 0;
  let plusOne = 0;
  if (!Array.isArray(reactionGroups)) return { total: 0, plusOne: 0 };
  for (const group of reactionGroups) {
    if (!group || typeof group !== 'object') continue;
    const count = group.users && typeof group.users.totalCount === 'number'
      ? group.users.totalCount
      : (group.reactors && typeof group.reactors.totalCount === 'number'
        ? group.reactors.totalCount
        : (typeof group.totalCount === 'number' ? group.totalCount : 0));
    total += count;
    if (group.content === 'THUMBS_UP') plusOne += count;
  }
  return { total, plusOne };
}

function normalizeComment(raw, fallbackId) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = typeof entry.id === 'string' || typeof entry.id === 'number'
    ? entry.id
    : (typeof entry.databaseId === 'number' ? entry.databaseId : fallbackId);
  return {
    id,
    author: asLogin(entry.author),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    body: typeof entry.body === 'string' ? entry.body : '',
    reactions: sumReactions(entry.reactionGroups || entry.reactions),
  };
}

// Authentication, permission and transport wording always wins over a not-found
// pattern, because a private repository answers 404 for a pull request the
// reader merely cannot see.
const NOT_FOUND_PATTERN = /could not resolve to an? (?:issue|pull request)|no (?:such|matching) pull request/i;
const UNVERIFIABLE_PATTERN = /401|403|bad credentials|authenticat|permission|forbidden|saml|enoent|timed out|timeout|dial tcp|no such host|connection refused|network/i;

function pullRequestViewFailure(res, number) {
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  const notFound = typeof res.status === 'number' && res.status !== 0
    && !UNVERIFIABLE_PATTERN.test(text)
    && NOT_FOUND_PATTERN.test(text);
  return {
    ok: false,
    error: exitError(res, `cannot view pull request #${number}`),
    status: res.status,
    notFound,
  };
}

function countOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

// A GraphQL row carries labels and assignees as connections and comments as a
// count; reshape them into the payload `normalizePullRequestRow` reads.
function graphqlRow(node) {
  const entry = node && typeof node === 'object' ? node : {};
  const labelNodes = entry.labels && typeof entry.labels === 'object' && Array.isArray(entry.labels.nodes)
    ? entry.labels.nodes
    : [];
  const assigneeNodes = entry.assignees && typeof entry.assignees === 'object'
    && Array.isArray(entry.assignees.nodes)
    ? entry.assignees.nodes
    : null;
  const commentsTotal = entry.comments && typeof entry.comments === 'object'
    && Number.isInteger(entry.comments.totalCount)
    ? entry.comments.totalCount
    : 0;
  return {
    ...entry,
    labels: labelNodes,
    ...(assigneeNodes === null ? {} : { assignees: assigneeNodes }),
    comments: [],
    commentsTotal,
  };
}

function normalizePullRequestRow(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const comments = Array.isArray(entry.comments) ? entry.comments : [];
  return {
    number: Number.isInteger(entry.number) ? entry.number : -1,
    title: typeof entry.title === 'string' ? entry.title : '',
    state: typeof entry.state === 'string' ? entry.state.toLowerCase() : '',
    // The issue row carries a state reason; a pull request has none, so the
    // honest default keeps the shape without inventing one.
    stateReason: '',
    author: asLogin(entry.author),
    assignees: Array.isArray(entry.assignees)
      ? entry.assignees.map(asLogin).filter((login) => login !== '')
      : [],
    // `gh pr view --json` (like `gh issue view`) has no authorAssociation
    // field; the honest default is ''.
    authorAssociation: typeof entry.authorAssociation === 'string' ? entry.authorAssociation : '',
    labels: Array.isArray(entry.labels) ? entry.labels.map(asLabel) : [],
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    commentsCount: Number.isInteger(entry.commentsTotal) && entry.commentsTotal >= 0
      ? entry.commentsTotal
      : comments.length,
    reactions: sumReactions(entry.reactionGroups || entry.reactions),
    url: typeof entry.url === 'string' ? entry.url : '',
    body: '',
    isPullRequest: true,
    isDraft: entry.isDraft === true,
    reviewDecision: typeof entry.reviewDecision === 'string' ? entry.reviewDecision : '',
  };
}

// The reviews a pull request carries, as `[{login, state}]`. An outstanding
// review request is `REQUESTED`; a submitted review keeps the state GitHub
// reports for it. A team request carries no login, so it is not a reviewer this
// pane can name.
const REVIEW_STATES = ['REQUESTED', 'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

function normalizeReviewers(reviewRequests, latestReviews) {
  const states = new Map();
  const order = [];
  const remember = (login, state) => {
    if (login === '') return;
    if (!states.has(login)) order.push(login);
    states.set(login, state);
  };
  if (Array.isArray(reviewRequests)) {
    for (const request of reviewRequests) {
      const reviewer = request && typeof request === 'object' ? request.requestedReviewer : null;
      remember(asLogin(reviewer), 'REQUESTED');
    }
  }
  if (Array.isArray(latestReviews)) {
    for (const review of latestReviews) {
      if (!review || typeof review !== 'object') continue;
      const state = REVIEW_STATES.includes(review.state) && review.state !== 'REQUESTED'
        ? review.state
        : 'COMMENTED';
      remember(asLogin(review.author), state);
    }
  }
  return order.map((login) => ({ login, state: states.get(login) }));
}

function latestCommitDate(commits) {
  let newest = '';
  for (const commit of commits) {
    const at = commit && typeof commit === 'object' && typeof commit.committedDate === 'string'
      ? commit.committedDate
      : '';
    if (at !== '' && at > newest) newest = at;
  }
  return newest;
}

// The checks summary S3 draws: how many ran, how many passed, whether one
// failed and which ones. A context GitHub reports in an unfamiliar shape is
// never claimed as a success: an unknown conclusion counts as a failure, and a
// run that has not completed is pending.
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_STATES = new Set(['FAILURE', 'ERROR']);

function normalizeChecks(rollup) {
  const contexts = Array.isArray(rollup) ? rollup : [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failing = [];
  for (const context of contexts) {
    if (!context || typeof context !== 'object') continue;
    if (context.__typename === 'StatusContext') {
      const name = typeof context.context === 'string' ? context.context : '';
      const state = typeof context.state === 'string' ? context.state.toUpperCase() : '';
      if (FAILED_STATES.has(state)) {
        failed += 1;
        if (name) failing.push(name);
      } else if (state === 'SUCCESS') {
        passed += 1;
      } else {
        pending += 1;
      }
      continue;
    }
    const name = typeof context.name === 'string' ? context.name : '';
    const status = typeof context.status === 'string' ? context.status.toUpperCase() : '';
    if (status !== '' && status !== 'COMPLETED') {
      pending += 1;
      continue;
    }
    const conclusion = typeof context.conclusion === 'string' ? context.conclusion.toUpperCase() : '';
    if (conclusion === '') {
      pending += 1;
    } else if (PASSED_CONCLUSIONS.has(conclusion)) {
      passed += 1;
    } else {
      failed += 1;
      if (name) failing.push(name);
    }
  }
  const total = passed + failed + pending;
  const state = total === 0
    ? 'NONE'
    : (failed > 0 ? 'FAILURE' : (pending > 0 ? 'PENDING' : 'SUCCESS'));
  return { total, passed, failed, pending, state, failing };
}

// The numbers a `closingIssuesReferences` list names, deduplicated and sorted.
// `readable:false` means the relation could not be read at all, which the pane
// reports instead of claiming the pull request closes nothing.
function linkedIssueNumbers(raw) {
  if (!Array.isArray(raw)) return { readable: false, numbers: [] };
  const numbers = [];
  for (const node of raw) {
    const number = node && typeof node === 'object' ? node.number : undefined;
    if (!Number.isInteger(number) || number <= 0) return { readable: false, numbers: [] };
    if (!numbers.includes(number)) numbers.push(number);
  }
  return { readable: true, numbers: numbers.sort((a, b) => a - b) };
}

// S2/D29 (S6): a linked reference is identified by REPOSITORY and number. The
// Development relation only ever points at issues of the same repository
// (GitHub enforces it), so a node that names another repository is not this
// panel's target: it is dropped rather than shown as a number that would open a
// same-numbered issue here. A node that names no repository (a partial answer)
// is kept, because the read itself is repository-scoped.
function sameRepositoryReferences(raw, fullName) {
  if (!Array.isArray(raw)) return raw;
  const wanted = typeof fullName === 'string' ? fullName.toLowerCase() : '';
  if (wanted === '') return raw;
  return raw.filter((node) => {
    const named = node && typeof node === 'object' && node.repository && typeof node.repository.nameWithOwner === 'string'
      ? node.repository.nameWithOwner.toLowerCase()
      : '';
    return named === '' || named === wanted;
  });
}

function normalizePullRequestDetail(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const row = normalizePullRequestRow(entry);
  const commits = Array.isArray(entry.commits) ? entry.commits : [];
  const linked = linkedIssueNumbers(entry.closingIssuesReferences);
  return {
    ...row,
    body: typeof entry.body === 'string' ? entry.body : '',
    baseRefName: typeof entry.baseRefName === 'string' ? entry.baseRefName : '',
    headRefName: typeof entry.headRefName === 'string' ? entry.headRefName : '',
    headRepositoryOwner: asLogin(entry.headRepositoryOwner),
    additions: countOrZero(entry.additions),
    deletions: countOrZero(entry.deletions),
    changedFiles: countOrZero(entry.changedFiles),
    commits: commits.length,
    committedAt: latestCommitDate(commits),
    reviewers: normalizeReviewers(entry.reviewRequests, entry.latestReviews),
    linkedIssues: linked.numbers,
    linkedIssuesTruncated: false,
    checks: normalizeChecks(entry.statusCheckRollup),
    mergeable: typeof entry.mergeable === 'string' ? entry.mergeable : '',
    mergeStateStatus: typeof entry.mergeStateStatus === 'string' ? entry.mergeStateStatus : '',
    mergeMethods: {},
    mergeDefaults: {},
    permissions: pullRequestPermissions(null),
    viewerPermission: null,
    unavailable: [],
    metadataError: null,
  };
}

// ---------------------------------------------------------------------------
// Capabilities (invariant 7 + S2).
// ---------------------------------------------------------------------------

// The merge methods a `mergeMethods` object confirms, in GitHub's own order.
function allowedMergeMethods(mergeMethods) {
  if (!mergeMethods || typeof mergeMethods !== 'object') return [];
  return MERGE_METHODS.filter((method) => mergeMethods[method] === true);
}

// `repository.viewerPermission` → the six capabilities the panel gates on.
// Only a literal permitted role confirms anything: a missing field, an unknown
// string or a truthy non-string all read as "not permitted". Labels and
// assignees are triage-level, exactly like the issue client's; creating a
// repository label is write-level, and closing, merging and rewriting the body
// of a pull request need WRITE, which is the fail-closed reading of GitHub's
// own rule (a triage-only viewer cannot close somebody else's pull request).
// Merge ALSO needs the pull request facts: a draft is never mergeable, and a
// repository that allows no method offers none.
function pullRequestPermissions(permission, pullRequest = {}) {
  const role = typeof permission === 'string' && PERMITTED_ROLES.includes(permission);
  const mergeWrites = typeof permission === 'string' && MERGE_ROLES.includes(permission);
  const facts = pullRequest && typeof pullRequest === 'object' ? pullRequest : {};
  const methods = allowedMergeMethods(facts.mergeMethods);
  return {
    canEditLabels: role,
    canCreateLabels: labelCreationAllowed(permission),
    canEditAssignees: role,
    canClosePullRequests: mergeWrites,
    canMerge: mergeWrites && facts.isDraft !== true && methods.length > 0,
    canEditLinkedIssues: mergeWrites,
  };
}

// Creating a repository label is write-level, exactly like the issue client's
// `canCreateLabels`: a triage-only viewer may apply an existing label but may
// not add one to the repository.
function labelCreationAllowed(permission) {
  return typeof permission === 'string' && MERGE_ROLES.includes(permission);
}

// GitHub's own merge proposals, for exactly the methods the repository allows.
// The merge proposal is GitHub's default text (`Merge pull request #N from
// owner/branch`, with the pull request's title as the description), the squash
// one is the title alone, and a rebase merge takes neither.
function mergeDefaultsFor(pullRequest, mergeMethods) {
  const defaults = {};
  const head = [pullRequest.headRepositoryOwner, pullRequest.headRefName]
    .filter((part) => typeof part === 'string' && part !== '')
    .join('/');
  for (const method of allowedMergeMethods(mergeMethods)) {
    if (method === 'merge') {
      defaults.merge = {
        subject: head === ''
          ? `Merge pull request #${pullRequest.number}`
          : `Merge pull request #${pullRequest.number} from ${head}`,
        body: pullRequest.title,
      };
    } else if (method === 'squash') {
      defaults.squash = { subject: pullRequest.title, body: '' };
    } else {
      defaults.rebase = {};
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Call parameters and paging.
// ---------------------------------------------------------------------------

const CALL_OPTION_KEYS = ['scope', 'env', 'cwd', 'ghBin', 'timeoutMs', 'freshScope'];

function splitParams(params, opts) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const options = { ...o };
  for (const key of CALL_OPTION_KEYS) {
    if (options[key] === undefined && p[key] !== undefined) options[key] = p[key];
  }
  return { params: p, options };
}

const PAGE_ERROR = 'invalid pull request page: pageSize must be 1..1000 and cursor must be a non-empty string or null';

function normalizePageRequest(params) {
  const pageSize = params.pageSize === undefined || params.pageSize === null
    ? DEFAULT_PAGE_SIZE
    : params.pageSize;
  const cursor = params.cursor === undefined ? null : params.cursor;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    return { ok: false, error: PAGE_ERROR };
  }
  if (cursor !== null && (typeof cursor !== 'string' || cursor === '')) {
    return { ok: false, error: PAGE_ERROR };
  }
  return { ok: true, pageSize, cursor };
}

function withLastUpdatedSort(search) {
  if (/\bsort:/i.test(search)) return search;
  return search ? `${search} ${LAST_UPDATED_SORT}` : LAST_UPDATED_SORT;
}

// One cursor walk over a page source. Every page is validated before it is
// trusted: GraphQL errors fail the call, a cursor or pull request repeated
// inside one call is an error (a silent drop would make the totals lie), and a
// non-advancing or cursorless `hasNextPage` fails instead of looping. A short
// server page is a VALID page whose cursor belongs to the caller; filling it by
// issuing another request would skip that boundary.
async function readPages({ cursor, pageSize, isSearch, runPage, connectionOf }) {
  const rows = [];
  const seen = new Set();
  const rowCursors = new Set(cursor === null ? [] : [cursor]);
  const cursors = new Set(cursor === null ? [] : [cursor]);
  let after = cursor;
  let totalCount = 0;
  let hasMore = false;
  let nextCursor = null;
  while (rows.length < pageSize) {
    const first = Math.min(MAX_PAGE_SIZE, pageSize - rows.length);
    const res = await runPage(first, after);
    if (res.ok !== true) return res;
    const connection = connectionOf(res.data);
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)
      || !Array.isArray(connection.edges) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid pull request page' };
    }
    const total = isSearch === true ? connection.issueCount : connection.totalCount;
    if (!Number.isInteger(total) || total < 0) {
      return { ok: false, error: 'GitHub returned an invalid pull request page' };
    }
    if (isSearch === true && total > SEARCH_MATCH_CAP) {
      return {
        ok: false,
        error: 'GitHub pull request search exceeds 1000 matches; narrow the filter',
        truncated: true,
      };
    }
    totalCount = total;
    if (connection.edges.length > first) {
      return { ok: false, error: 'GitHub exceeded the requested pull request page size' };
    }
    for (const edge of connection.edges) {
      if (typeof edge?.cursor !== 'string' || !edge.cursor || !Number.isInteger(edge?.node?.number)
        || edge.node.number < 1 || seen.has(edge.node.number) || rowCursors.has(edge.cursor)) {
        return { ok: false, error: 'GitHub returned an invalid pull request cursor or duplicate pull request' };
      }
      seen.add(edge.node.number);
      rowCursors.add(edge.cursor);
      rows.push({ ...normalizePullRequestRow(graphqlRow(edge.node)), cursor: edge.cursor });
    }
    hasMore = connection.pageInfo.hasNextPage;
    if (!hasMore) {
      nextCursor = null;
      break;
    }
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next) || connection.edges.length === 0) {
      return { ok: false, error: 'GitHub pull request pagination did not advance' };
    }
    cursors.add(next);
    nextCursor = next;
    if (connection.edges.length < first) break;
    after = next;
  }
  return { ok: true, rows, hasMore, cursor: hasMore ? nextCursor : null, totalCount };
}

// The rail's ONE aliased query: both buckets in the same `repo:` scope, each
// with its exact `issueCount`, sorted by last update.
function railQuery(fullName, first) {
  const aliases = RAIL_ALIAS_QUALIFIERS.map(([alias, qualifier]) => {
    const search = `repo:${fullName} is:pr is:open ${qualifier} ${LAST_UPDATED_SORT}`;
    return `  ${alias}: search(query: ${JSON.stringify(search)}, type: ISSUE, first: ${first}) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        closingIssuesReferences(first: ${LINKED_ISSUE_WINDOW}) { nodes { number } pageInfo { hasNextPage } }
      }
    }
  }`;
  });
  return `query {\n${aliases.join('\n')}\n}`;
}

// Fold the metadata read into the detail payload. A failed read leaves every
// capability false and names what is missing, so nothing is offered that was
// never confirmed.
function applyMetadata(pullRequest, metadata, linkedFallbackReadable) {
  if (metadata.ok !== true) {
    pullRequest.metadataError = metadata.error;
    pullRequest.unavailable = ['permissions', 'merge methods'];
    if (linkedFallbackReadable !== true) pullRequest.unavailable.push('linked issues');
    return;
  }
  const methods = metadata.mergeMethods;
  pullRequest.mergeMethods = methods;
  pullRequest.mergeDefaults = mergeDefaultsFor(pullRequest, methods);
  pullRequest.viewerPermission = metadata.permission;
  // S2/D31: the GraphQL metadata is the newest state read, so a MERGED or CLOSED
  // answer wins over a `pr view` that still says open (GitHub's final state is
  // never the optimistic one).
  const metadataState = typeof metadata.state === 'string' ? metadata.state.toLowerCase() : '';
  if (metadataState === 'merged' || metadataState === 'closed') pullRequest.state = metadataState;
  pullRequest.permissions = pullRequestPermissions(metadata.permission, {
    isDraft: pullRequest.isDraft === true || metadata.isDraft === true,
    mergeMethods: methods,
  });
  if (metadata.linkedIssues !== null) {
    pullRequest.linkedIssues = metadata.linkedIssues;
    pullRequest.linkedIssuesTruncated = metadata.linkedIssuesTruncated === true;
  } else if (linkedFallbackReadable !== true) {
    pullRequest.unavailable.push('linked issues');
  }
}

// ---------------------------------------------------------------------------
// S2 (D27): the Development relation. GitHub exposes no mutation for it, so a
// linked issue is a `Closes #N` line in the pull request body. These helpers no
// longer INTERPRET Markdown: every line this panel writes carries a marker
// comment, only a marked line is ever removed, a body whose structure cannot be
// read safely is refused instead of guessed at, and every other byte of the
// body is preserved.
// ---------------------------------------------------------------------------

// The one marker this panel writes. It is what makes a line the panel's OWN: an
// ordinary `Closes #N` a human wrote is never rewritten. The pattern below
// accepts any of GitHub's closing keywords, case-insensitively, at COLUMN 0. An
// indented one is a container's content or an indented code block, never a
// declaration this panel may read.
const LINK_MARKER = '<!-- odd-worktree:linked -->';
const LINK_MARKER_PATTERN = LINK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CLOSING_KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const MARKED_LINE_PATTERN = new RegExp(
  `^${CLOSING_KEYWORD}[ \\t]+#(\\d+)[ \\t]*${LINK_MARKER_PATTERN}[ \\t]*$`, 'i',
);
const CLOSING_LINE_PATTERN = new RegExp(`^${CLOSING_KEYWORD}[ \\t]+#(\\d+)[ \\t]*$`, 'i');
// The one line shape this panel ITSELF writes, byte for byte: one keyword, one
// space, one number, one space, this marker and nothing else. Only a line that
// matches it exactly is ever deleted, so a human's variant that merely LOOKS
// like ours (another keyword, another spacing, a trailing space) is refused
// instead of rewritten.
const OWN_LINE_PATTERN = new RegExp(`^Closes #([1-9]\\d*) ${LINK_MARKER_PATTERN}$`);

// The refusals a body edit can carry, plus the concurrent-edit one.
const BODY_UNREADABLE = 'the pull request body ends inside an unclosed code fence or comment';
const LINK_NOT_OURS = 'that link was not added by this panel; remove it on GitHub';
const BODY_MARKUP_LINK = 'that link sits inside a code fence or comment in the body; remove it on GitHub';
const BODY_CHANGED = 'the pull request body changed while it was being edited';

// Split on '\n' while KEEPING each line's own ending, so re-joining the parts
// reproduces the body byte for byte (CRLF included).
function splitBodyLines(body) {
  const parts = [];
  let start = 0;
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] !== '\n') continue;
    const hasCr = at > start && body[at - 1] === '\r';
    const textEnd = hasCr ? at - 1 : at;
    parts.push({ text: body.slice(start, textEnd), eol: body.slice(textEnd, at + 1) });
    start = at + 1;
  }
  if (start < body.length) parts.push({ text: body.slice(start), eol: '' });
  return parts;
}

// The number ONE line declares at column 0, marked or not, or null. READing a
// declaration is not OWNing it: only the exact line above is ever deleted.
function declarationOf(text) {
  for (const pattern of [MARKED_LINE_PATTERN, CLOSING_LINE_PATTERN]) {
    const declared = pattern.exec(text);
    if (declared) return Number(declared[1]);
  }
  return null;
}

// The number of a line that is EXACTLY this panel's own marked declaration, or
// null. The `\r` of a CRLF ending is the single tolerated extra (splitBodyLines
// already strips it from a CRLF line, so this only covers a bare final `\r`).
function ownMarkedNumber(text) {
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  const own = OWN_LINE_PATTERN.exec(line);
  return own === null ? null : Number(own[1]);
}

// The line this panel adds for one issue.
function markerLine(number) {
  return `Closes #${number} ${LINK_MARKER}`;
}

// S2/D27: the structure facts a body edit has to respect, read so that the
// answer is safe by construction and NEVER rewritten by this scan.
//
// A fence run is any run of three or more backticks or tildes that starts a
// line (indentation is spaces only). The first run opens a fence; only a run of
// the SAME character, at least as long, with nothing but whitespace after it,
// closes it — so a four-backtick fence holding a three-backtick run and an
// example stays one code block. A run that lives inside a line of prose is not
// a delimiter at all. An opening run still open at the end of the body, an
// `<!--`/`-->` count that does not pair up, and a body whose comment scan ends
// inside a comment all mean the last line may be code or commented out: each
// refuses the whole edit, add and remove alike.
//
// Every line strictly INSIDE a paired fence or an HTML comment is MARKUP: a link
// this panel wrote there is an example of the panel's own line, never a
// declaration it may delete.
function bodyStructure(parts, text) {
  const markup = new Set();
  let open = null;
  parts.forEach((part, index) => {
    const indent = /^ */.exec(part.text)[0].length;
    for (const run of part.text.matchAll(/`{3,}|~{3,}/g)) {
      if (run.index !== indent) continue;
      const fence = run[0];
      const after = part.text.slice(run.index + fence.length);
      if (open === null) {
        open = { char: fence[0], length: fence.length, line: index };
        continue;
      }
      if (fence[0] !== open.char || fence.length < open.length) continue;
      if (!/^[ \t]*$/.test(after)) continue;
      for (let line = open.line + 1; line < index; line += 1) markup.add(line);
      open = null;
    }
  });
  const openedComments = text.match(/<!--/g) || [];
  const closedComments = text.match(/-->/g) || [];
  const starts = [];
  let offset = 0;
  for (const part of parts) {
    starts.push(offset);
    offset += part.text.length + part.eol.length;
  }
  let cursor = 0;
  let unterminated = false;
  while (cursor < text.length) {
    const from = text.indexOf('<!--', cursor);
    if (from < 0) break;
    const to = text.indexOf('-->', from + 4);
    if (to < 0) {
      unterminated = true;
      starts.forEach((start, index) => {
        if (start >= from) markup.add(index);
      });
      break;
    }
    starts.forEach((start, index) => {
      if (start >= from && start < to) markup.add(index);
    });
    cursor = to + 3;
  }
  return {
    safe: open === null && openedComments.length === closedComments.length && !unterminated,
    markup,
  };
}

// The body with this panel's own marked lines removed and a marked `Closes #N`
// appended for each newly linked issue. A number the body already declares —
// marked by this panel or written by a human — is never declared twice, so the
// add is a no-op there. A removal deletes only the EXACT line this panel wrote,
// and only where that line is not itself an example: a look-alike or a human's
// declaration is refused (LINK_NOT_OURS), a line inside a code fence or a
// comment is refused too (BODY_MARKUP_LINK), and a body whose fences or
// comments do not pair up refuses both edits without changing a byte.
function rewriteClosingLines(body, add, remove) {
  const parts = splitBodyLines(body);
  const structure = bodyStructure(parts, body);
  if (structure.safe !== true) return { body, appended: 0, refused: BODY_UNREADABLE };
  const eol = (parts.find((part) => part.eol !== '') || { eol: '\n' }).eol;
  // Every number the body declares at column 0 (marked or not), and for each
  // number the lines that are exactly this panel's own line and sit OUTSIDE any
  // code fence or comment (the only lines a removal may delete).
  const declaredNumbers = new Set();
  const own = new Map();
  parts.forEach((part, index) => {
    const declared = declarationOf(part.text);
    if (declared !== null) declaredNumbers.add(declared);
    const number = ownMarkedNumber(part.text);
    if (number === null) return;
    if (structure.markup.has(index)) {
      if (!own.has(number)) own.set(number, { deletable: [] });
      return;
    }
    const entry = own.get(number) || { deletable: [] };
    entry.deletable.push(index);
    own.set(number, entry);
  });
  const removable = new Set();
  for (const number of remove) {
    const entry = own.get(number);
    if (entry !== undefined && entry.deletable.length > 0) {
      for (const index of entry.deletable) removable.add(index);
      continue;
    }
    // The panel's own line is there, but only inside a code fence or a comment:
    // deleting it would edit an example, so the removal is refused.
    if (entry !== undefined) return { body, appended: 0, refused: BODY_MARKUP_LINK };
    // Any other declaration is a human's — or a look-alike that only resembles
    // this panel's line — and is never rewritten.
    if (declaredNumbers.has(number)) return { body, appended: 0, refused: LINK_NOT_OURS };
  }
  const appended = [];
  for (const number of add) {
    if (declaredNumbers.has(number)) continue;
    declaredNumbers.add(number);
    appended.push(number);
  }
  const kept = parts.filter((_, index) => !removable.has(index));
  if (appended.length === 0 && kept.length === parts.length) {
    return { body, appended: 0 };
  }
  const out = kept.map((part) => ({ ...part }));
  if (appended.length > 0) {
    if (out.length === 0) {
      for (const number of appended) out.push({ text: markerLine(number), eol });
    } else {
      const last = out[out.length - 1];
      if (last.eol === '') last.eol = eol;
      // S2/D27: the link block starts on a line of its own.
      if (last.text.trim() !== '') out.push({ text: '', eol });
      for (const number of appended) out.push({ text: markerLine(number), eol });
    }
  }
  return {
    body: out.map((part) => part.text + part.eol).join(''),
    appended: appended.length,
  };
}

function invalidNumber(number) {
  return { ok: false, error: `invalid pull request number ${JSON.stringify(number)}: want a positive integer` };
}

function isValidLogin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
}

// ---------------------------------------------------------------------------
// The client. `issues` is the injected lib/gh-issues.js module; every seam it
// exports is used, and a seam it does not export falls back to the local copy.
// ---------------------------------------------------------------------------

function createPrsClient(options = {}) {
  const supplied = options && typeof options === 'object'
    ? (options.issues && typeof options.issues === 'object' ? options.issues : null)
    : null;
  const seam = (name, fallback) => (supplied && typeof supplied[name] === 'function'
    ? supplied[name]
    : fallback);

  // The child seam. An injected `runGh` owns its own scope handling; otherwise
  // this client's own resolver (pin, fork override, gh's default) does. Either
  // way the scope's API host travels with the child (D23), because `gh api`
  // never reads it from GH_REPO.
  const injectedRunGh = seam('runGh', null);
  const baseRunGh = typeof injectedRunGh === 'function'
    ? (argv, opts) => {
      // An injected runner owns the scope handling; the host its child must
      // target is still this client's to name (D23, D28).
      const hosted = withScopeHost(argv, opts);
      return injectedRunGh(hosted.argv, hosted.opts);
    }
    : (argv, opts) => runGhWith(scopeForCall, argv, opts);
  const runGh = (argv, opts = {}) => baseRunGh(argv, opts);
  const normalizeIdentity = seam('normalizeScopeIdentity', normalizeScopeIdentity);
  const checkoutScope = supplied && typeof supplied.checkoutRepoScope === 'function'
    ? supplied.checkoutRepoScope
    : null;

  // gh's OWN answer for the checkout, with no override applied. S2/D28: the
  // answer carries the repository's own URL, so the HOST gh resolved comes from
  // the repository itself instead of defaulting to github.com.
  const reportedRepoName = seam('reportedRepoName', async (opts) => {
    const repo = await runGh(['repo', 'view', '--json', 'nameWithOwner,url'], opts);
    if (repo.error) return { ok: false, error: repo.error };
    if (repo.status !== 0) {
      return {
        ok: false,
        error: exitError(repo, 'cannot resolve the repository'),
        ...(/no git remotes/i.test(repo.stderr || '') ? { noRemote: true } : {}),
      };
    }
    const parsed = parseJsonBody(repo.stdout, 'gh repo view');
    if (!parsed.ok) return parsed;
    const reported = parsed.doc && typeof parsed.doc.nameWithOwner === 'string'
      ? parsed.doc.nameWithOwner
      : '';
    if (!reported) return { ok: false, error: 'gh repo view returned an unexpected shape' };
    return { ok: true, nameWithOwner: reported, host: hostOfUrl(parsed.doc.url) };
  });

  // The scope a call runs with, as a host-qualified `GH_REPO` value or null. An
  // explicit scope is validated FIRST (a host mismatch or an invalid identity
  // fails closed before any spawn); a call that names a checkout resolves the
  // checkout's own repository through the injected resolver; anything else
  // keeps gh's default resolution.
  async function scopeForCall(opts) {
    if (opts.scope !== undefined) {
      if (opts.scope === null || opts.scope === '') return { ok: true, identity: null };
      const pinned = normalizeIdentity(opts.scope, opts.env || process.env);
      if (pinned.ok !== true) return { ok: false, error: `the pinned repository ${pinned.error}` };
      return { ok: true, identity: pinned.identity };
    }
    if (namesCheckout(opts) && checkoutScope) {
      return checkoutScope({ ...opts, fresh: opts.freshScope === true });
    }
    return { ok: true, identity: null };
  }

  // The repository in scope, in `owner/name`: a caller's explicit pin wins and
  // is validated before anything runs; otherwise gh's own answer is overridden
  // by the checkout's own repository (fork scope), which the injected resolver
  // proves. An unresolvable checkout fails closed instead of being replaced by
  // gh's base answer.
  async function repoNameWithOwner(opts = {}) {
    if (opts.scope !== undefined) {
      if (opts.scope === null || opts.scope === '') {
        const reported = await reportedRepoName(opts);
        if (reported.ok !== true) return reported;
        return { ok: true, nameWithOwner: reported.nameWithOwner, host: reported.host || '' };
      }
      const pinned = normalizeIdentity(opts.scope, opts.env || process.env);
      if (pinned.ok !== true) return { ok: false, error: pinned.error };
      return { ok: true, nameWithOwner: pinned.nameWithOwner, host: pinned.host };
    }
    const reported = await reportedRepoName(opts);
    if (reported.ok !== true) return reported;
    if (!namesCheckout(opts) || !checkoutScope) {
      return { ok: true, nameWithOwner: reported.nameWithOwner, host: reported.host || '' };
    }
    const scope = await checkoutScope(opts);
    if (scope.ok !== true) return { ok: false, error: scope.error };
    const host = hostOfIdentity(scope.identity) || reported.host || '';
    return { ok: true, nameWithOwner: scope.nameWithOwner || reported.nameWithOwner, host };
  }

  async function repository(opts) {
    const repo = await repoNameWithOwner(opts);
    if (!repo.ok) return repo;
    // An injected identity seam that answers without a usable name fails closed
    // here instead of throwing on it.
    const fullName = typeof repo.nameWithOwner === 'string' ? repo.nameWithOwner : '';
    const parts = fullName.split('/');
    if (parts.length !== 2 || !parts.every((part) => part && !/\s/.test(part))) {
      return { ok: false, error: 'GitHub returned an invalid repository name' };
    }
    return {
      ok: true,
      owner: parts[0],
      name: parts[1],
      fullName,
      host: typeof repo.host === 'string' ? repo.host : '',
    };
  }

  async function graphql(query, fields, opts) {
    const argv = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(fields)) {
      if (value !== null && value !== undefined) argv.push('-F', `${name}=${value}`);
    }
    const res = await runGh(argv, opts);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, 'GitHub query failed') };
    const parsed = parseJsonBody(res.stdout, 'GitHub query');
    if (!parsed.ok) return parsed;
    if (Array.isArray(parsed.doc?.errors) && parsed.doc.errors.length > 0) {
      return { ok: false, error: parsed.doc.errors[0]?.message || 'GitHub query failed' };
    }
    if (!parsed.doc?.data || typeof parsed.doc.data !== 'object') {
      return { ok: false, error: 'GitHub query returned no data' };
    }
    return { ok: true, data: parsed.doc.data };
  }

  async function readSearchBucket({ bucket, query, cursor, pageSize }, opts) {
    const repo = await repository(opts);
    if (!repo.ok) return repo;
    const qualifier = BUCKET_QUALIFIERS[bucket] || '';
    const text = typeof query === 'string' ? query.trim() : '';
    const search = withLastUpdatedSort([`repo:${repo.fullName}`, 'is:pr', 'is:open', qualifier, text]
      .filter((part) => part !== '')
      .join(' '));
    return readPages({
      cursor,
      pageSize,
      isSearch: true,
      runPage: (first, after) => graphql(SEARCH_PAGE_QUERY, { search, first, cursor: after }, opts),
      connectionOf: (data) => data.search,
    });
  }

  async function readConnectionPage({ cursor, pageSize }, opts) {
    const repo = await repository(opts);
    if (!repo.ok) return repo;
    return readPages({
      cursor,
      pageSize,
      isSearch: false,
      runPage: (first, after) => graphql(CONNECTION_PAGE_QUERY, {
        owner: repo.owner, name: repo.name, first, cursor: after,
      }, opts),
      connectionOf: (data) => (data.repository && typeof data.repository === 'object'
        ? data.repository.pullRequests
        : null),
    });
  }

  // The repo-level metadata read: the viewer's role, the allowed merge methods,
  // the draft fact and the linked issues with their truncation flag.
  async function getPullRequestMetadata(number, opts = {}) {
    const repo = await repository(opts);
    if (!repo.ok) return repo;
    const res = await graphql(PULL_REQUEST_METADATA_QUERY, {
      owner: repo.owner, name: repo.name, number,
    }, opts);
    if (res.ok !== true) return res;
    const entry = res.data.repository;
    if (!entry || typeof entry !== 'object' || !entry.pullRequest || typeof entry.pullRequest !== 'object') {
      return { ok: false, error: 'pull request metadata is unavailable' };
    }
    // S2/D5: the draft fact is a PRECONDITION of merging, so a read that does
    // not carry it is a failed read, never a "not a draft".
    if (typeof entry.pullRequest.isDraft !== 'boolean') {
      return { ok: false, error: 'pull request metadata is unavailable: the draft state is missing' };
    }
    const mergeMethods = {};
    for (const [flag, method] of [
      ['mergeCommitAllowed', 'merge'],
      ['squashMergeAllowed', 'squash'],
      ['rebaseMergeAllowed', 'rebase'],
    ]) {
      if (entry[flag] === true) mergeMethods[method] = true;
    }
    const references = entry.pullRequest.closingIssuesReferences;
    const nodes = references && typeof references === 'object' && Array.isArray(references.nodes)
      ? references.nodes
      : null;
    // S2/D29 (S6): only the references that name THIS repository — or name none —
    // are this pane's click targets; the same rule the issue pane applies to its
    // linked pull requests, read the other way round.
    const linked = nodes === null
      ? { readable: false, numbers: [] }
      : linkedIssueNumbers(sameRepositoryReferences(nodes, repo.fullName));
    return {
      ok: true,
      permission: typeof entry.viewerPermission === 'string' ? entry.viewerPermission : null,
      mergeMethods,
      isDraft: entry.pullRequest.isDraft === true,
      // S2/D20: the state rides the read that already round-trips, so a merge
      // of a pull request that is no longer open is refused before the child.
      state: typeof entry.pullRequest.state === 'string' ? entry.pullRequest.state : null,
      linkedIssues: linked.readable === true ? linked.numbers : null,
      linkedIssuesTruncated: linked.readable === true && references.pageInfo?.hasNextPage === true,
    };
  }

  // S1: one page of one bucket. `mine`, `review` and `involved` are repository
  // SEARCHES; `all` is the repository connection, which carries an exact total
  // and pages past the search API's cap — a typed query in `all` stays a capped
  // search, exactly like the issues panel's lazy bucket. The answer is
  // `{rows, hasMore, cursor, totalCount}` for the panel's list.
  async function getPullRequestPage(params = {}, opts = {}) {
    const { params: p, options } = splitParams(params, opts);
    const bucket = p.bucket === undefined || p.bucket === null ? 'mine' : String(p.bucket);
    if (BUCKET_QUALIFIERS[bucket] === undefined && bucket !== 'all') {
      return { ok: false, error: `invalid bucket ${JSON.stringify(p.bucket)}: want mine, review, involved or all` };
    }
    const page = normalizePageRequest(p);
    if (page.ok !== true) return page;
    const query = typeof p.query === 'string' ? p.query : '';
    if (bucket === 'all' && query.trim() === '') {
      return readConnectionPage({ cursor: page.cursor, pageSize: page.pageSize }, options);
    }
    return readSearchBucket({ bucket, query, cursor: page.cursor, pageSize: page.pageSize }, options);
  }

  // S1: the lazy `all prs` connection, page for page.
  async function getPullRequestConnectionPage(params = {}, opts = {}) {
    const { params: p, options } = splitParams(params, opts);
    const page = normalizePageRequest(p);
    if (page.ok !== true) return page;
    return readConnectionPage({ cursor: page.cursor, pageSize: page.pageSize }, options);
  }

  // S3: the detail read — the row plus the body, the change counts, the commit
  // count and date, the reviewers, the checks rollup, the merge facts and, with
  // `includeMetadata`, the capability map and the linked issues.
  async function getPullRequest(number, options = {}, opts = {}) {
    const { params: p, options: callOpts } = splitParams(options, opts);
    if (!Number.isInteger(number) || number < 1) {
      return {
        ok: false,
        error: `invalid pull request number ${JSON.stringify(number)}: want a positive integer`,
        status: null,
        notFound: false,
      };
    }
    const res = await runGh(['pr', 'view', String(number), '--json', DETAIL_JSON_FIELDS], callOpts);
    if (res.error) return { ok: false, error: res.error, status: null, notFound: false };
    if (res.status !== 0) return pullRequestViewFailure(res, number);
    const parsed = parseJsonBody(res.stdout, `gh pr view ${number}`);
    if (!parsed.ok) return parsed;
    if (!parsed.doc || typeof parsed.doc !== 'object' || typeof parsed.doc.number !== 'number') {
      return { ok: false, error: `gh pr view ${number} returned an unexpected shape` };
    }
    const rawComments = Array.isArray(parsed.doc.comments) ? parsed.doc.comments : [];
    const pullRequest = normalizePullRequestDetail(parsed.doc);
    const linkedReadable = linkedIssueNumbers(parsed.doc.closingIssuesReferences).readable === true;
    if (p.includeMetadata === true) {
      const metadata = await getPullRequestMetadata(number, callOpts);
      applyMetadata(pullRequest, metadata, linkedReadable);
    }
    return {
      ok: true,
      pullRequest,
      comments: rawComments.map((entry, index) => normalizeComment(entry, index)),
    };
  }

  // S5 (T4's read): ONE aliased GraphQL answers the rail's two buckets, each
  // with its EXACT `issueCount` and the linked issues of every row it carries.
  // `viewer` is accepted for interface symmetry with the panel seams; `@me` is
  // already the authenticated viewer, so nothing here needs the login.
  async function listRailPullRequests(options = {}, opts = {}) {
    const { params: p, options: callOpts } = splitParams(options, opts);
    const first = p.first === undefined || p.first === null ? RAIL_WINDOW_DEFAULT : p.first;
    if (!Number.isInteger(first) || first < 1 || first > RAIL_WINDOW_MAX) {
      return { ok: false, error: `invalid first ${JSON.stringify(p.first)}: want an integer 1..100` };
    }
    const repo = await repository(callOpts);
    if (!repo.ok) return repo;
    const res = await graphql(railQuery(repo.fullName, first), {}, callOpts);
    if (res.ok !== true) return res;
    const rows = {};
    const counts = {};
    for (const [alias] of RAIL_ALIAS_QUALIFIERS) {
      const connection = res.data ? res.data[alias] : null;
      if (!connection || typeof connection !== 'object' || Array.isArray(connection)
        || !Number.isInteger(connection.issueCount) || connection.issueCount < 0
        || !Array.isArray(connection.nodes)) {
        return { ok: false, error: 'gh api graphql returned an unexpected shape' };
      }
      const bucketRows = [];
      for (const node of connection.nodes) {
        if (!node || typeof node !== 'object' || !Number.isInteger(node.number) || node.number <= 0) {
          return { ok: false, error: 'gh api graphql returned a pull request without a number' };
        }
        const references = node.closingIssuesReferences && typeof node.closingIssuesReferences === 'object'
          ? node.closingIssuesReferences.nodes
          : null;
        bucketRows.push({ number: node.number, linkedIssues: linkedIssueNumbers(references).numbers });
      }
      rows[alias] = bucketRows;
      counts[alias] = connection.issueCount;
    }
    return {
      ok: true,
      mine: rows.mine,
      review: rows.review,
      counts: { mine: counts.mine, review: counts.review },
    };
  }

  // S2/D13: ONE resolved repository scope per write. The role read and the write
  // it authorizes both run in it, and it is resolved exactly once, so a checkout
  // whose remote moves between the two children can never authorize one
  // repository and write under another. S2/D24: with no explicit pin and no
  // checkout, gh's ambient answer is resolved ONCE and pinned host-qualified, so
  // a default that moves mid-action cannot do the same.
  async function writeScopeFor(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const resolved = await scopeForCall({ ...opts, freshScope: true });
    if (resolved.ok !== true) return { ok: false, error: resolved.error };
    const identity = resolved.identity || null;
    if (identity === null) {
      const ambient = await repository({ ...opts, freshScope: true });
      if (ambient.ok !== true) return ambient;
      // S2/D28: the host comes from the repository lookup itself; github.com is
      // the last resort, never the assumption.
      const host = ambient.host || provenHost({ ...opts, scope: undefined }) || 'github.com';
      const pinned = `${host}/${ambient.owner}/${ambient.name}`;
      return {
        ok: true,
        owner: ambient.owner,
        name: ambient.name,
        scope: pinned,
        // Every child of this write runs with that pin, never with an ambient
        // resolution it would otherwise repeat.
        options: withHostOptions({ ...opts, scope: pinned, freshScope: true }, host),
      };
    }
    const repo = await repository({ ...opts, freshScope: true, scope: identity });
    if (repo.ok !== true) return repo;
    const host = canonicalHost(identity.split('/')[0]);
    return {
      ok: true,
      owner: repo.owner,
      name: repo.name,
      scope: identity,
      // Every child of this write runs with that pin, never with an ambient
      // resolution it would otherwise repeat.
      options: withHostOptions({ ...opts, scope: identity, freshScope: true }, host),
    };
  }

  // S2/D2: the ONE repository-role read every write runs for itself, so a
  // capability that lapsed after the pane painted still fails closed here. It
  // answers the options its write must run with, so the role and the write share
  // ONE resolved scope (D13). With a pull request number it answers that pull
  // request's fresh state in the same round trip (D20).
  async function repositoryRole(opts, number = null) {
    const scope = await writeScopeFor(opts);
    if (scope.ok !== true) return { ok: false, error: scope.error };
    const named = Number.isInteger(number) && number > 0;
    const res = named
      ? await graphql(REPOSITORY_WRITE_QUERY, { owner: scope.owner, name: scope.name, number }, scope.options)
      : await graphql(REPOSITORY_PERMISSION_QUERY, { owner: scope.owner, name: scope.name }, scope.options);
    if (res.ok !== true) return res;
    const entry = res.data.repository;
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'GitHub returned no repository permission' };
    }
    const pullRequest = entry.pullRequest && typeof entry.pullRequest === 'object' ? entry.pullRequest : null;
    return {
      ok: true,
      permission: typeof entry.viewerPermission === 'string' ? entry.viewerPermission : null,
      state: pullRequest && typeof pullRequest.state === 'string' ? pullRequest.state : null,
      options: scope.options,
    };
  }

  // Repository-level label calls, mirrored from the issue client (they are not
  // issue-specific, and that module is injected here rather than required).
  const localListLabels = async (opts = {}) => {
    const res = await runGh(['label', 'list', '--limit', String(LABEL_FETCH_MAX), '--json', LABEL_JSON_FIELDS], opts);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, 'gh label list failed') };
    const parsed = parseJsonBody(res.stdout, 'gh label list');
    if (!parsed.ok) return parsed;
    if (!Array.isArray(parsed.doc)) return { ok: false, error: 'gh label list returned an unexpected shape' };
    return { ok: true, labels: parsed.doc.map(asLabel) };
  };

  const localCreateLabel = async ({ name, color, description } = {}, opts = {}) => {
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'label name must be a non-empty string' };
    }
    const argv = ['label', 'create', name];
    if (typeof color === 'string' && color !== '') argv.push('--color', color);
    if (typeof description === 'string' && description !== '') argv.push('--description', description);
    const res = await runGh(argv, { ...(opts || {}), freshScope: true });
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, `cannot create label ${name}`) };
    return { ok: true, label: { name, color: color || '', description: description || '' } };
  };

  // S2/D2: creating a repository label is a write, so it reads the role before
  // it delegates (the injected issue client's own call does not gate it).
  const delegateCreateLabel = seam('createLabel', localCreateLabel);
  async function createLabel({ name, color, description } = {}, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'label name must be a non-empty string' };
    }
    const role = await repositoryRole(options);
    if (role.ok !== true) return { ok: false, error: role.error };
    if (pullRequestPermissions(role.permission).canCreateLabels !== true) {
      return { ok: false, error: 'Repository permission does not allow creating labels' };
    }
    return delegateCreateLabel({ name, color, description }, role.options);
  }

  const localListAssignableUsers = async (opts = {}) => {
    const repo = await repository(opts);
    if (!repo.ok) return repo;
    const users = [];
    const logins = new Set();
    const cursors = new Set();
    let cursor = null;
    for (let page = 0; page < SNAPSHOT_MAX_PAGES; page += 1) {
      const res = await graphql(ASSIGNABLE_USERS_QUERY, { owner: repo.owner, name: repo.name, cursor }, opts);
      if (!res.ok) return res;
      const connection = res.data.repository?.assignableUsers;
      if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
        return { ok: false, error: 'GitHub returned an invalid assignable-user page' };
      }
      for (const user of connection.nodes) {
        if (typeof user?.login !== 'string' || !user.login) {
          return { ok: false, error: 'GitHub returned an invalid assignable user' };
        }
        const id = user.login.toLowerCase();
        if (!logins.has(id)) {
          logins.add(id);
          users.push({ login: user.login, name: typeof user.name === 'string' ? user.name : '' });
        }
      }
      if (!connection.pageInfo.hasNextPage) return { ok: true, users };
      const next = connection.pageInfo.endCursor;
      if (typeof next !== 'string' || !next || cursors.has(next)) {
        return { ok: false, error: 'Assignable-user pagination did not advance' };
      }
      cursors.add(next);
      cursor = next;
    }
    return { ok: false, error: 'Assignable-user pagination exceeded its safety budget' };
  };

  // Commenting stays ungated, exactly like the issue client: the capability map
  // gates closing, merging, labelling, assigning and the body edit, not a
  // comment.
  async function commentPullRequest(number, body, opts = {}) {
    if (!Number.isInteger(number) || number < 1) return invalidNumber(number);
    if (typeof body !== 'string' || body.trim() === '') {
      return { ok: false, error: 'comment body must be a non-empty string' };
    }
    const res = await runGh(['pr', 'comment', String(number), '--body', body], {
      ...(opts || {}), freshScope: true,
    });
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, `cannot comment on pull request #${number}`) };
    return { ok: true };
  }

  // Labels on a pull request go through the pull request surface, `gh pr edit`,
  // so the exact argv names the resource the panel is showing. S2/D2: the role
  // is read again here, so a lapsed capability never issues a write child.
  // S2/D31: that read names the pull request and its state, so a pull request
  // that is no longer OPEN loses its editor here as well (the panel's decision
  // paragraph: a non-open pull request keeps only its comment key).
  async function editLabels(number, changes = {}, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    if (!Number.isInteger(number) || number < 1) return invalidNumber(number);
    const additions = Array.isArray(changes?.add)
      ? changes.add.filter((entry) => typeof entry === 'string' && entry !== '')
      : [];
    const removals = Array.isArray(changes?.remove)
      ? changes.remove.filter((entry) => typeof entry === 'string' && entry !== '')
      : [];
    if (additions.length === 0 && removals.length === 0) return { ok: true };
    const role = await repositoryRole(options, number);
    if (role.ok !== true) return { ok: false, error: role.error };
    if (pullRequestPermissions(role.permission).canEditLabels !== true) {
      return { ok: false, error: 'Repository permission does not allow editing pull request labels' };
    }
    if (role.state !== 'OPEN') {
      return { ok: false, error: `pull request #${number} is not open; its labels cannot be edited` };
    }
    const argv = ['pr', 'edit', String(number)];
    for (const name of additions) argv.push('--add-label', name);
    for (const name of removals) argv.push('--remove-label', name);
    const res = await runGh(argv, role.options);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, `cannot edit labels on pull request #${number}`) };
    return { ok: true };
  }

  // The assignee toggle S2 describes: one delta that adds and removes at once,
  // so the same key both assigns and unassigns. `self` says whether the delta
  // names the authenticated viewer, whose own buckets the rail draws.
  async function editAssignees(number, changes = {}, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const entry = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : null;
    const add = entry && Array.isArray(entry.add) ? entry.add : [];
    const remove = entry && Array.isArray(entry.remove) ? entry.remove : [];
    if (!Number.isInteger(number) || number < 1 || entry === null
      || !add.every(isValidLogin) || !remove.every(isValidLogin)
      || add.some((name) => remove.some((other) => name.toLowerCase() === other.toLowerCase()))) {
      return { ok: false, error: 'invalid assignee changes: supply distinct GitHub logins to add or remove' };
    }
    if (add.length === 0 && remove.length === 0) return { ok: true, changed: false, self: false };
    // S2/D13: the access read and the toggle it authorizes share ONE scope.
    // S2/D31: it names the pull request too, so its state rides the same round
    // trip and a non-open pull request keeps no assignee editor.
    const scope = await writeScopeFor(options);
    if (scope.ok !== true) return { ok: false, error: scope.error };
    const access = await graphql(
      ASSIGNEE_ACCESS_QUERY, { owner: scope.owner, name: scope.name, number }, scope.options,
    );
    if (access.ok !== true) return access;
    if (!pullRequestPermissions(access.data.repository?.viewerPermission).canEditAssignees) {
      return { ok: false, error: 'Repository permission does not allow changing pull request assignees' };
    }
    const state = access.data.repository?.pullRequest?.state;
    if (state !== 'OPEN') {
      return { ok: false, error: `pull request #${number} is not open; its assignees cannot be edited` };
    }
    const argv = ['pr', 'edit', String(number)];
    for (const name of new Set(add)) argv.push('--add-assignee', name);
    for (const name of new Set(remove)) argv.push('--remove-assignee', name);
    const res = await runGh(argv, scope.options);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, 'Cannot edit pull request assignees') };
    const viewer = access.data && access.data.viewer && typeof access.data.viewer.login === 'string'
      ? access.data.viewer.login.toLowerCase()
      : '';
    const self = viewer !== '' && [...new Set([...add, ...remove])].some((name) => name.toLowerCase() === viewer);
    return { ok: true, changed: true, self };
  }

  // S2/D2: closing is a write, so the repository role is read first and an
  // unpermitted viewer never reaches `gh pr close`. D13: the close runs in the
  // ONE scope that role read proved. D20: the same read answers the fresh state,
  // so a pull request that is no longer open is refused here as well.
  async function closePullRequest(number, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    if (!Number.isInteger(number) || number < 1) return invalidNumber(number);
    const role = await repositoryRole(options, number);
    if (role.ok !== true) return { ok: false, error: role.error };
    if (pullRequestPermissions(role.permission).canClosePullRequests !== true) {
      return { ok: false, error: 'Repository permission does not allow closing pull requests' };
    }
    if (role.state !== 'OPEN') {
      return { ok: false, error: `pull request #${number} is not open; it cannot be closed` };
    }
    const res = await runGh(['pr', 'close', String(number)], role.options);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, `cannot close pull request #${number}`) };
    return { ok: true };
  }

  // S2: merge, refusing every case the repository does not allow before any
  // merge child runs — an unknown method, a method the repository does not
  // allow, a draft pull request, or a viewer who may not merge.
  async function mergePullRequest(number, changes = {}, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const entry = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
    if (!Number.isInteger(number) || number < 1) return invalidNumber(number);
    const method = entry.method;
    if (typeof method !== 'string' || MERGE_FLAGS[method] === undefined) {
      return { ok: false, error: `invalid merge method ${JSON.stringify(method)}: want merge, squash or rebase` };
    }
    // S2/D5: a field the caller CLEARED is not a field the caller omitted. An
    // empty description is sent empty; an empty commit message is refused, since
    // GitHub would replace it with its own proposal behind the reader's back.
    // A rebase merge takes neither field, so neither is inspected.
    const given = (key) => Object.prototype.hasOwnProperty.call(entry, key);
    if (method !== 'rebase' && given('subject') && !(typeof entry.subject === 'string' && entry.subject.trim() !== '')) {
      return { ok: false, error: 'the merge commit message must not be empty' };
    }
    // S2/D13: the metadata read is this write's role read, and it runs in the ONE
    // scope the merge child will run in.
    const scope = await writeScopeFor(options);
    if (scope.ok !== true) return { ok: false, error: scope.error };
    const metadata = await getPullRequestMetadata(number, scope.options);
    if (metadata.ok !== true) return { ok: false, error: metadata.error };
    const allowed = allowedMergeMethods(metadata.mergeMethods);
    if (allowed.includes(method) !== true) {
      if (allowed.length === 0) {
        return { ok: false, error: `the repository allows no merge method for pull request #${number}` };
      }
      return {
        ok: false,
        error: `the repository does not allow the ${JSON.stringify(method)} merge method (allowed: ${allowed.join(', ')})`,
      };
    }
    if (metadata.isDraft === true) {
      return { ok: false, error: `pull request #${number} is a draft; it cannot be merged` };
    }
    if (metadata.state !== 'OPEN') {
      return { ok: false, error: `pull request #${number} is not open; it cannot be merged` };
    }
    const mergeable = pullRequestPermissions(metadata.permission, {
      isDraft: metadata.isDraft === true,
      mergeMethods: metadata.mergeMethods,
    });
    if (mergeable.canMerge !== true) {
      return { ok: false, error: 'Repository permission does not allow merging pull requests' };
    }
    const argv = ['pr', 'merge', String(number), MERGE_FLAGS[method]];
    // A rebase merge replays the commits it rewrites, so it takes neither a
    // subject nor a body: the proposals mean nothing there.
    if (method !== 'rebase') {
      if (given('subject')) argv.push('--subject', entry.subject);
      if (given('body') && typeof entry.body === 'string') argv.push('--body', entry.body);
    }
    const res = await runGh(argv, scope.options);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, `cannot merge pull request #${number}`) };
    return { ok: true, method };
  }

  // S2: the Development relation. GitHub has no mutation for it, so the body is
  // read, the closing lines are rewritten and the body is written back — with
  // every other byte preserved.
  async function editLinkedIssues(number, changes = {}, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const entry = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : null;
    const add = entry && Array.isArray(entry.add) ? entry.add : [];
    const remove = entry && Array.isArray(entry.remove) ? entry.remove : [];
    const positive = (values) => values.every((value) => Number.isInteger(value) && value > 0);
    if (!Number.isInteger(number) || number < 1 || entry === null
      || !positive(add) || !positive(remove)
      || add.some((value) => remove.includes(value))) {
      return { ok: false, error: 'invalid linked-issue changes: supply distinct positive issue numbers' };
    }
    if (add.length === 0 && remove.length === 0) return { ok: true, changed: false, body: null };
    // S2/D2: the body edit is a write, so the role is read first; D20: that read
    // also answers whether the pull request is still open.
    const role = await repositoryRole(options, number);
    if (role.ok !== true) return { ok: false, error: role.error };
    if (pullRequestPermissions(role.permission).canEditLinkedIssues !== true) {
      return { ok: false, error: 'Repository permission does not allow editing pull request linked issues' };
    }
    if (role.state !== 'OPEN') {
      return { ok: false, error: `pull request #${number} is not open; its linked issues cannot be edited` };
    }
    const view = await runGh(['pr', 'view', String(number), '--json', 'body'], role.options);
    if (view.error) return { ok: false, error: view.error };
    if (view.status !== 0) {
      return { ok: false, error: exitError(view, `cannot read the body of pull request #${number}`) };
    }
    const parsed = parseJsonBody(view.stdout, `gh pr view ${number}`);
    if (parsed.ok !== true) return parsed;
    const body = parsed.doc && typeof parsed.doc.body === 'string' ? parsed.doc.body : null;
    if (body === null) return { ok: false, error: `gh pr view ${number} returned an unexpected shape` };
    const next = rewriteClosingLines(body, add, remove);
    // S2/D27: a body whose fences or comments do not pair up is refused outright
    // (add or remove alike) instead of being interpreted.
    if (next.refused !== undefined) return { ok: false, error: next.refused };
    if (next.body === body) return { ok: true, changed: false, body };
    // S2/D27: the body is read AGAIN immediately before the write and compared
    // with the read the edit was prepared from, so an author's edit that landed
    // in between is never overwritten.
    // S2/T18: that last read answers the pull request STATE with the body, so a
    // pull request closed or merged during the reads is refused here instead of
    // being written after the fact. A re-read that proves neither refuses too:
    // a missing fact never counts as "still open".
    const again = await runGh(['pr', 'view', String(number), '--json', 'body,state'], role.options);
    if (again.error) return { ok: false, error: again.error };
    if (again.status !== 0) {
      return { ok: false, error: exitError(again, `cannot read the body of pull request #${number}`) };
    }
    const reread = parseJsonBody(again.stdout, `gh pr view ${number}`);
    if (reread.ok !== true) return reread;
    const current = reread.doc && typeof reread.doc.body === 'string' ? reread.doc.body : null;
    const currentState = reread.doc && typeof reread.doc.state === 'string' ? reread.doc.state : null;
    if (current === null || currentState === null) {
      return { ok: false, error: `gh pr view ${number} returned an unexpected shape` };
    }
    if (currentState !== 'OPEN') {
      return { ok: false, error: `pull request #${number} is not open; its linked issues cannot be edited` };
    }
    // The comparison stays exact: one byte of difference is an author's edit.
    if (current !== body) return { ok: false, error: BODY_CHANGED };
    const res = await runGh(['pr', 'edit', String(number), '--body', next.body], role.options);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) {
      return { ok: false, error: exitError(res, `cannot edit the body of pull request #${number}`) };
    }
    return { ok: true, changed: true, body: next.body };
  }

  return {
    setGhRunner(fn) {
      setGhRunner(fn);
      forwardRunner(supplied);
    },
    normalizeScopeIdentity: normalizeIdentity,
    pullRequestPermissions,
    getPullRequestPage,
    getPullRequestConnectionPage,
    getPullRequest,
    getPullRequestMetadata,
    commentPullRequest,
    listLabels: seam('listLabels', localListLabels),
    createLabel,
    editLabels,
    listAssignableUsers: seam('listAssignableUsers', localListAssignableUsers),
    editAssignees,
    closePullRequest,
    mergePullRequest,
    editLinkedIssues,
    listRailPullRequests,
  };
}

// ---------------------------------------------------------------------------
// Binding: the extension injects its own issue client once and every
// convenience export below delegates to the client bound to it.
// ---------------------------------------------------------------------------

const CLIENT_FUNCTIONS = [
  'getPullRequestPage',
  'getPullRequestConnectionPage',
  'getPullRequest',
  'getPullRequestMetadata',
  'commentPullRequest',
  'listLabels',
  'createLabel',
  'editLabels',
  'listAssignableUsers',
  'editAssignees',
  'closePullRequest',
  'mergePullRequest',
  'editLinkedIssues',
  'listRailPullRequests',
];

// Bind the injected issue client and answer the client bound to it.
function bindIssuesClient(issues) {
  boundIssues = issues && typeof issues === 'object' ? issues : null;
  boundClient = createPrsClient({ issues: boundIssues });
  forwardRunner(boundIssues);
  return boundClient;
}

function bound() {
  if (boundClient === null) {
    boundClient = createPrsClient({ issues: boundIssues });
    forwardRunner(boundIssues);
  }
  return boundClient;
}

const exported = {
  createPrsClient,
  bindIssuesClient,
  setGhRunner,
  normalizeScopeIdentity,
  pullRequestPermissions,
};

for (const name of CLIENT_FUNCTIONS) {
  exported[name] = (...args) => bound()[name](...args);
}

module.exports = exported;
