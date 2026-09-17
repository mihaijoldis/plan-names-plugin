# plan-names Plugin

A Claude Code plugin that submits plan filenames to [plannames.dev](https://plannames.dev) for fun ranking, with privacy protections built in.

## What it does

When you write a plan file to `~/.claude/plans/`, this plugin notices it and sends only the **filename** (without `.md` extension) to plannames.dev, where names are ranked by users in a competitive voting system.

Example: A plan file named `eager-purple-lemming.md` sends the name `eager-purple-lemming` to the server, but **nothing else**.

## Privacy protections

### What is sent

- The plan filename (minus `.md`)
- An opaque random UUID generated once and stored locally (never the same UUID twice)
- The client version (`1.0.0`)

That's it.

Example request body:
```json
{
  "name": "eager-purple-lemming",
  "agent": "claude-code",
  "agentVersion": null,
  "installId": "<random-uuid>",
  "clientVersion": "1.0.0"
}
```

### What is never sent

- File contents (never read)
- File paths (never transmitted)
- Directory names or project names
- Your prompt text or any other content
- IP address (hashed daily with a salt, never stored raw)
- Machine hostname, username, or any system properties
- Any field the server doesn't recognize is rejected with `400`

### The vocabulary gate

Plan filenames can contain your own prompt text. For example: `i-want-you-to-flickering-jellyfish` where `i-want-you-to` came from what you typed.

The plugin protects against accidental submission by:

1. **Tokenizing** the filename on hyphens (`i`, `want`, `you`, `to`, `flickering`, `jellyfish`)
2. **Checking** each token against a list of known generator vocabulary (adjectives, nouns, verbs, and common words)
3. **Holding back** any name with unknown tokens — it is never sent to the server
4. **Caching** the vocabulary locally (24-hour TTL) so most checks happen offline

Unknown names are stored in `pending.json` and can be reviewed with `/plannames`. You have full control over whether they get submitted.

**Fail closed:** If the vocabulary fetch fails and no local cache exists, the plugin treats all tokens as unknown, holding the name instead of sending it. Better safe than sorry.

## Local files and data directory

The plugin stores these files in `~/.plannames/` (or `$CLAUDE_PLUGIN_DATA` if set):

- `install-id` — A random UUID, generated once and never changed. The server only receives a salted hash of it.
- `vocab.json` — Cached vocabulary list (refreshed every 24 hours).
- `seen.json` — Set of names already processed (submitted or held).
- `pending.json` — Names held back, waiting for your review.
- `notice-shown` — Timestamp of the last update notice (shown at most once per day).

### How to delete local data

```bash
rm -rf ~/.plannames
```

This will not affect any names already submitted to the server.

## Review held names

When a name is held, the hook prints a notice and you can run:

```
/plannames
```

This command shows you each held name with its unknown tokens highlighted, so you can decide whether to submit, discard, or discard all. Names are never sent without your explicit approval.

## How to uninstall

```bash
claude plugin uninstall plan-names
```

This removes the plugin. Local data in `~/.plannames/` remains and can be manually deleted.

## Hook behavior

The hook runs on every file write and always exits with code `0`. It:

- **Never blocks** the session (network timeout: 3 seconds)
- **Never prompts** you for input
- **Never disrupts** your work (all errors are swallowed silently)
- **Never writes** outside `~/.plannames/`

If something goes wrong, you will not notice. The hook is designed to be completely transparent.

## Version resolution

This plugin is built without an explicit `version` field in `plugin.json`. When installed from a git source, Claude Code resolves the version from the commit SHA, so every push becomes a deliverable update.

**Note:** This behavior has not yet been verified against the official Claude Code marketplace. Testing against a scratch marketplace before official launch is recommended.

## Questions or concerns?

The plugin is fully open source. See [plannames.dev](https://plannames.dev) for details on how the server works and what it does with submitted names.
