'use strict';
// T9 (S10): the `bash` command classifier behind the issues rail's forced
// refresh.
//
// Contract under test, through the public surface only:
// - a `bash` command string that mutates a GitHub issue or pull request answers
//   `true`: the `gh issue` verbs create/edit/close/reopen/comment/delete/
//   transfer/develop/lock/unlock, the same for `gh pr` plus merge/review/ready,
//   and a `gh api` call with a POST/PATCH/PUT/DELETE method (spelled `-X`,
//   `-XPOST`, `--method` or `--method=`) or the field flags that make `gh` POST;
// - nothing else answers `true`: read-only verbs (`list`, `view`, `status`,
//   `diff`, `checks`), a bare `gh api` GET, `gh repo view`, plain `git`, and a
//   command that only MENTIONS a mutation inside an argument;
// - every segment of a compound command counts (`&&`, `||`, `|`, `;`, `&` and
//   newlines), and a leading `env`/`VAR=value`/absolute path spelling still
//   names the same `gh` binary;
// - it is a pure decision over text: no child process, no shell, and it never
//   throws — a non-string, an empty string or a command the scanner cannot read
//   is simply `false`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bashMutatesIssuesOrPullRequests } = require('../lib/issues-bash-mutation.js');

const MUTATES = [
  ['gh issue create --title "Broken login" --body "..."', 'gh issue create'],
  ['gh issue edit 12 --add-label bug', 'gh issue edit'],
  ['gh issue close 12', 'gh issue close'],
  ['gh issue reopen 12', 'gh issue reopen'],
  ['gh issue comment 12 --body "fixed in 1.2"', 'gh issue comment'],
  ['gh issue delete 12 --yes', 'gh issue delete'],
  ['gh issue transfer 12 other/repo', 'gh issue transfer'],
  ['gh issue develop 12 --checkout', 'gh issue develop'],
  ['gh issue lock 12', 'gh issue lock'],
  ['gh issue unlock 12', 'gh issue unlock'],
  ['gh pr create --title "Feature" --body "..."', 'gh pr create'],
  ['gh pr edit 3 --add-reviewer me', 'gh pr edit'],
  ['gh pr close 3', 'gh pr close'],
  ['gh pr reopen 3', 'gh pr reopen'],
  ['gh pr merge 3 --squash', 'gh pr merge'],
  ['gh pr comment 3 --body "lgtm"', 'gh pr comment'],
  ['gh pr review 3 --approve', 'gh pr review'],
  ['gh pr ready 3', 'gh pr ready'],
  ['gh pr lock 3', 'gh pr lock'],
  ['gh pr unlock 3', 'gh pr unlock'],
  ['gh api repos/me/project/issues -X POST -f title=one', 'gh api -X POST'],
  ['gh api repos/me/project/issues/12 -X PATCH -f state=closed', 'gh api -X PATCH'],
  ['gh api --method PUT repos/me/project/issues/12', 'gh api --method PUT'],
  ['gh api --method=DELETE repos/me/project/issues/12', 'gh api --method=DELETE'],
  ['gh api -XDELETE repos/me/project/issues/12', 'gh api -XDELETE'],
  ['gh api repos/me/project/issues/12/comments -f body=hi', 'gh api -f implies POST'],
  ['gh api graphql -f query=@mutate.graphql', 'gh api graphql with a field'],
  ['git checkout main && gh issue close 12', 'a compound command'],
  ['gh issue list; gh pr merge 3', 'the second segment'],
  ['echo preparing\ngh issue reopen 12', 'a newline-separated segment'],
  ['(gh pr close 3)', 'a subshell segment'],
  ['/usr/local/bin/gh issue close 12', 'an absolute gh path'],
  ['env GITHUB_TOKEN=x gh issue close 12', 'an env prefix'],
  ['GITHUB_TOKEN=x gh pr merge 3', 'a VAR=value prefix'],
];

const READ_ONLY = [
  ['', 'the empty command'],
  ['   \n\t ', 'whitespace only'],
  ['git status', 'plain git'],
  ['git commit -m "cleanup"', 'a commit'],
  ['gh issue list --limit 20', 'gh issue list'],
  ['gh issue view 12', 'gh issue view'],
  ['gh issue status', 'gh issue status'],
  ['gh pr list', 'gh pr list'],
  ['gh pr view 3', 'gh pr view'],
  ['gh pr diff 3', 'gh pr diff'],
  ['gh pr checks 3', 'gh pr checks'],
  ['gh pr status', 'gh pr status'],
  ['gh api repos/me/project/issues', 'a bare gh api GET'],
  ['gh api -X GET repos/me/project/issues', 'an explicit GET'],
  ['gh api --method HEAD repos/me/project', 'an explicit HEAD'],
  ['gh repo view --json nameWithOwner', 'gh repo view'],
  ['gh auth status', 'gh auth status'],
  ['echo "gh issue close 12"', 'a mutation mentioned inside an argument'],
  ['git commit -m "gh pr merge 3"', 'a mutation inside a commit message'],
  ['grep -rn "gh pr merge" docs/', 'a mutation in a search pattern'],
  ['echo gh pr close', 'a bare mention after echo'],
];

test('S10 (T9): every mutating gh verb answers true', () => {
  for (const [command, label] of MUTATES) {
    assert.equal(bashMutatesIssuesOrPullRequests(command), true, `${label}: ${JSON.stringify(command)}`);
  }
});

test('S10 (T9): nothing else answers true', () => {
  for (const [command, label] of READ_ONLY) {
    assert.equal(bashMutatesIssuesOrPullRequests(command), false, `${label}: ${JSON.stringify(command)}`);
  }
});

test('S10 (T9): a value that is not a command is false, never a throw', () => {
  for (const value of [null, undefined, 42, {}, [], true, { command: 'gh issue close 12' }]) {
    assert.equal(bashMutatesIssuesOrPullRequests(value), false, `answered true for ${JSON.stringify(value)}`);
  }
});
