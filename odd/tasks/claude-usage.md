# Claude usage source for the quota panel

Feature document for ODD `claude-usage`. Specs are the user's own words; tasks are the work units.

## Specs

S1. **Anthropic appears in the quota panel exactly like opencode-go does.** Register a usage source on
   `gentle-pi:usage-source/v1`, so `/gentle:usage`, the status-bar segment and the panel's `r` refresh fetch
   it through the shell's own schedule. Nothing here polls, and nothing here writes host state.

S2. **Claude's peak schedule rides the provider line, like DeepSeek does for opencode-go.** The `plan` slot
   is the existing registry entry `claude` (`05:00-11:00` America/Los_Angeles, Monday to Friday), rendered by
   `panelSchedule`: `peak 2hr` / `off-peak 1d 17hr`. No multiplier is invented: Anthropic publishes none.

S3. **Compatible with a logged-in Anthropic provider and with a Claude bridge, without duplicating entries.**
   The same source serves the provider ids `anthropic` and `claude-bridge`. The panel lists only the providers
   the session actually uses, so one account never becomes two rows; no extra provider id is invented.

S4. **The plan line carries the subscription tier when the source offers it, and only then.** Same slot codex
   uses for `plus`: `max · off-peak 1d 17hr`, or `off-peak 1d 17hr` when no tier is offered. Never guessed.

## Tasks

| ID | Specs | Route | What |
| --- | --- | --- | --- |
| T1 | S1, S3 | writer | `lib/claude-usage.js`: resolve a token (Claude Code credentials file, else the host `apiKey`), `GET` the usage route, parse windows into `ProviderUsage`, report readiness with fixed reason codes only. |
| T2 | S2, S4 | writer | `plan` composition: tier when offered, then `panelSchedule(peakStateFor(providerById('claude'), now), now)`. |
| T3 | S1, S3 | writer | Extension wiring: one emission per served provider id, re-registered on `session_start` like opencode-go. |
| T4 | S1-S4 | writer | `tools/claude-usage.test.js`: fixtures only, no network, no real credentials file. |
| T5 | S1-S4 | writer | `docs/reference.md` section (and the README surface line if the README lists usage sources). |

## Log

L1 (user, verbatim): "agrega provider de antropic a cuotas como lo hiciste para opencode, ahi igual debe salir
como en opencode con deepseek lo del horario peak pero para claude. Ademas que sea compatible si tengo una
logeado provider de antropic o algun bridge de claude como el claude-bridge que tengo (que no los duplique
claro), que obtenga mi sub y muestre ahi, como con la de opencode que agregamos"

L2 (user, verbatim): "igual si es posible, si la api o como la obtenga lo ofrece, como con gpt/codex, que muestre
que sub es, si es la plus u otra, solo si lo ofrece"

L3 (evidence, host contract - /home/jona/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell):
`extensions/gentle-shell.ts:2149` `refreshProvider` accepts any registered `UsageSource` for any provider id
(`if (!source && provider !== CODEX && provider !== NAN) return false`); the token handed to `fetch` is
`ctx.modelRegistry.getApiKeyForProvider(provider)`; `lib/shell-usage.ts:143` already lists `anthropic` as a
supported provider, `:148-153` gives it the pending note "usage arrives with the first response", `:162`
answers any unknown provider (a bridge included) with "no subscription usage for this provider", and the
provider line renders `plan` between the name and the `updated` note. The host's own header parser
(`:322-333`) names the limit `claude` with window labels `5h`/`7d` (18000/604800 s): mirror those names so
a header-driven snapshot and a fetched one draw the same rows.

L4 (decision): tokens are read, never refreshed or written here. An expired credential produces no snapshot
(`unknown` readiness) instead of mutating someone else's credential store.

L5 (research evidence, web - undocumented endpoint, community-verified): usage route
`GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer sk-ant-oat01-...`,
`anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>`, `Accept: application/json`. The
User-Agent is not cosmetic: without it the route rate-limits aggressively (persistent 429). Payload:
`five_hour` and `seven_day` (plus optional `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`),
each `{ utilization: 0-100 float, resets_at: RFC 3339 string }`, each nullable; `extra_usage` optional.
Units are 0-100 here, unlike the message-response headers (`anthropic-ratelimit-unified-<5h|7d>-utilization`
is 0-1, `-reset` is unix seconds). Only an OAuth access token works: a Console `sk-ant-api...` key and a
`setup-token` (no `user:profile` scope) are rejected. Tier: `/api/oauth/profile` offers
`organization.organization_type` and `rate_limit_tier`; the Claude Code credentials file's `claudeAiOauth`
block offers `subscriptionType` (`pro`/`max`/`team`) and `rateLimitTier`. Neither is a stable enum.
Token expiry: `expiresAt` is epoch ms (13 digits) in current builds, epoch s in older ones; refresh rotates
the refresh token single-use, so a third party must never refresh or rewrite that file.

L6 (decision): the tier comes from the credentials file's `subscriptionType`, and only when the token did;
otherwise the plan line carries the schedule alone. No extra `/api/oauth/profile` call: one less undocumented
route to break.

L7 (decision, S3): one emission per served provider id (`anthropic`, `claude-bridge`). The panel lists the
providers the session actually uses, so the same account never grows a second row; when two Claude providers
are genuinely both in scope each shows its own section with the same numbers, and nothing invented appears.

L8 (implementation, T1/T2/T4): `lib/claude-usage.js` reads `claudeAiOauth.accessToken` from
`$CLAUDE_CREDENTIALS_PATH` when set, else `~/.claude/.credentials.json`, and falls back to the host's
`apiKey` only when that token is absent, a Console key or expired (L4); `expiresAt` is normalised by
magnitude (13-digit ms, 10-digit s). `GET /api/oauth/usage` with the L5 headers, `redirect: 'error'`,
`cache: 'no-store'` and an AbortController plus a referenced `setTimeout` cleared in `finally`. `five_hour`
and `seven_day` map to `claude 5h` / `claude 7d` all-or-nothing; `plan` is
`<tier> · panelSchedule(peakStateFor(providerById('claude'), now), now)` with the tier from
`subscriptionType`, printed only when it reads as a plain plan word. `createUsageSource(id)` serves
`anthropic` and `claude-bridge` with exactly `{ schema, provider, pendingNote, fetch }`, and
`extensions/odd-worktree-tools.ts` emits one source per id at load and at every `session_start`.
`tools/claude-usage.test.js` covers it with a `tools/fixtures/claude-credentials.json` document copied into
a temp directory per case: no network, no real credentials file.

L9 (evidence, T4): `node --test tools/claude-usage.test.js` — 23 tests, 23 pass, 0 fail; RED is the same
suite against a copy without `lib/claude-usage.js` (`Cannot find module`, 1 fail). In the full suite,
`tools/opencode-usage-alert.test.js:107` (`registrations.length === 1`) and
`tools/opencode-usage-lifecycle.test.js:40` (`sources.at(-1)` now resolves to a Claude source) fail because
they assume this package registers exactly one usage source; both need a filter on the OpenCode Go payload.

L10 (evidence, T3/T5, surfaces widened by the parent): the two OpenCode suites now select the source they
were written for instead of "the only source in the process" —
`tools/opencode-usage-alert.test.js:106` collects entries whose `payload.provider === 'opencode-go'` before
asserting `length === 1`, and `tools/opencode-usage-lifecycle.test.js:41` pushes only the `opencode-go`
payload into `sources`. No assertion was weakened: the one-source-per-load count, the four contract keys,
the plan schedule and the timer lifecycle still hold. `README.md:110` gains one sentence naming the
`anthropic` / `claude-bridge` source beside the OpenCode Go one. Checks: `env -u
GENTLE_PI_AGENTS_CHILD node --test tools/claude-usage.test.js tools/opencode-usage-alert.test.js
tools/opencode-usage-lifecycle.test.js` → 36 tests, 36 pass, 0 fail; `env -u GENTLE_PI_AGENTS_CHILD npm
test` → 3628 tests, 3622 pass, 0 fail, 5 skipped, 1 todo (the pre-existing `D22` TODO), exit 0.

L11 (correction, independent verification of slice 4f683d3): four defects fixed. (1) `requestUsage` prints
`http-<status>` only for an integer 100..599 and `http-unknown` otherwise, so an adapter's unchecked status
can no longer carry a header value into a reason code. (2) `usableToken` trims first, decides on the trimmed
value and returns it, so a whitespace-padded Console key is refused and a padded OAuth token is sent trimmed.
(3) `resolveToken` remembers the rejected file credential: when the host `apiKey` is that same string nothing
is sent and the reason is `expired-token`. (4) An explicit, non-empty `scopes` array without `user:profile`
(L5: a `setup-token` gets a 403) makes the file token unusable, falls back as before and reports the new
fixed code `unusable-token` (readiness `unknown`); a missing or empty `scopes` array keeps the token. Tests
added to `tools/claude-usage.test.js` (29 total, 0 fail) and `docs/reference.md` names the scopes rule, the
trim and the two new codes.

L12 (evidence, parent): committed as `ebfb632` on `feat/claude-usage` (base main `c9b4fb1`), worktree
clean. Suite: 3634 tests, 3628 pass, 0 fail, 5 skipped, 1 todo (the pre-existing `prs-t15` D22 TODO).
Independent verifier (Risk item 2 credentials + item 3 shared registration) returned four defects, all fixed
in the same commit with regressions: (D1) a non-integer response status was interpolated into the reason code,
so an arbitrary string could reach the debug console - now `http-unknown` outside 100..599; (D2) a padded
Console key passed the prefix check - the value is trimmed before the check and sent trimmed; (D3) the file's
expired token was re-sent when the host apiKey was that same string - a rejected credential is never sent
twice; (D4) a file token whose non-empty `scopes` lacks `user:profile` was sent and could only 403 - now
`unusable-token`, unknown readiness. Verdicts after the fix: S2, S3, S4 PASS as implemented; S1's two failed
points were D1 and D3.

L13 (evidence): native ordinary review of this slice does not exist. START for candidate `4f683d3` returned a
consent envelope that resolved to `consent-declined-this-candidate` with `lineage_created: false`, so no
authority was burned and no reviewer ran; it was not retried. Delivery (push, PR, merge, release) stays the
human's decision.


L14 (requirement, S5, human verbatim): "asegura que no se dupliquen nomas pues muestran lo mismo". With both
`anthropic` and `claude-bridge` in scope the two sources resolve the same account and the panel drew two
identical sections. One account now answers once per refresh wave, keyed on `<sha256(token)>:<now>` — the
fingerprint of the token that resolved, never the token itself, held in memory as ONE entry and never logged
or returned. The key is claimed before the request, so the second id of the wave sends nothing, resolves
`undefined` and reports the new fixed `duplicate-account` (readiness `unknown`); the claim replaces itself
with the next wave, so neither id is silenced for good; a wave with no usable token claims nothing, so
`missing-key` still reaches both; two different accounts in one wave both answer. Evidence:
`tools/claude-usage.test.js` gains four cases beside the registration ones (first-asked wins in both orders
with one fetch call, `duplicate-account` + `unknown`, a later wave answering again, a tokenless wave claiming
nothing, two accounts answering) plus `resetWaveClaim`, the test seam the suite resets per case and between
the several waves older cases simulate. `docs/reference.md` and `README.md` now say the account answers once
per refresh, and the second id shows the host's own note instead of a copy of the numbers.
