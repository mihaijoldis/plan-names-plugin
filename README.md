# plan-names

A Claude Code plugin that submits the *filename* of each new plan file to
[plannames.dev](https://plannames.dev), where the names are ranked for fun.

Claude Code names plan files from a built-in wordlist — `jaunty-soaring-adleman`,
`bubbly-chasing-sparrow`, `crispy-wandering-hopper`. The noun pool includes computer scientists, so
you get `binary-juggling-hejlsberg` and `vectorized-petting-lamport`. Occasionally a slug of your own
prompt survives into the name and fuses with the generated part, which is where the good ones come
from: `i-want-you-to-flickering-jellyfish`.

## Install

```
/plugin marketplace add mihaijoldis/plan-names-plugin
/plugin install plan-names@plannames
```

## What gets sent

One HTTP request per new plan file, containing exactly this:

```json
{
  "name": "jaunty-soaring-adleman",
  "agent": "claude-code",
  "agentVersion": "2.1.274",
  "installId": "3f2a...",
  "clientVersion": "1.0.0"
}
```

The `installId` is a random UUID generated on first run and stored locally. It is not derived from
your hostname, username, MAC address, or anything else about your machine, and the server keeps only
a salted hash of it. It exists so a name submitted by forty separate people can be told apart from
one person submitting forty times.

**Never sent:** the contents of any plan file, the path it sits at, your project or directory names,
your prompt, your IP beyond what any HTTP request reveals, or anything else about your machine. The
hook reads `basename(file_path)` and does not open the file.

## Why your prompt can end up in a filename, and what stops it

The generated part of a plan name comes from a fixed wordlist. Your prompt sometimes gets prepended.
There is no marker between the two halves, and length does not separate them either — the generated
tail is two or three words, and so is a prompt slug like `migrate-acme-billing`.

So the plugin does not try to find the seam. It checks membership: a name is sent automatically only
when **every** hyphen-separated token appears in the known generator vocabulary, which it caches
locally and refreshes daily.

```
jaunty-soaring-adleman              every token known      sent
fix-the-acme-billing-crispy-hopper  "acme" is not known    held
```

A held name is written to a local file and **nothing about it is transmitted**. You get one line:

```
plan-names: 1 name held back because it may contain your prompt text. Run /plannames to review.
```

`/plannames` lists what is held, shows which words were not recognized, and submits only the ones you
name. You can also discard them.

**It fails closed.** If the vocabulary cannot be fetched and there is no cached copy, every token
counts as unknown and nothing is sent. A network problem never turns into a disclosure.

## Local files

In `$CLAUDE_PLUGIN_DATA`, or `~/.plannames` if that is unset:

| File | Contents |
| --- | --- |
| `install-id` | the random UUID |
| `vocab.json` | cached generator wordlist |
| `seen.json` | names already handled, so incremental writes are not resubmitted |
| `pending.json` | names held for your review |

Delete the directory to reset everything. Nothing is stored anywhere else.

## Uninstalling

```
claude plugin uninstall plan-names
```

Then remove the data directory above if you want it gone.

## The hook

`PostToolUse` on `Write|Edit`, which fires after Claude writes a file. The script exits immediately
unless the path is inside your plans directory. It **always exits 0**, on every error path, with a
3-second network timeout, so it cannot fail a tool call or interrupt a session.

Plan files are written incrementally, so the same file is written many times per session. A local
seen-list means each name is considered once.

## Auditing it

Two files, no dependencies, node builtins only:

- [`scripts/submit.mjs`](plugins/plan-names/scripts/submit.mjs) — the hook
- [`scripts/review.mjs`](plugins/plan-names/scripts/review.mjs) — the `/plannames` command

## Note on updates

This plugin omits the `version` field in `plugin.json`, so Claude Code resolves its version from the
commit SHA and every push is deliverable. Auto-update is off by default for third-party
marketplaces, so run `/plugin marketplace update plannames` to pick up changes.

## License

MIT
