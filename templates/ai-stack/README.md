# AI Stack Templates

Drop-in snippets for model aliases and the agent roster, Claude Code tmux relay, ACP wrapper shape, local embedding routing, browser-lane locking, and safe config fragments.

## Files

- `model-aliases.openclaw.json` - 2026.10-shape fragment: `openai/<model>` refs, per-model `agentRuntime`, aliases (`sol61`, `luna6`), `modelPolicy.allow`, sub-agent defaults, and a two-entry `agents.entries` roster. `fallbacks` carries the short chain my live config runs (Luna, then Opus 5.5 for the main agent, Sonnet 5.5 for the browser agent), and every entry is on `modelPolicy.allow`. Probe each fallback with a live turn before you keep it. Build your own chain on purpose (see `ai-stack/model-retirement-and-fallbacks.md`)
- `ollama-local-routing.openclaw.json` - top-level `memory.search` pointed at a local Ollama embedding model, plus one placeholder alias for an optional local utility model
- `claude-tmux-relay.sh` - helper for driving a first-party Claude Code tmux session (a recoverable alternative to `claude -p`)
- `acp-wrapper.mjs` - wrapper pattern for launching an ACP server
- `plugin-health-check.sh` - smoke-check shape for enabled plugins
- `browser-lane-lock.sh` - `flock` wrapper for persistent browser profile lanes

These are templates. Replace placeholders (`<ollama-placeholder-key>`, `<local-utility-model>`) before use, and merge fragments into your own `openclaw.json` instead of overwriting it. The JSON files are valid JSON with no comments, so check your OpenClaw version's schema (`openclaw doctor`) after merging.
