---
description: Review plan filenames plan-names held back because they may contain your own prompt text, and choose which to submit or discard. Also `--claim` to get notified when one of your names reaches the top ten.
---

# /plannames

Review plan names held back by the vocabulary gate.

## If the user asked to claim their names

If the user's message asks about claiming, subscribing, or being notified about their names
(or they typed `/plannames --claim`), run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --claim` and show its output verbatim. It
prints a short code and the URL to enter it at. Do not ask for their email address and do not
offer to submit it anywhere — the address is typed on the website, never through the plugin.
Then stop; the rest of this document does not apply.

## What to do

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --list` to see all held names.
2. Parse the JSON output and show the user each held name with its unknown tokens highlighted/emphasized, so they can understand why it was held.
3. Ask the user which names they want to submit, which to discard, or offer to discard all.
4. **CRITICAL:** Never submit a name the user did not explicitly approve. Wait for their explicit yes.
5. For each name the user approves, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --submit <name>`.
6. After submission, offer the user options to `--discard <name>` for other held names, or `--discard-all` to clear everything at once.
7. If the user chooses to discard, run the corresponding discard command.

## Example flow

User has these pending names:
- `my-awesome-project` (unknown: ["my", "awesome"] if they're not in vocab)
- `the-best-plan` (unknown: ["the", "best"])

Show them:
```
Held back (may contain your prompt text):
1. my-awesome-project - unknown tokens: [my, awesome]
2. the-best-plan - unknown tokens: [the, best]

Which would you like to submit? Or discard? You can also run --discard-all to clear all held names.
```

Wait for their response. Only submit the ones they explicitly name.

## Rules

- The hook always exits 0 and never breaks a session.
- This command is for explicit, intentional submission only.
- The vocabulary gate was designed to protect your privacy by preventing accidental submission of prompt text.
- If the user wants to submit anyway, let them, but only after they've explicitly said yes to each name.
