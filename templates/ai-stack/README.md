# AI Stack Templates

Drop-in snippets for model aliases, Claude Code tmux relay, ACP wrapper shape, local-model routing, browser-lane locking, and safe config fragments.

## Files

- `model-aliases.openclaw.json` - model alias fragment
- `ollama-local-routing.openclaw.json` - local embedding and utility alias fragment
- `claude-tmux-relay.sh` - helper for driving a first-party Claude Code tmux session without `claude -p`
- `acp-wrapper.mjs` - wrapper pattern for launching an ACP server
- `plugin-health-check.sh` - smoke-check shape for enabled plugins
- `browser-lane-lock.sh` - `flock` wrapper for persistent browser profile lanes

These are templates. Replace placeholders before use.
