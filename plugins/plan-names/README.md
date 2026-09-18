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

Once a day, separately, a count of how many names were submitted and how many were
held. No names, no tokens — see **The held-name count** below.

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
- **Your email address** — see [Hear when your name wins](#hear-when-your-name-wins). The plugin
  has no way to send it, by design: it prints a code and you type the address on the website
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

Unknown names are stored in `pending.json` and can be reviewed with `/plannames`.

A held name is released automatically in exactly one case: a later vocabulary update
shows that **every** one of its tokens is generator vocabulary after all. The reason it
was held has then gone — it was never your prompt text, only a word the server had not
caught up with yet — and it is submitted on the next run, with a notice telling you so.
This is what stops a stale wordlist from quietly discarding good names forever.

A name with any token still unknown is never sent without your explicit approval.

**Fail closed:** If the vocabulary fetch fails and no local cache exists, the plugin treats all tokens as unknown, holding the name instead of sending it. Better safe than sorry.

### The held-name count

The vocabulary is a snapshot of the plan-name generator's own wordlist. When the
generator gains a word the server has not seen yet, every name using it is held —
correctly by the rule, but wrongly in spirit, and silently, on your machine.
Nothing about that reaches the server, because the whole point is that held names
never leave.

So once a day the plugin sends two integers: how many names it submitted and how
many it held, along with the same opaque install id. A rising held rate across
installs is the only way to notice the wordlist has drifted.

It is an alarm, not a diagnosis. The server learns that names are being held, never
which words caused it — hashing the unknown tokens would not help, since single
English words fall to a dictionary attack in seconds. On a spike the wordlist gets
re-extracted by hand.

The counts are kept in `stats.json` and cleared only once the server has accepted
them.

## Local files and data directory

The plugin stores these files in the directory Claude Code assigns it,
`~/.claude/plugins/data/plan-names-plannames/`:

- `install-id` — A random UUID, generated once and never changed. The server only receives a salted hash of it.
- `vocab.json` — Cached vocabulary list (refreshed every 24 hours).
- `seen.json` — Set of names already processed (submitted or held).
- `pending.json` — Names held back, waiting for your review.
- `notice-shown` — Timestamp of the last update notice (shown at most once per day).

Claude Code passes this path to the hook as `CLAUDE_PLUGIN_DATA`, and the scripts
derive the same path when that variable is absent (as it is for slash commands),
so the hook and `/plannames` always read the same store.

### How to delete local data

```bash
rm -rf ~/.claude/plugins/data/plan-names-plannames
```

This will not affect any names already submitted to the server.

## Review held names

When a name is held, the hook prints a notice and you can run:

```
/plannames
```

This command shows you each held name with its unknown tokens highlighted, so you can decide whether to submit, discard, or discard all. A name with an unknown token is never sent without your explicit approval; see the vocabulary gate above for the one case where a held name is released on its own.

## Hear when your name wins

Optional. Off unless you ask for it.

```
/plannames --claim
```

The plugin asks plannames.dev for a short code and prints it. Enter that code at
[plannames.dev/claim](https://plannames.dev/claim) along with your email, confirm from your
inbox, and you get an email when a name this install generated reaches the top ten.

**The plugin never transmits your email address.** Asking for a code sends one field — the
same anonymous `installId` that already goes out with every name — so claiming adds nothing to
what leaves your machine. The address is typed on the website, on a page that states what is
kept and why.

What the server stores if you claim:

- Your email address
- The hash of your `installId`, so it knows which names are yours
- Nothing else, and no other mail

Every email carries a one-click unsubscribe (RFC 8058). Unsubscribing **deletes** the record
rather than flagging it, and an address that is never confirmed is deleted within seven days.

## How to uninstall

```bash
claude plugin uninstall plan-names
```

This removes the plugin. Claude Code prompts before deleting the plugin's data
directory; if you keep it, it can be removed manually with the command above.

## Hook behavior

The hook runs on every file write and always exits with code `0`. It:

- **Never blocks** the session (network timeout: 3 seconds)
- **Never prompts** you for input
- **Never disrupts** your work (all errors are swallowed silently)
- **Never writes** outside its own plugin data directory

If something goes wrong, you will not notice. The hook is designed to be completely transparent.

## Version resolution

This plugin is built without an explicit `version` field in `plugin.json`. When installed from a git source, Claude Code resolves the version from the commit SHA, so every push becomes a deliverable update.

**Note:** This behavior has not yet been verified against the official Claude Code marketplace. Testing against a scratch marketplace before official launch is recommended.

## Questions or concerns?

The plugin is fully open source. See [plannames.dev](https://plannames.dev) for details on how the server works and what it does with submitted names.
