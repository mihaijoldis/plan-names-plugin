# plan-names plugin — test notes

Tested 2026-09-17 against the live server (`https://plannames.dev`) and an offline
logging sink. Node v24.13.0, Windows 11.

## How to test

### 1. Client logic, offline (50 assertions, no network, no live writes)

A logging sink stands in for the server so "nothing was sent" is provable rather
than merely assumed — a dead port and "never called" look identical from the
client side.

```
node test/sink.mjs &        # logs every request to test/requests.json
node test/run-tests.mjs     # 50 assertions
```

Each case runs `submit.mjs` with a virgin `CLAUDE_PLUGIN_DATA` dir and a piped
`{"tool_input":{"file_path":"..."}}` payload.

Branches covered: all-known name submits; unknown token holds; already-seen name
is a silent no-op; **file in a plans subdirectory is a no-op**; file outside the
plans dir is a no-op; bad name formats rejected; vocab unreachable with no cache
fails closed (holds, does not send); malformed/empty stdin exits 0; non-`.md`
file ignored; a held name is auto-submitted once the vocabulary catches up, while a
held name whose tokens are still unknown is **never** auto-submitted.

### 2. Live round trip

```
CLAUDE_PLUGIN_DATA=<tmp> node plugins/plan-names/scripts/submit.mjs <<< '{"tool_input":{"file_path":"C:\\Users\\<you>\\.claude\\plans\\<fresh-name>.md"}}'
curl https://plannames.dev/v1/name/<fresh-name>
```

Verified: name published, `promptLeak:false`, all tokens marked known, dedup via
`seen.json` on a repeat run.

### 3. Real hook

Write a file to `~/.claude/plans/<name>.md` from a Claude Code session. The
`PostToolUse` hook fires on the Write tool.

Confirmed against the original `node:https` client: `vivid-foamy-church` submitted and
live at rank 26; `please-help-me-vivid-otter` held (unknown: `please`, `help`, `me`)
and 404 on the server — never sent.

Re-confirmed against the rewritten client (fetch, shared data dir, reconcile pass,
natural exit): `vectorized-magical-tingly` submitted and live at rank 28, `seen.json`
updated, `stats.json` created with its report clock starting at install rather than
epoch, and `please-help-me-vivid-otter` left untouched in `pending.json` because its
tokens are still unknown. No crash, no output in the session.

### 4. Drift alarm (`/v1/health`)

Client counters live in `stats.json` and are reported once a day. Covered by the
offline suite: no report on a first run, a report once due, counters reset only on a
2xx, counters preserved on a non-2xx, and a report still fires when the name is a
dedup no-op (a starved vocabulary is exactly when names stop being new).

The privacy assertion is the important one — the logged request body must contain
no `name` and no `tokens` field.

Endpoint verified against a production build: valid report stored; a body carrying
`name` or `tokens` rejected with `Unknown field`; missing `installId`, negative
counts and absurd counts all rejected; only valid rows persisted. The admin page
shows held rate over 14 days, amber at 10%, red at 25%.

**The alarm is inert until the server is deployed.** `/v1/health` exists only in the
local build, so live clients currently 404 on it. That is handled — counters are kept
and retried rather than cleared — but no held-rate data accumulates until the deploy
that also fixes `distinctInstalls`.

Reconciliation clears at most 10 held names per run (`RECONCILE_BATCH`); a larger
backlog drains over subsequent runs rather than making dozens of requests inside one
hook.

### 5. `/plannames` (review.mjs)

`--list`, `--submit <name>`, `--discard <name>`, `--discard-all`, unknown name,
and no-args usage all verified. `--submit` against live returned
`status: published` and cleared the entry from `pending.json`.

## FIXED — the hook could crash the whole run

Under Node 24 on Windows, `submit.mjs` died with:

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\winsync.c, line 76
```

exiting `3221226505` (`0xC0000409`). A `PostToolUse` hook that exits non-zero puts its
stderr in front of the user, so this broke the plugin's "never disrupts your work"
promise outright.

It was first found only against a local Next.js server, which made it look like a
quirk of that server. It was not. The real trigger is **several requests in one run
followed by `process.exit(0)`** — the process tears down while a socket is still
closing. It surfaced against Next because a cold vocabulary cache there meant two
requests; adding the pending-reconciliation pass made it three, and it then
reproduced against a plain HTTP sink as well.

Two changes fix it, both needed:

- Requests send `Connection: close`. Nothing here benefits from connection reuse —
  one short run, then exit.
- `main()` sets `process.exitCode` and returns instead of calling `process.exit()`.
  `review.mjs` does the same on its error path.

| Target | Before | After |
| --- | --- | --- |
| Next dev server (Turbopack) | 0/8 | **8/8** |
| `https://plannames.dev` | clean | clean |
| plain HTTP sink | clean | clean |

Average run is 150ms against a local server, so exiting naturally does not leave the
hook hanging.

## Findings

0. **FIXED — `/plannames` read a different directory than the hook wrote to.** Claude
   Code sets `CLAUDE_PLUGIN_DATA` for hooks but not for slash commands, so
   `review.mjs` fell back to `~/.plannames` while `submit.mjs` wrote to
   `~/.claude/plugins/data/plan-names-plannames/`. Every held name was invisible to
   the review command — the hold-and-review design was unreachable in practice.
   Both scripts now share `scripts/data-dir.mjs`, which honours the env var and
   otherwise derives the same path from the install layout. Verified through the real
   installed path.

1. **FIXED — README documented the wrong data directory.** Claude Code sets
   `CLAUDE_PLUGIN_DATA` itself, to
   `~/.claude/plugins/data/plan-names-plannames/`. `~/.plannames` is never used
   by a real install, so the README's "Local files and data directory" section
   and its `rm -rf ~/.plannames` uninstall instruction are both wrong.

2. **`distinctInstalls` never increments on the live server.** Three distinct
   `installId`s against the same name leave `installs` at 1. The repo code is
   correct — a local production build gives 1 → 2 → 3, and a repeat install does
   not bump. **The live deploy is behind the repo.**

3. **The update-notice path is unreachable.** `submit.mjs` reads
   `clientVersion`/`agentVersion` from `payload.tool_input`, which for a Write
   call holds only `file_path`/`content`. Both are always undefined, so the
   server always sees `1.0.0` and `shouldShowNotice` can never return true.
   Separately, `handleNotice` is never called from `main`, and would throw if it
   were (`readFileSync` with no `existsSync` guard). And `submitIngest`'s
   response is awaited then discarded, so the server's `notice` field never
   reaches the user — contradicting the README's "the hook prints a notice".

## Open question

The held-name path writes a `systemMessage` notice to stdout
(`"1 name held back... Run /plannames to review."`). During the live hook test no
notice was visible in the session. That may just be the harness not surfacing
hook stdout to the model, or the notice may never reach users at all — which
would leave `/plannames` undiscoverable and defeat the hold-and-review design.
Worth confirming from a human's view of the transcript.

## Migration note

`drizzle/0001_add_report_voter_hash.sql` was applied by hand and never recorded in
`drizzle/meta/_journal.json`, so `db:generate` regenerated that same `ALTER TABLE`
inside the new migration and `db:migrate` failed on the duplicate column. The
duplicate statements were stripped from `0001_fat_edwin_jarvis.sql`. Two files still
share the `0001` prefix; the journal decides what runs, so this is cosmetic, but the
next `db:generate` will hit the same trap unless the hand-written file is journaled.

## Change made during testing

`PLANNAMES_BASE_URL` was added to `submit.mjs` and `review.mjs` (both previously
hardcoded `hostname: 'plannames.dev'` via `node:https`, with no way to point them
anywhere else). Both now use global `fetch` with `AbortSignal.timeout(3000)`.

This is a shipped behavior change: an env var that redirects where filenames get
sent. Given the plugin's privacy framing, decide whether to keep it for dev
ergonomics, gate it behind a dev-only check, or revert it. Note the offline sink
suite depends on it.

The installed copy at `~/.claude/plugins/cache/plannames/plan-names/d29d8475adfe/`
was overwritten with the repo versions of `submit.mjs`, `review.mjs` and
`data-dir.mjs` to verify the directory fix through the real `/plannames` path. It now
diverges from its git SHA, and `claude plugin update` will revert it. The live hook
tests in section 3 ran against the original `node:https` copy, before that overwrite.
