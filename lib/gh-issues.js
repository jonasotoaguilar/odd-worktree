'use strict';
// `gh` client migrated whole from the source package's issues panel (T2
// S1,S3): `/issues` reads through it once that command is wired.
//
// This module is the ONLY place that runs `gh`. Every spawn uses
// `child_process.execFile` with an argv array and NO shell string, so no
// argument (a search query, a comment body, a label name) can ever be
// interpreted by a shell. Nothing here prints or persists a token and
// nothing writes user config: authentication stays entirely inside `gh`.
//
// Injectable runner seam: `setGhRunner(fn)` replaces the default
// `execFile` runner with `fn(bin, argv, {cwd, timeoutMs})` resolving to
// `{status, stdout, stderr, error}`. Tests inject captured REAL `gh` JSON
// through it and never invoke the real binary. Pass `null` to restore the
// default runner.
//
// Every exported call returns `{ok:true, ...}` or `{ok:false, error}` and
// never throws — including a missing binary (ENOENT), a non-zero exit,
// an empty body and malformed JSON.
//
// Structured data always comes from `gh --json` output. Verified against
// `gh <cmd> --help` in the source repository:
// - `gh issue list` supports `--state {open|closed|all}`, `--search`,
//   `--limit` and `--json`, but NO offset/page flag — so `listIssues`
//   fetches up to a bounded limit and pages the result in memory.
// - `gh issue view` accepts `--json` with fields including
//   number,title,state,stateReason,author,labels,createdAt,updatedAt,
//   comments,reactionGroups,url,body, but REJECTS `--comments` together
//   with `--json` (`specify only one of --comments or --json`) — so
//   `getIssue` reads comments from the single `--json` call, which embeds
//   them. `authorAssociation`, `reactions` and `isPullRequest` are NOT
//   valid `--json` fields (gh errors `Unknown JSON field`), so the
//   normalized shapes carry honest defaults for those instead of asking
//   `gh` for fields it cannot return.
// - `gh label list --json name,color,description` and
//   `gh label create <name> [--color … --description …]` as documented.
// - `gh issue edit --add-label/--remove-label`, `gh issue comment --body`,
//   `gh issue close` / `gh issue reopen` as documented.
// - Identity via `gh api user` (JSON with `login`) and the repository via
//   `gh repo view --json nameWithOwner`; `gh auth status` failures surface
//   as unauthenticated errors from the same calls.
//
// FORK SCOPE: `gh` resolves a fork checkout's BASE repository. With both
// `origin` (the fork) and `upstream` (the original) configured, `gh repo view`
// answers the ORIGINAL, so unscoped `gh issue` reads and every
// `repository(owner, name)` query listed the original's issues on every reader
// surface. The checkout's OWN repository is an unambiguous NON-BASE remote:
// `branch.<branch>.pushRemote`, `remote.pushDefault`, `origin` or the tracking
// remote when one of them is not named like a base, otherwise the only non-base
// remote. A branch that merely TRACKS or pushes to `upstream` never makes the
// base the scope, and two or more non-base remotes with no attach point is
// AMBIGUOUS: the whole resolution fails closed instead of guessing a fork or
// silently reading the base. `checkoutRepoScope` reads that from git (never the
// network) and every gh call here carries it as a HOST-QUALIFIED `GH_REPO`
// (`<host>/<owner>/<repo>`, the form gh accepts), while repository resolution
// reports it instead of `gh`'s base answer. A checkout with a single remote has
// nothing to disambiguate, so it keeps `gh`'s resolution exactly; a
// caller-supplied `GH_REPO` always wins at resolution time; and a call that
// names no checkout (`cwd`) keeps `gh`'s default too.
//
// FAIL CLOSED: the selected head remote must PROVE it names a GitHub repository
// — the GitHub host gh will actually target and a valid `owner/name`. A
// local/`file://` remote, a remote on another host, an unreadable URL, a
// resolution error or an invalid identifier fails the whole resolution: no
// GH_REPO is injected and no gh command runs, so an issue read or write can
// never be redirected to a different repository. The same remote is never
// swapped for another one to make the check pass, and a self-hosted GitHub
// Enterprise host is accepted only when `GH_HOST` names it — in which case the
// remote must be on that EXACT server, because gh targets GH_HOST whatever the
// remote says. Any non-github.com server requires GH_HOST for the same reason
// from the other side: `gh api`/GraphQL use the default host. A resolved scope is reused for a two-second read window and then
// revalidated against the live git configuration hash, so a changed remote is
// followed quickly; the write path resolves it fresh at the moment it runs.
//
// PINNED IDENTITY: a caller may hand back the identity it already
// displayed. It is always normalized to `<host>/<owner>/<repo>`, injected
// verbatim as GH_REPO (so an ambient GH_REPO cannot override it) and validated
// against the caller's live environment: a pin naming one server while GH_HOST
// selects another fails closed instead of being redirected to that host.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 30000;
const GIT_TIMEOUT_MS = 5000;
const LIST_FETCH_MAX = 500;
const LABEL_FETCH_MAX = 500;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
// `gh issue list` has no offset flag and the SEARCH API caps its own result
// set, so a complete open-issue snapshot is read through the GraphQL
// connection: `first` is the server page size and `after` walks it to the end.
const GRAPHQL_PAGE_SIZE = 100;
// Runaway guard, never a data cutoff: 100 issues per page, so only a
// pathological repository (250k open issues) can reach it. Every page also
// runs under DEFAULT_TIMEOUT_MS, so a hung request cannot hold the loop.
const SNAPSHOT_MAX_PAGES = 2500;
// Search-syntax qualifier: this client asks `gh` for last-update ordering so
// every consumer inherits it.
const LAST_UPDATED_SORT = 'sort:updated-desc';

const ISSUE_LIST_JSON_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'labels',
  'createdAt', 'updatedAt', 'comments', 'reactionGroups', 'url',
].join(',');
// The detail pane needs the issue `body`, so the single-issue fetch keeps
// the full field set; the list never asks for it (getIssue owns bodies).
const ISSUE_DETAIL_JSON_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'assignees', 'labels',
  'createdAt', 'updatedAt', 'comments', 'reactionGroups', 'url', 'body',
].join(',');
const LABEL_JSON_FIELDS = 'name,color,description';

// The whole open set as a cursor-paged connection. The row fields are the ones
// `normalizeIssue` reads, in the GraphQL shapes (`labels`/`comments` arrive as
// connections); `graphqlIssueRow` reshapes them.
const OPEN_ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        stateReason
        url
        createdAt
        updatedAt
        author { login }
        labels(first: 50) { nodes { name color description } }
        comments { totalCount }
        reactionGroups { content users { totalCount } }
      }
    }
  }
}`;

let runnerOverride = null;

// Test seam: inject `fn(bin, argv, runOpts)` (may be sync or async), or
// `null`/`undefined` to restore the default `execFile` runner.
function setGhRunner(fn) {
  if (fn === null || fn === undefined) {
    runnerOverride = null;
    return;
  }
  if (typeof fn !== 'function') throw new TypeError('setGhRunner requires a function or null');
  runnerOverride = fn;
}

function ghBinary(opts = {}) {
  if (typeof opts.ghBin === 'string' && opts.ghBin.length > 0) return opts.ghBin;
  const env = opts.env || process.env;
  const fromEnv = env && env.GH_BIN_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return 'gh';
}

// ---------------------------------------------------------------------------
// Checkout scope: which repository this checkout belongs to.
// ---------------------------------------------------------------------------

// A remote named like a base is never the fork's own repository.
const BASE_REMOTE_PATTERN = /^(upstream|parent|base)$/i;
// Hosts this module can prove are GitHub without asking the network. With
// GH_HOST set, gh targets THAT server whatever the remote says, so the remote
// must name the same server; without it, gh derives the host from the remote,
// and only a proven GitHub host is accepted.
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
// GitHub's own identifier rules. An owner is 1-39 alphanumerics and hyphens
// (no leading or trailing hyphen); a repository name is 1-100 of alphanumerics,
// `.`, `_` and `-`. Anything else is not a repository this client may target.
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// A resolved scope is cached per checkout. Reads reuse it for a very short
// window (so one screenful is not a git probe per gh call) and every reuse
// after that window revalidates it against the hash of the checkout's live
// local git configuration, so `git remote set-url/add/remove` invalidates it
// quickly. The longer max age is the backstop for configuration living
// OUTSIDE `--local` (a global `url.<base>.insteadOf`, for example). The write
// path never reuses the cache at all: it resolves fresh.
const REPO_SCOPE_CACHE_MAX = 64;
const REPO_SCOPE_FRESH_WINDOW_MS = 2000;
const REPO_SCOPE_MAX_AGE_MS = 60000;

let gitRunnerOverride = null;

// Test seam: inject `fn(argv, {cwd, timeoutMs})` returning
// `{status, stdout, stderr, error}` (sync or async), or `null`/`undefined` to
// restore the real git runner. A throw or rejection propagates to the resolver,
// whose caller fails closed rather than trusting another repository.
function setGitRunner(fn) {
  if (fn === null || fn === undefined) {
    gitRunnerOverride = null;
    return;
  }
  if (typeof fn !== 'function') throw new TypeError('setGitRunner requires a function or null');
  gitRunnerOverride = fn;
}

function gitResult(raw) {
  const outcome = raw && typeof raw === 'object' ? raw : {};
  return {
    status: typeof outcome.status === 'number' ? outcome.status : null,
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
    stderr: typeof outcome.stderr === 'string' ? outcome.stderr : '',
    error: outcome.error === null || outcome.error === undefined ? null : String(outcome.error),
  };
}

// Real git, fixed argv, no shell string, bounded timeout. Any spawn failure is
// reported as `error` (never thrown), so a resolution can fail closed.
function defaultGitRunner(argv, opts = {}) {
  const timeout = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    try {
      execFile('git', argv, {
        cwd: opts.cwd,
        timeout,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: null });
          return;
        }
        resolve({
          status: typeof err.code === 'number' ? err.code : null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err.killed ? `git timed out after ${timeout}ms` : null,
        });
      });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
    }
  });
}

function runGit(argv, opts = {}) {
  const timeoutMs = opts.timeoutMs;
  if (gitRunnerOverride) {
    return Promise.resolve()
      .then(() => gitRunnerOverride(argv, { cwd: opts.cwd, timeoutMs }))
      .then(gitResult);
  }
  return defaultGitRunner(argv, { cwd: opts.cwd, timeoutMs }).then(gitResult);
}

function configFingerprint(stdout) {
  return crypto.createHash('sha256').update(String(stdout || '')).digest('hex');
}

// `git config --local --null --list` records as `key\nvalue\0`; the value may
// contain newlines, so only the FIRST newline separates key from value. The
// raw configuration is never stored or printed — only parsed in memory and
// hashed, because it can carry credentials.
function parseConfigList(stdout) {
  const config = new Map();
  for (const record of String(stdout || '').split('\0')) {
    if (record === '') continue;
    const cut = record.indexOf('\n');
    if (cut < 0) continue;
    config.set(record.slice(0, cut), record.slice(cut + 1));
  }
  return config;
}

// A remote exists when its configuration does. Names keep the case git stored
// them with (a subsection is case-sensitive).
function configRemotes(config) {
  const names = [];
  for (const key of config.keys()) {
    const match = key.match(/^remote\.(.+)\.(?:url|pushurl)$/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

// Exactly ONE head remote is selected. A checkout with a single remote has
// nothing to disambiguate, so it keeps gh's own resolution (the caller then
// pins gh's answer, host included). With several remotes, the checkout's own
// repository is an unambiguous NON-BASE remote:
//   1. an explicit attach point wins when it is NOT named like a base:
//      branch.<branch>.pushRemote, remote.pushDefault, `origin`, then the
//      branch's tracking remote. A branch that merely TRACKS or pushes to
//      `upstream` therefore never makes the base the scope;
//   2. otherwise exactly one non-base remote is the checkout's own repository;
//   3. otherwise (two or more non-base remotes and no attach point) the
//      selection is AMBIGUOUS and the whole resolution fails closed: a base
//      remote is never silently chosen and no other remote is guessed.
// The verdict is final — consumers never slide to another remote when it fails.
function selectHeadRemote(config, branch) {
  const remotes = configRemotes(config);
  if (remotes.length < 2) return { ok: true, remote: null };
  const isBase = (name) => BASE_REMOTE_PATTERN.test(name);
  const pushDefault = config.get('remote.pushdefault') || null;
  const pushRemote = branch ? (config.get(`branch.${branch}.pushremote`) || null) : null;
  const branchRemote = branch ? (config.get(`branch.${branch}.remote`) || null) : null;
  const candidates = [];
  if (pushRemote) candidates.push(pushRemote);
  if (pushDefault) candidates.push(pushDefault);
  candidates.push('origin');
  if (branchRemote && branchRemote !== '.') candidates.push(branchRemote);
  for (const name of candidates) {
    if (remotes.includes(name) && !isBase(name)) return { ok: true, remote: name };
  }
  const nonBase = remotes.filter((name) => !isBase(name));
  if (nonBase.length === 0) return { ok: true, remote: null };
  if (nonBase.length === 1) return { ok: true, remote: nonBase[0] };
  const names = nonBase.map((name) => `"${name}"`).join(', ');
  const hint = branch
    ? `set remote.pushDefault or branch.${branch}.pushRemote to the fork`
    : 'set remote.pushDefault or branch.<branch>.pushRemote to the fork';
  return {
    ok: false,
    error: `cannot tell which checkout remote is this repository's own: ${names} are all non-base remotes; ${hint}`,
  };
}

function scopeFailure(remote, reason) {
  return { ok: false, error: `checkout remote "${remote}" ${reason}` };
}

function ghHostOf(env) {
  const raw = env && typeof env.GH_HOST === 'string' ? env.GH_HOST.trim().toLowerCase() : '';
  return raw.replace(/\/+$/, '');
}

// The canonical host an identity string carries: lowercase, no trailing slash,
// and `www.github.com` folded into `github.com`, so the same server always
// yields the same identity string.
function canonicalHost(raw) {
  const host = String(raw || '').trim().toLowerCase().replace(/\/+$/, '');
  return host === 'www.github.com' ? 'github.com' : host;
}

// The server a scope may target. github.com is gh's default. Any other server
// — GitHub Enterprise Server or `*.ghe.com` — is only reachable CONSISTENTLY
// when GH_HOST names it: repository-scoped commands take a host from GH_REPO,
// but `gh api`/GraphQL (every search and connection read) use the default host,
// which is github.com without GH_HOST. Accepting an enterprise remote without
// GH_HOST would send the same `owner/name` to github.com for those reads, so it
// is refused. With GH_HOST set, the remote must name that EXACT server; a
// different host is the same `owner/name` somewhere else, so it is refused too.
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

// A remote URL as a GitHub `owner/name`, or a fail-closed reason. Scheme URLs
// are read through `URL`; the scp-like form (`git@host:owner/name.git`) is
// parsed by its own shape. `file://`, absolute/relative paths and Windows drive
// paths are LOCAL remotes and are never GitHub names; a percent-encoded path is
// rejected outright because no GitHub identifier contains `%`.
function parseRemoteRepo(raw, env, remote) {
  const url = String(raw || '').trim();
  if (url === '') return scopeFailure(remote, 'has no URL');
  let authority = '';
  let pathPart = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return scopeFailure(remote, 'is not a usable URL');
    }
    if (parsed.protocol === 'file:') return scopeFailure(remote, 'is a local path, not a GitHub repository');
    authority = parsed.host.toLowerCase();
    pathPart = parsed.pathname;
  } else if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
    return scopeFailure(remote, 'is a local path, not a GitHub repository');
  } else {
    const scp = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!scp) return scopeFailure(remote, 'is not a GitHub repository URL');
    authority = scp[1].toLowerCase();
    pathPart = scp[2];
  }
  if (authority === '') return scopeFailure(remote, 'is not a GitHub repository URL');
  const verdict = hostVerdict(authority, env);
  if (verdict.ok !== true) return scopeFailure(remote, verdict.error);
  if (pathPart.includes('%')) return scopeFailure(remote, 'names an invalid GitHub repository');
  const segments = pathPart.split('/').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length !== 2) return scopeFailure(remote, 'names an invalid GitHub repository');
  const owner = segments[0];
  const name = segments[1].replace(/\.git$/i, '');
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(name)
    || name === '.' || name === '..') {
    return scopeFailure(remote, 'names an invalid GitHub repository');
  }
  const host = canonicalHost(authority);
  const nameWithOwner = `${owner}/${name}`;
  // The identity gh accepts for both GH_REPO and `-R`: `[HOST/]OWNER/REPO`.
  // Carrying the host is what keeps the same owner/name on two servers apart.
  return { ok: true, host, nameWithOwner, identity: `${host}/${nameWithOwner}` };
}

// A caller-supplied identity (`GH_REPO`, or the identity a caller already
// displayed) normalized to the HOST-QUALIFIED `<host>/<owner>/<repo>` form.
// A bare `owner/name` is qualified with the host gh would use (GH_HOST, else
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

// Read the checkout's own facts in a fixed number of commands: the local
// configuration (which is also the invalidation hash), the current branch, and
// — once a head remote is selected — that remote's push URL (git expands
// `insteadOf`, so an alias remote still resolves to its real URL).
// A nonzero `git config --local` exit is NOT proof that this is no repository.
// Only a checkout git itself confirms is neither a repository ("not a git
// repository", with the child locale pinned) keeps the unchanged baseline;
// every other failure — a corrupt or unreadable configuration, dubious
// ownership, a broken `.git` — fails closed instead of falling back to gh's
// base resolution. The probe runs only after the config read already failed.
const NOT_A_REPOSITORY_PATTERN = /not a git repository/i;
const CONFIG_UNREADABLE = "cannot read this checkout's git configuration";

async function repositoryStatusAfterConfigFailure(cwd) {
  const probe = await runGit(['rev-parse', '--git-dir'], { cwd });
  if (probe.error) return { ok: false, error: CONFIG_UNREADABLE };
  if (probe.status === 0) return { ok: false, error: CONFIG_UNREADABLE };
  if (NOT_A_REPOSITORY_PATTERN.test(probe.stderr || '')) return { ok: true, repository: false };
  return { ok: false, error: CONFIG_UNREADABLE };
}

async function readCheckoutFacts(cwd) {
  const config = await runGit(['config', '--local', '--null', '--list'], { cwd });
  if (config.error) return { ok: false, error: CONFIG_UNREADABLE };
  if (config.status !== 0) {
    const repository = await repositoryStatusAfterConfigFailure(cwd);
    if (repository.ok !== true) return repository;
    return { ok: true, facts: null };
  }
  const branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  const branchName = branch && branch.status === 0 ? branch.stdout.trim() : '';
  return {
    ok: true,
    facts: {
      config: parseConfigList(config.stdout),
      fingerprint: configFingerprint(config.stdout),
      branch: branchName || null,
    },
  };
}

async function resolveCheckoutRepo(cwd, env) {
  const read = await readCheckoutFacts(cwd);
  if (read.ok !== true) return read;
  const facts = read.facts;
  if (!facts) return { ok: true, nameWithOwner: null, fingerprint: null };
  const selection = selectHeadRemote(facts.config, facts.branch);
  if (selection.ok !== true) return { ...selection, fingerprint: facts.fingerprint };
  if (!selection.remote) {
    return { ok: true, identity: null, host: null, nameWithOwner: null, fingerprint: facts.fingerprint };
  }
  const url = await runGit(['remote', 'get-url', '--push', selection.remote], { cwd });
  if (url.error || url.status !== 0) {
    return {
      ok: false,
      error: `cannot read the URL of checkout remote "${selection.remote}"`,
      fingerprint: facts.fingerprint,
    };
  }
  const repo = parseRemoteRepo(url.stdout, env, selection.remote);
  if (repo.ok !== true) return { ...repo, fingerprint: facts.fingerprint };
  return {
    ok: true,
    identity: repo.identity,
    host: repo.host,
    nameWithOwner: repo.nameWithOwner,
    remote: selection.remote,
    fingerprint: facts.fingerprint,
  };
}

// A caller that names its checkout (`cwd`) is the only case the fork scope is
// read for: a call that names none keeps gh's own default resolution exactly as
// before, so the override never invents a checkout nobody asked about.
function namesCheckout(opts) {
  return typeof opts.cwd === 'string' && opts.cwd.length > 0;
}

// Cache key: the checkout AND the host gh would target (GH_HOST), so a scope
// resolved for one server is never reused for another.
function repoScopeKey(cwd, env) {
  return `${cwd}\n${ghHostOf(env)}`;
}

const repoScopes = new Map();

async function currentFingerprint(cwd) {
  const res = await runGit(['config', '--local', '--null', '--list'], { cwd });
  if (res.error || res.status !== 0) return null;
  return configFingerprint(res.stdout);
}

// The repository this checkout belongs to (its fork, never the upstream `gh`
// resolves as a base): `{ok:true, identity, host, nameWithOwner, remote}` with a
// HOST-QUALIFIED identity, `{ok:true, identity:null}` when there is nothing to
// override (a single-remote checkout keeps gh's resolution), or
// `{ok:false, error}` when the checkout's own remote cannot be proven to be a
// GitHub repository or the selection is ambiguous. A read may reuse it for at
// most the short fresh window; after that every reuse is VALIDATED against the
// checkout's live git configuration hash, so a changed remote is followed
// quickly. `opts.fresh` bypasses the cache entirely, and the write path always
// asks fresh, so no action ever runs on a cached scope.
async function checkoutRepoScope(opts = {}) {
  const env = opts.env || process.env;
  // An explicit GH_REPO is the caller's scope and is never second-guessed
  // (a caller that already displayed a repository pins it itself, host
  // included).
  if (env && typeof env.GH_REPO === 'string' && env.GH_REPO.trim() !== '') {
    return { ok: true, identity: null, host: null, nameWithOwner: null };
  }
  let cwd;
  try {
    cwd = path.resolve(typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : process.cwd());
  } catch {
    return { ok: true, identity: null, host: null, nameWithOwner: null };
  }
  const key = repoScopeKey(cwd, env);
  const entry = repoScopes.get(key);
  if (opts.fresh !== true && entry) {
    if (entry.settled !== true) return entry.run;
    const now = Date.now();
    const sinceUse = typeof entry.at === 'number' ? now - entry.at : Number.POSITIVE_INFINITY;
    const sinceResolve = typeof entry.resolvedAt === 'number' ? now - entry.resolvedAt : Number.POSITIVE_INFINITY;
    if (sinceUse < REPO_SCOPE_FRESH_WINDOW_MS) return entry.result;
    const current = await currentFingerprint(cwd);
    // The max age counts from the RESOLUTION, never from the last use: local
    // configuration outside `--local` (a global `insteadOf`) cannot move the
    // hash, so a sliding window would mask it forever.
    if (sinceResolve < REPO_SCOPE_MAX_AGE_MS && current !== null && current === entry.fingerprint) {
      entry.at = Date.now();
      return entry.result;
    }
  }
  const next = { settled: false, fingerprint: null, result: null, at: Date.now(), resolvedAt: null, run: null };
  next.run = resolveCheckoutRepo(cwd, env)
    .catch(() => ({ ok: false, error: "cannot resolve the checkout's own repository" }))
    .then((result) => {
      next.settled = true;
      next.result = result;
      next.fingerprint = result && typeof result.fingerprint === 'string' ? result.fingerprint : null;
      next.at = Date.now();
      next.resolvedAt = next.at;
      return result;
    });
  if (repoScopes.size >= REPO_SCOPE_CACHE_MAX && !repoScopes.has(key)) {
    repoScopes.delete(repoScopes.keys().next().value);
  }
  repoScopes.set(key, next);
  return next.run;
}

// The env a gh child runs with: the caller's own environment plus the scope as
// GH_REPO, which every repo-resolving gh command honours (`gh repo view`
// ignores it and is overridden in resolution instead). A scope ALWAYS wins over
// an ambient GH_REPO: an identity a reader already displayed is the pin, and an
// environment variable must never move a read or a write to another repository
// behind its back.
function scopedEnv(opts, scope) {
  if (!scope) return opts.env;
  const base = opts.env || process.env || {};
  return { ...base, GH_REPO: scope };
}

// Default runner over execFile: argv array, no shell, bounded timeout.
// Always resolves to {status, stdout, stderr, error}; never throws.
function defaultRunner(bin, argv, runOpts = {}) {
  const timeout = Number.isFinite(runOpts.timeoutMs) && runOpts.timeoutMs > 0
    ? Math.floor(runOpts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    const spawnOpts = {
      cwd: runOpts.cwd,
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    };
    if (runOpts.env) spawnOpts.env = runOpts.env;
    try {
      child = execFile(bin, argv, spawnOpts, (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          return;
        }
        // ENOENT / spawn failures carry no status: keep the signal text so
        // callers can name the missing binary.
        if (err.code === 'ENOENT' || /ENOENT/i.test(err.message || '')) {
          resolve({
            status: null, stdout: String(stdout || ''), stderr: String(stderr || ''),
            error: `spawn ${bin} ENOENT: gh CLI is not available`,
          });
          return;
        }
        if (err.killed) {
          resolve({
            status: null, stdout: String(stdout || ''), stderr: String(stderr || ''),
            error: `gh timed out after ${timeout}ms`,
          });
          return;
        }
        // Non-zero exit: status plus whatever the command printed.
        const status = typeof err.code === 'number' ? err.code : null;
        resolve({ status, stdout: String(stdout || ''), stderr: String(stderr || ''), error: null });
      });
    } catch (err) {
      resolve({
        status: null, stdout: '', stderr: '',
        error: (err && err.message) || String(err),
      });
      return;
    }
    if (!child) {
      resolve({ status: null, stdout: '', stderr: '', error: 'gh runner produced no child process' });
    }
  });
}

// The scope a call runs with, as a host-qualified `GH_REPO` value or null.
// An explicit scope is validated against the caller's live environment first
// (host mismatch or an invalid identity fails closed before any spawn); a call
// that names a checkout resolves the checkout's own repository; anything else
// keeps gh's default resolution.
async function scopeForCall(opts) {
  if (opts.scope !== undefined) {
    if (opts.scope === null || opts.scope === '') return { ok: true, identity: null };
    const pinned = normalizeScopeIdentity(opts.scope, opts.env || process.env);
    if (pinned.ok !== true) return { ok: false, error: `the pinned repository ${pinned.error}` };
    return { ok: true, identity: pinned.identity };
  }
  if (namesCheckout(opts)) return checkoutRepoScope({ ...opts, fresh: opts.freshScope === true });
  return { ok: true, identity: null };
}

async function runGh(argv, opts = {}) {
  const bin = ghBinary(opts);
  const scopeResult = await scopeForCall(opts);
  // Fail closed: when the checkout's own repository cannot be proven, no gh
  // command runs at all. A read or a write must never fall back to a guessed
  // repository (gh's base answer included).
  if (scopeResult.ok !== true) {
    return { bin, argv, status: null, stdout: '', stderr: '', error: scopeResult.error };
  }
  const env = scopedEnv(opts, scopeResult.identity || null);
  const runOpts = { cwd: opts.cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS };
  if (env) runOpts.env = env;
  const run = runnerOverride || defaultRunner;
  let raw;
  try {
    raw = await run(bin, argv, runOpts);
  } catch (err) {
    return {
      bin, argv, status: null, stdout: '', stderr: '',
      error: (err && err.message) || String(err),
    };
  }
  const outcome = raw && typeof raw === 'object' ? raw : {};
  return {
    bin,
    argv,
    status: typeof outcome.status === 'number' ? outcome.status : null,
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
    stderr: typeof outcome.stderr === 'string' ? outcome.stderr : '',
    error: outcome.error === null || outcome.error === undefined ? null : String(outcome.error),
  };
}

// Failure text for a non-zero `gh` exit: prefer stderr (where gh explains
// auth and resolution problems), fall back to the bare status.
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

// `reactionGroups` (the field gh actually returns) sums to a total with
// the THUMBS_UP share kept as plusOne. Unknown shapes sum to zero rather
// than failing the whole call.
function sumReactions(reactionGroups) {
  let total = 0;
  let plusOne = 0;
  if (!Array.isArray(reactionGroups)) return { total: 0, plusOne: 0 };
  for (const group of reactionGroups) {
    if (!group || typeof group !== 'object') continue;
    const count = group && typeof group === 'object'
      ? (group.users && typeof group.users.totalCount === 'number'
        ? group.users.totalCount
        : (typeof group.reactors === 'object' && group.reactors !== null
          && typeof group.reactors.totalCount === 'number'
          ? group.reactors.totalCount
          : (typeof group.totalCount === 'number' ? group.totalCount : 0)))
      : 0;
    total += count;
    if (group.content === 'THUMBS_UP') plusOne += count;
  }
  return { total, plusOne };
}

function asLabel(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  return {
    name: typeof entry.name === 'string' ? entry.name : '',
    color: typeof entry.color === 'string' ? entry.color : '',
    description: typeof entry.description === 'string' ? entry.description : '',
  };
}

function normalizeIssue(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const comments = Array.isArray(entry.comments) ? entry.comments : [];
  return {
    number: typeof entry.number === 'number' ? entry.number : -1,
    title: typeof entry.title === 'string' ? entry.title : '',
    state: typeof entry.state === 'string' ? entry.state.toLowerCase() : '',
    stateReason: typeof entry.stateReason === 'string' ? entry.stateReason : '',
    author: asLogin(entry.author),
    // `assignees` arrives only on the detail fetch (the list field set
    // omits it, so list rows keep their shape); entries are {login}
    // objects like `author`, normalized through the same helper.
    assignees: Array.isArray(entry.assignees)
      ? entry.assignees.map(asLogin).filter((name) => name !== '')
      : [],
    // `gh issue list/view --json` has no authorAssociation field
    // (verified: `Unknown JSON field`); the honest default is ''.
    authorAssociation: typeof entry.authorAssociation === 'string' ? entry.authorAssociation : '',
    labels: Array.isArray(entry.labels) ? entry.labels.map(asLabel) : [],
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    commentsCount: Number.isInteger(entry.commentsTotal) && entry.commentsTotal >= 0
      ? entry.commentsTotal
      : comments.length,
    reactions: sumReactions(entry.reactionGroups || entry.reactions),
    url: typeof entry.url === 'string' ? entry.url : '',
    body: typeof entry.body === 'string' ? entry.body : '',
    // `gh` exposes no isPullRequest JSON field for issues; issues listed
    // here are issues, so the honest default is false.
    isPullRequest: entry.isPullRequest === true,
  };
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

function normalizeStateFilter(state) {
  if (state === undefined || state === null || state === '') return 'open';
  const lowered = String(state).toLowerCase();
  if (lowered === 'open' || lowered === 'closed' || lowered === 'all') return lowered;
  return null;
}

function normalizePaging(page, pageSize) {
  let p = Number(page);
  if (!Number.isFinite(p) || p < 1) p = 1;
  p = Math.floor(p);
  let s = Number(pageSize);
  if (!Number.isFinite(s) || s < 1) s = DEFAULT_PAGE_SIZE;
  s = Math.min(Math.floor(s), MAX_PAGE_SIZE);
  return { page: p, pageSize: s };
}

// Authenticated identity plus the repository in scope.
// `{ok:true, login, nameWithOwner}`; a repository that cannot be resolved
// still reports the login with `nameWithOwner: null`.
async function ghStatus(opts = {}) {
  const user = await runGh(['api', 'user'], opts);
  if (user.error) return { ok: false, error: user.error };
  if (user.status !== 0) return { ok: false, error: exitError(user, 'gh is not authenticated (run `gh auth login`)') };
  const parsedUser = parseJsonBody(user.stdout, 'gh api user');
  if (!parsedUser.ok) return parsedUser;
  const login = parsedUser.doc && typeof parsedUser.doc.login === 'string' ? parsedUser.doc.login : '';
  if (!login) return { ok: false, error: 'gh api user returned an unexpected shape' };
  const repo = await runGh(['repo', 'view', '--json', 'nameWithOwner'], opts);
  if (repo.error || repo.status !== 0) return { ok: true, login, nameWithOwner: null };
  const parsedRepo = parseJsonBody(repo.stdout, 'gh repo view');
  if (!parsedRepo.ok) return { ok: true, login, nameWithOwner: null };
  const reported = parsedRepo.doc && typeof parsedRepo.doc.nameWithOwner === 'string'
    ? parsedRepo.doc.nameWithOwner
    : null;
  // An explicit scope is the identity a caller already showed; `null` means
  // gh's own resolution. It is normalized so a host-qualified pin answers the
  // `owner/name` every consumer expects, and an invalid pin fails closed.
  if (opts.scope !== undefined) {
    if (!opts.scope) return { ok: true, login, nameWithOwner: reported };
    const pinned = normalizeScopeIdentity(opts.scope, opts.env || process.env);
    if (pinned.ok !== true) return { ok: false, error: pinned.error };
    return { ok: true, login, nameWithOwner: pinned.nameWithOwner };
  }
  const scope = namesCheckout(opts) ? await checkoutRepoScope(opts) : { ok: true, identity: null };
  if (scope.ok !== true) return { ok: false, error: scope.error };
  return { ok: true, login, nameWithOwner: (scope.ok === true && scope.nameWithOwner) || reported };
}

async function repoInfo(opts = {}) {
  const resolved = await repoNameWithOwner(opts);
  if (!resolved.ok) return resolved;
  const user = await runGh(['api', 'user'], opts);
  let viewer = null;
  if (!user.error && user.status === 0) {
    const parsedUser = parseJsonBody(user.stdout, 'gh api user');
    if (parsedUser.ok && parsedUser.doc && typeof parsedUser.doc.login === 'string') {
      viewer = parsedUser.doc.login;
    }
  }
  return { ok: true, nameWithOwner: resolved.nameWithOwner, viewer };
}

// gh's OWN answer for the checkout, with no scope override applied. It is the
// effective repository of a checkout that has no fork remote of its own (a
// caller pins this identity for its lifetime) and the fallback of
// `repoNameWithOwner`. `gh repo view` ignores GH_REPO, so a caller-supplied
// GH_REPO is handled by the caller, never guessed here.
async function reportedRepoName(opts = {}) {
  // A caller that wants gh's OWN answer with no checkout scope passes
  // `scope: null` explicitly; any other `opts` behaves exactly like every
  // other client call (the checkout scope is resolved first, so a resolution
  // failure still prevents this gh call).
  const repo = await runGh(['repo', 'view', '--json', 'nameWithOwner'], opts);
  if (repo.error) return { ok: false, error: repo.error };
  if (repo.status !== 0) return { ok: false, error: exitError(repo, 'cannot resolve the repository') };
  const parsedRepo = parseJsonBody(repo.stdout, 'gh repo view');
  if (!parsedRepo.ok) return parsedRepo;
  const reported = parsedRepo.doc && typeof parsedRepo.doc.nameWithOwner === 'string'
    ? parsedRepo.doc.nameWithOwner
    : '';
  if (!reported) return { ok: false, error: 'gh repo view returned an unexpected shape' };
  return { ok: true, nameWithOwner: reported };
}

// The repository in scope, in one call. Split out of `repoInfo` so a GraphQL
// read does not also pay for the identity lookup.
async function repoNameWithOwner(opts = {}) {
  // An explicit scope is the identity a caller already showed: reads and
  // writes bound to it stay on that repository even after the checkout's remote
  // moves, instead of silently following it. It is normalized to `owner/name`
  // for the GraphQL consumers and validated before anything runs; `null` means
  // gh's own resolution.
  if (opts.scope !== undefined) {
    if (opts.scope === null || opts.scope === '') {
      const reported = await reportedRepoName(opts);
      if (reported.ok !== true) return reported;
      return { ok: true, nameWithOwner: reported.nameWithOwner };
    }
    const pinned = normalizeScopeIdentity(opts.scope, opts.env || process.env);
    if (pinned.ok !== true) return { ok: false, error: pinned.error };
    return { ok: true, nameWithOwner: pinned.nameWithOwner };
  }
  const reportedRead = await reportedRepoName(opts);
  if (reportedRead.ok !== true) return reportedRead;
  // Otherwise the checkout's own repository wins over gh's base answer (fork
  // scope); a checkout that resolves to one repository is untouched. An
  // unresolvable checkout remote fails here instead of being replaced by gh's
  // base answer.
  const scope = namesCheckout(opts) ? await checkoutRepoScope(opts) : { ok: true, identity: null };
  if (scope.ok !== true) return { ok: false, error: scope.error };
  return { ok: true, nameWithOwner: scope.nameWithOwner || reportedRead.nameWithOwner };
}

// The list order belongs to the QUERY, never to a JavaScript re-sort:
// `gh issue list --search` takes the search syntax, so the
// most-recently-updated ordering is one qualifier on the caller's query.
// A caller that already passed an explicit `sort:` keeps it — a second
// qualifier would be ambiguous, so theirs wins.
function withLastUpdatedSort(search) {
  if (/\bsort:/i.test(search)) return search;
  return search ? `${search} ${LAST_UPDATED_SORT}` : LAST_UPDATED_SORT;
}

// Paged listing. `gh issue list` has no offset flag, so the call fetches
// ONCE up to the bound and slices the requested page in memory; `total`
// is the fetched count and `truncated` is true exactly when it reached
// the bound (a lower bound, never the exact total). `opts.fetchMax`
// overrides the bound (default LIST_FETCH_MAX) so tests can exercise
// truncation without 500 fixtures. `wholeResult` returns the ENTIRE fetched
// set instead of one page, for a caller whose bound is its own completeness
// proof (a caller's buckets, bounded by the open snapshot's count):
// slicing a page there would throw away rows already downloaded. The list
// fetch omits `body` (the detail pane reads it through `getIssue`); every
// other row field the view's list uses still arrives, so list rows render
// unchanged. A caller that needs the whole open set uses `listAllOpenIssues`
// instead: a page sliced from one bounded fetch is not every page.
async function listIssues({ query = '', state = 'open', page = 1, pageSize = DEFAULT_PAGE_SIZE, wholeResult = false } = {}, opts = {}) {
  const stateFilter = normalizeStateFilter(state);
  if (stateFilter === null) return { ok: false, error: `invalid state ${JSON.stringify(state)}: want open, closed or all` };
  const paging = normalizePaging(page, pageSize);
  const search = withLastUpdatedSort(typeof query === 'string' ? query.trim() : '');
  const rawMax = opts && opts.fetchMax != null ? Number(opts.fetchMax) : LIST_FETCH_MAX;
  const bound = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : LIST_FETCH_MAX;
  const fetchLimit = bound;
  const argv = ['issue', 'list', '--state', stateFilter, '--limit', String(fetchLimit), '--json', ISSUE_LIST_JSON_FIELDS];
  if (search) argv.splice(4, 0, '--search', search);
  const res = await runGh(argv, opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, 'gh issue list failed') };
  const parsed = parseJsonBody(res.stdout, 'gh issue list');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.doc)) return { ok: false, error: 'gh issue list returned an unexpected shape' };
  const normalized = parsed.doc.map(normalizeIssue);
  // The list never asked for `assignees`: drop the normalized default so
  // list rows keep their exact shape (only getIssue carries assignees).
  for (const item of normalized) delete item.assignees;
  const total = normalized.length;
  const truncated = total >= bound;
  if (wholeResult === true) {
    return { ok: true, issues: normalized, total, truncated, page: paging.page, pageSize: paging.pageSize };
  }
  const start = (paging.page - 1) * paging.pageSize;
  return {
    ok: true,
    issues: normalized.slice(start, start + paging.pageSize),
    total,
    truncated,
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

// The GraphQL connection carries the same row facts in different shapes:
// `labels` and `comments` are connections. Reshape them into the payload
// `normalizeIssue` understands, handing the comment count over as a number so
// the snapshot never materializes comment arrays it does not need.
function graphqlIssueRow(node) {
  const entry = node && typeof node === 'object' ? node : {};
  const labelNodes = entry.labels && typeof entry.labels === 'object' && Array.isArray(entry.labels.nodes)
    ? entry.labels.nodes
    : [];
  const commentsTotal = entry.comments && typeof entry.comments === 'object'
    && Number.isInteger(entry.comments.totalCount)
    ? entry.comments.totalCount
    : 0;
  return { ...entry, labels: labelNodes, comments: [], commentsTotal };
}

// EVERY open issue of the repository, read through the GraphQL connection.
// Each page is validated before it is trusted: GraphQL errors fail the whole
// snapshot, `hasNextPage` must come with a non-empty cursor this loop has not
// used yet, and the terminal page must have delivered exactly `totalCount`
// distinct issues. Anything short of that is a failed snapshot — never a
// partial set a caller could read as "these issues are gone". `opts` reaches
// `runGh`, so each page also runs under its bounded timeout.
async function listAllOpenIssues(opts = {}) {
  const resolved = await repoNameWithOwner(opts);
  if (!resolved.ok) return resolved;
  const slash = resolved.nameWithOwner.indexOf('/');
  if (slash <= 0 || slash === resolved.nameWithOwner.length - 1) {
    return { ok: false, error: `gh repo view returned an unexpected shape: ${JSON.stringify(resolved.nameWithOwner)}` };
  }
  const owner = resolved.nameWithOwner.slice(0, slash);
  const name = resolved.nameWithOwner.slice(slash + 1);
  const issues = [];
  const seen = new Set();
  const cursors = new Set();
  let cursor = null;
  for (let page = 1; page <= SNAPSHOT_MAX_PAGES; page += 1) {
    const argv = [
      'api', 'graphql',
      '-f', `query=${OPEN_ISSUES_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `first=${GRAPHQL_PAGE_SIZE}`,
    ];
    if (cursor !== null) argv.push('-F', `cursor=${cursor}`);
    const res = await runGh(argv, opts);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, 'gh api graphql failed') };
    const parsed = parseJsonBody(res.stdout, 'gh api graphql');
    if (!parsed.ok) return parsed;
    const doc = parsed.doc;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: 'gh api graphql returned an unexpected shape' };
    }
    if (Array.isArray(doc.errors) && doc.errors.length > 0) {
      const message = doc.errors[0] && typeof doc.errors[0].message === 'string'
        ? doc.errors[0].message
        : 'unknown GraphQL error';
      return { ok: false, error: `gh api graphql failed: ${message}` };
    }
    const repository = doc.data && typeof doc.data === 'object' ? doc.data.repository : null;
    const connection = repository && typeof repository === 'object' ? repository.issues : null;
    if (!connection || typeof connection !== 'object' || !Array.isArray(connection.nodes)) {
      return { ok: false, error: 'gh api graphql returned an unexpected shape' };
    }
    const total = connection.totalCount;
    if (!Number.isInteger(total) || total < 0) {
      return { ok: false, error: 'gh api graphql returned no open-issue total' };
    }
    for (const node of connection.nodes) {
      const row = graphqlIssueRow(node);
      if (!Number.isInteger(row.number) || row.number <= 0) {
        return { ok: false, error: 'gh api graphql returned an issue without a number' };
      }
      // A duplicate adds nothing and would make the terminal count a lie; the
      // count check below catches the shortfall it causes.
      if (seen.has(row.number)) continue;
      seen.add(row.number);
      issues.push(normalizeIssue(row));
    }
    const pageInfo = connection.pageInfo && typeof connection.pageInfo === 'object' ? connection.pageInfo : {};
    if (pageInfo.hasNextPage !== true) {
      if (issues.length !== total) {
        return { ok: false, error: `gh api graphql returned ${issues.length} of ${total} open issues; the snapshot is incomplete` };
      }
      return { ok: true, issues, total, pages: page };
    }
    const endCursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : '';
    if (endCursor === '') return { ok: false, error: 'gh api graphql reported another page without a cursor' };
    if (cursors.has(endCursor)) {
      return { ok: false, error: `gh api graphql repeated the cursor ${endCursor}; the snapshot cannot advance` };
    }
    cursors.add(endCursor);
    cursor = endCursor;
  }
  return { ok: false, error: `could not page through every open issue: stopped after ${SNAPSHOT_MAX_PAGES} pages` };
}

// A non-zero `gh` exit caused by the issue NOT EXISTING is the one failure a
// caller may act on destructively (drop a stored association); every other
// failure leaves the question open. Authentication, permission and transport
// wording always wins over the not-found patterns, because a private
// repository answers 404 for an issue the reader merely cannot see. Only
// ISSUE-specific wording is proof: a repository-level `Not Found (HTTP 404)`
// names no issue and is the answer for an inaccessible or renamed repository,
// so it never justifies dropping a stored number.
const NOT_FOUND_PATTERN = /could not resolve to an? (?:issue|pull request)|no (?:such|matching) issue/i;
const UNVERIFIABLE_PATTERN = /401|403|bad credentials|authenticat|permission|forbidden|saml|enoent|timed out|timeout|dial tcp|no such host|connection refused|network/i;

function issueViewFailure(res, number) {
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  const notFound = typeof res.status === 'number' && res.status !== 0
    && !UNVERIFIABLE_PATTERN.test(text)
    && NOT_FOUND_PATTERN.test(text);
  return {
    ok: false,
    error: exitError(res, `cannot view issue #${number}`),
    status: res.status,
    notFound,
  };
}

async function getIssue(number, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer`, status: null, notFound: false };
  const res = await runGh(['issue', 'view', String(number), '--json', ISSUE_DETAIL_JSON_FIELDS], opts);
  if (res.error) return { ok: false, error: res.error, status: null, notFound: false };
  if (res.status !== 0) return issueViewFailure(res, number);
  const parsed = parseJsonBody(res.stdout, `gh issue view ${number}`);
  if (!parsed.ok) return parsed;
  if (!parsed.doc || typeof parsed.doc !== 'object' || typeof parsed.doc.number !== 'number') {
    return { ok: false, error: `gh issue view ${number} returned an unexpected shape` };
  }
  const rawComments = Array.isArray(parsed.doc.comments) ? parsed.doc.comments : [];
  const issue = normalizeIssue(parsed.doc);
  if (opts.includeMetadata === true) {
    const metadata = await getIssueMetadata(number, opts);
    if (metadata.ok) {
      const { ok: _ok, ...fields } = metadata;
      Object.assign(issue, fields);
    } else {
      issue.permissions = repositoryEditPermissions(null);
      issue.metadataError = metadata.error;
    }
  }
  return {
    ok: true,
    issue,
    comments: rawComments.map((entry, index) => normalizeComment(entry, index)),
  };
}


// These page helpers retain server search semantics instead of inferring
// author/assignee/involvement buckets from incomplete local metadata.
const PAGE_ISSUE_FIELDS = `number title state stateReason url createdAt updatedAt
  author { login } labels(first: 50) { nodes { name color description } }
  comments { totalCount } reactionGroups { content users { totalCount } }`;
const ISSUE_PAGE_QUERY = `query($search: String!, $first: Int!, $cursor: String) {
  search(query: $search, type: ISSUE, first: $first, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor }
    edges { cursor node { ... on Issue { ${PAGE_ISSUE_FIELDS} } } }
  }
}`;

async function feedbackGraphql(query, fields, opts) {
  const argv = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) argv.push('-F', `${name}=${value}`);
  }
  const result = await runGh(argv, opts);
  if (result.error) return { ok: false, error: result.error };
  if (result.status !== 0) return { ok: false, error: exitError(result, 'GitHub query failed') };
  const parsed = parseJsonBody(result.stdout, 'GitHub query');
  if (!parsed.ok) return parsed;
  if (Array.isArray(parsed.doc?.errors) && parsed.doc.errors.length > 0) {
    return { ok: false, error: parsed.doc.errors[0]?.message || 'GitHub query failed' };
  }
  if (!parsed.doc?.data || typeof parsed.doc.data !== 'object') {
    return { ok: false, error: 'GitHub query returned no data' };
  }
  return { ok: true, data: parsed.doc.data };
}

async function feedbackRepository(opts) {
  const repo = await repoNameWithOwner(opts);
  if (!repo.ok) return repo;
  const parts = repo.nameWithOwner.split('/');
  if (parts.length !== 2 || !parts.every((part) => part && !/\s/.test(part))) {
    return { ok: false, error: 'GitHub returned an invalid repository name' };
  }
  return { ok: true, owner: parts[0], name: parts[1], fullName: repo.nameWithOwner };
}

async function getIssuePage(params = {}, opts = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid issue page' };
  const { query = '', after = null, first = DEFAULT_PAGE_SIZE } = params;
  if (!Number.isInteger(first) || first < 1 || first > 1000
    || typeof query !== 'string' || (after !== null && (typeof after !== 'string' || !after))) {
    return { ok: false, error: 'invalid issue page: first must be 1..1000 and cursor must be a non-empty string or null' };
  }
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const search = withLastUpdatedSort(`repo:${repo.fullName} is:issue is:open ${query}`.trim());
  const issues = [];
  const seen = new Set();
  const rowCursors = new Set(after === null ? [] : [after]);
  const cursors = new Set(after === null ? [] : [after]);
  let cursor = after;
  let total = 0;
  let hasNextPage = false;
  while (issues.length < first) {
    const count = Math.min(MAX_PAGE_SIZE, first - issues.length);
    const res = await feedbackGraphql(ISSUE_PAGE_QUERY, { search, first: count, cursor }, opts);
    if (!res.ok) return res;
    const page = res.data.search;
    if (!Array.isArray(page?.edges) || !Number.isInteger(page.issueCount) || page.issueCount < 0
      || typeof page.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid issue page' };
    }
    // GitHub search cannot page beyond 1000 matches. Never advertise a full
    // result set when its server-side limit makes that impossible.
    if (page.issueCount > 1000) return { ok: false, error: 'GitHub issue search exceeds 1000 matches; narrow the filter', truncated: true };
    total = page.issueCount;
    if (page.edges.length > count) return { ok: false, error: 'GitHub exceeded the requested issue page size' };
    for (const edge of page.edges) {
      if (typeof edge?.cursor !== 'string' || !edge.cursor || !Number.isInteger(edge.node?.number)
        || edge.node.number < 1 || seen.has(edge.node.number) || rowCursors.has(edge.cursor)) {
        return { ok: false, error: 'GitHub returned an invalid issue cursor or duplicate issue' };
      }
      seen.add(edge.node.number);
      rowCursors.add(edge.cursor);
      if (String(edge.node.state).toLowerCase() === 'open') {
        issues.push({ ...normalizeIssue(graphqlIssueRow(edge.node)), cursor: edge.cursor });
      }
    }
    hasNextPage = page.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    const next = page.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next) || page.edges.length === 0) {
      return { ok: false, error: 'GitHub issue pagination did not advance' };
    }
    cursors.add(next);
    // A short server page is still a valid page. Its cursor belongs to the
    // caller; filling it by issuing another request would skip that boundary.
    if (page.edges.length < count) break;
    cursor = next;
  }
  return { ok: true, issues, total, hasNextPage };
}

// The unfiltered `All` bucket reads the repository's own issue
// CONNECTION instead of the search API. GitHub refuses to page a SEARCH result
// set past 1000 matches, while `repository.issues` is cursor-paged to its end,
// reports the exact `totalCount` and gives every edge its own `cursor`. The
// ordering is part of the query (`UPDATED_AT DESC`), so no caller re-sorts, and
// the state filter is an explicit literal: a `closed` read asks for CLOSED and
// is never widened back to OPEN. The literal comes from this fixed whitelist,
// never from caller text.
const CONNECTION_STATE_LITERALS = {
  open: 'states: [OPEN]',
  closed: 'states: [CLOSED]',
  all: 'states: [OPEN, CLOSED]',
};

function issueConnectionQuery(states) {
  return `query($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(${states}, first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { cursor node { ${PAGE_ISSUE_FIELDS} } }
    }
  }
}`;
}

// One cursor page of the UNFILTERED issue connection, in exactly the shape a
// caller's page loader consumes (`{ok, issues, total, hasNextPage}` with a
// per-row `cursor`), so a bucket can switch source without changing its reader.
//
// `state` is explicit — `open` (default, the caller's own scope), `closed` or
// `all` — and maps to a fixed GraphQL `states` literal. There is no search text
// here: `repository.issues` cannot take one, so a non-blank `query` is refused
// rather than silently listed unfiltered; typed searches stay on
// `getIssuePage`, whose 1000-match search cap is real.
//
// `first` is the caller's row budget (1..1000) and is filled by as many 100-row
// server pages as it needs, keeping every row's own cursor. Pages are validated
// before they are trusted: GraphQL errors fail the call, a cursor or issue
// repeated inside one call is an error (a silent drop would make the totals
// lie), and a non-advancing or cursorless `hasNextPage` fails instead of
// looping. A failed continuation page is a FAILURE, never a short page a caller
// could read as the end of the list. `total` is the server's exact `totalCount`
// at request time; the rows are a cursor walk, not a snapshot, so concurrent
// updates can shift what the walk sees.
async function getIssueConnectionPage(params = {}, opts = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid issue page' };
  const { after = null, first = DEFAULT_PAGE_SIZE } = params;
  if (!Number.isInteger(first) || first < 1 || first > 1000
    || (after !== null && (typeof after !== 'string' || !after))) {
    return { ok: false, error: 'invalid issue page: first must be 1..1000 and cursor must be a non-empty string or null' };
  }
  const state = params.state === undefined || params.state === null || params.state === ''
    ? 'open'
    : String(params.state).toLowerCase();
  const states = CONNECTION_STATE_LITERALS[state];
  if (!states) {
    return { ok: false, error: `invalid issue state ${JSON.stringify(params.state)}: want open, closed or all` };
  }
  if (typeof params.query === 'string' && params.query.trim() !== '') {
    return { ok: false, error: 'the issue connection has no search text: pass no query and use getIssuePage for a search' };
  }
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const query = issueConnectionQuery(states);
  const issues = [];
  const seen = new Set();
  const rowCursors = new Set(after === null ? [] : [after]);
  const cursors = new Set(after === null ? [] : [after]);
  let cursor = after;
  let total = 0;
  let hasNextPage = false;
  while (issues.length < first) {
    const count = Math.min(MAX_PAGE_SIZE, first - issues.length);
    const res = await feedbackGraphql(query, { owner: repo.owner, name: repo.name, first: count, cursor }, opts);
    if (!res.ok) return res;
    const connection = res.data.repository && typeof res.data.repository === 'object'
      ? res.data.repository.issues
      : null;
    if (!Array.isArray(connection?.edges) || !Number.isInteger(connection.totalCount)
      || connection.totalCount < 0 || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid issue page' };
    }
    total = connection.totalCount;
    if (connection.edges.length > count) return { ok: false, error: 'GitHub exceeded the requested issue page size' };
    for (const edge of connection.edges) {
      if (typeof edge?.cursor !== 'string' || !edge.cursor || !Number.isInteger(edge.node?.number)
        || edge.node.number < 1 || seen.has(edge.node.number) || rowCursors.has(edge.cursor)) {
        return { ok: false, error: 'GitHub returned an invalid issue cursor or duplicate issue' };
      }
      seen.add(edge.node.number);
      rowCursors.add(edge.cursor);
      issues.push({ ...normalizeIssue(graphqlIssueRow(edge.node)), cursor: edge.cursor });
    }
    hasNextPage = connection.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next) || connection.edges.length === 0) {
      return { ok: false, error: 'GitHub issue pagination did not advance' };
    }
    cursors.add(next);
    // A short server page is still a valid page. Its cursor belongs to the
    // caller; filling it by issuing another request would skip that boundary.
    if (connection.edges.length < count) break;
    cursor = next;
  }
  return { ok: true, issues, total, hasNextPage };
}

function repositoryEditPermissions(role) {
  const edits = ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'].includes(role);
  return {
    canEditLabels: edits,
    canEditAssignees: edits,
    canCreateLabels: ['WRITE', 'MAINTAIN', 'ADMIN'].includes(role),
  };
}

async function getIssueMetadata(number, opts = {}) {
  if (!Number.isInteger(number) || number < 1) return { ok: false, error: 'invalid issue number' };
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      viewerPermission
      issue(number: $number) {
        assignees(first: 100) { nodes { login } pageInfo { hasNextPage } }
        closedByPullRequestsReferences(first: 1, includeClosedPrs: true) { totalCount }
      }
    }
  }`;
  const res = await feedbackGraphql(query, { owner: repo.owner, name: repo.name, number }, opts);
  if (!res.ok) return res;
  const repository = res.data.repository;
  if (!repository?.issue) return { ok: false, error: 'Issue metadata is unavailable' };
  const issue = repository.issue;
  if (!Array.isArray(issue.assignees?.nodes) || issue.assignees.pageInfo?.hasNextPage) {
    return { ok: false, error: 'Issue assignees are unavailable or incomplete' };
  }
  const metadata = {
    ok: true,
    permissions: repositoryEditPermissions(repository.viewerPermission),
    assignees: issue.assignees.nodes.map(asLogin).filter(Boolean),
  };
  const count = issue.closedByPullRequestsReferences?.totalCount;
  if (Number.isInteger(count) && count > 0) metadata.linkedPullRequestCount = count;
  if (!Number.isInteger(count) || count < 0) metadata.metadataError = 'Linked PR metadata is unavailable';
  // Project visibility/scopes are independent of issue triage permissions.
  // A private or unsupported project relation must not disable known rights.
  const relations = await feedbackGraphql(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        projectItems(first: 100) { nodes { project { title url } } pageInfo { hasNextPage } }
      }
    }
  }`, { owner: repo.owner, name: repo.name, number }, opts);
  const related = relations.ok ? relations.data.repository?.issue : null;
  if (!Array.isArray(related?.projectItems?.nodes) || related.projectItems.pageInfo?.hasNextPage) {
    metadata.metadataError = relations.error || 'Project metadata is unavailable or incomplete';
    return metadata;
  }
  const projects = related.projectItems.nodes.map((item) => item?.project)
    .filter((project) => typeof project?.title === 'string' && project.title);
  if (projects.length > 0) metadata.projects = projects.map(({ title, url }) => ({ title, url }));
  return metadata;
}

async function listAssignableUsers(opts = {}) {
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      assignableUsers(first: 100, after: $cursor) {
        nodes { login name } pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  const users = [];
  const logins = new Set();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < SNAPSHOT_MAX_PAGES; page += 1) {
    const res = await feedbackGraphql(query, { owner: repo.owner, name: repo.name, cursor }, opts);
    if (!res.ok) return res;
    const connection = res.data.repository?.assignableUsers;
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid assignable-user page' };
    }
    for (const user of connection.nodes) {
      if (typeof user?.login !== 'string' || !user.login) return { ok: false, error: 'GitHub returned an invalid assignable user' };
      const id = user.login.toLowerCase();
      if (!logins.has(id)) {
        logins.add(id);
        users.push({ login: user.login, name: typeof user.name === 'string' ? user.name : '' });
      }
    }
    if (!connection.pageInfo.hasNextPage) return { ok: true, users };
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next)) return { ok: false, error: 'Assignable-user pagination did not advance' };
    cursors.add(next);
    cursor = next;
  }
  return { ok: false, error: 'Assignable-user pagination exceeded its safety budget' };
}

async function editAssignees(number, changes = {}, opts = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: false, error: 'invalid assignee changes' };
  const { add = [], remove = [] } = changes;
  const valid = (values) => Array.isArray(values) && values.every((value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value));
  if (!Number.isInteger(number) || number < 1 || !valid(add) || !valid(remove)
    || add.some((name) => remove.some((other) => name.toLowerCase() === other.toLowerCase()))) {
    return { ok: false, error: 'invalid assignee changes: supply distinct GitHub logins to add or remove' };
  }
  if (add.length === 0 && remove.length === 0) return { ok: true, changed: false };
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const access = await feedbackGraphql('query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { viewerPermission } }', { owner: repo.owner, name: repo.name }, opts);
  if (!access.ok) return access;
  if (!repositoryEditPermissions(access.data.repository?.viewerPermission).canEditAssignees) {
    return { ok: false, error: 'Repository permission does not allow changing issue assignees' };
  }
  const argv = ['issue', 'edit', String(number)];
  for (const name of new Set(add)) argv.push('--add-assignee', name);
  for (const name of new Set(remove)) argv.push('--remove-assignee', name);
  const result = await runGh(argv, { ...opts, freshScope: true });
  if (result.error) return { ok: false, error: result.error };
  if (result.status !== 0) return { ok: false, error: exitError(result, 'Cannot edit issue assignees') };
  return { ok: true, changed: true };
}

async function listLabels(opts = {}) {
  const res = await runGh(['label', 'list', '--limit', String(LABEL_FETCH_MAX), '--json', LABEL_JSON_FIELDS], opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, 'gh label list failed') };
  const parsed = parseJsonBody(res.stdout, 'gh label list');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.doc)) return { ok: false, error: 'gh label list returned an unexpected shape' };
  return { ok: true, labels: parsed.doc.map(asLabel) };
}

async function createLabel({ name, color, description } = {}, opts = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'label name must be a non-empty string' };
  }
  const argv = ['label', 'create', name];
  if (typeof color === 'string' && color !== '') argv.push('--color', color);
  if (typeof description === 'string' && description !== '') argv.push('--description', description);
  const res = await runGh(argv, { ...opts, freshScope: true });
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot create label ${name}`) };
  return { ok: true, label: { name, color: color || '', description: description || '' } };
}

async function editLabels(number, { add = [], remove = [] } = {}, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  const additions = Array.isArray(add) ? add.filter((entry) => typeof entry === 'string' && entry !== '') : [];
  const removals = Array.isArray(remove) ? remove.filter((entry) => typeof entry === 'string' && entry !== '') : [];
  if (additions.length === 0 && removals.length === 0) return { ok: true };
  const argv = ['issue', 'edit', String(number)];
  for (const name of additions) argv.push('--add-label', name);
  for (const name of removals) argv.push('--remove-label', name);
  const res = await runGh(argv, { ...opts, freshScope: true });
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot edit labels on issue #${number}`) };
  return { ok: true };
}

async function commentIssue(number, body, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  if (typeof body !== 'string' || body.trim() === '') {
    return { ok: false, error: 'comment body must be a non-empty string' };
  }
  const res = await runGh(['issue', 'comment', String(number), '--body', body], { ...opts, freshScope: true });
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot comment on issue #${number}`) };
  return { ok: true };
}

async function setIssueState(number, state, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  const verb = state === 'closed' ? 'close' : (state === 'open' ? 'reopen' : null);
  if (verb === null) return { ok: false, error: `invalid state ${JSON.stringify(state)}: want open or closed` };
  const res = await runGh(['issue', verb, String(number)], { ...opts, freshScope: true });
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot ${verb} issue #${number}`) };
  return { ok: true };
}

module.exports = {
  setGhRunner,
  setGitRunner,
  ghBinary,
  checkoutRepoScope,
  reportedRepoName,
  normalizeScopeIdentity,
  ghStatus,
  repoInfo,
  listIssues,
  listAllOpenIssues,
  getIssue,
  getIssuePage,
  getIssueConnectionPage,
  getIssueMetadata,
  listAssignableUsers,
  editAssignees,
  listLabels,
  createLabel,
  editLabels,
  commentIssue,
  setIssueState,
};
