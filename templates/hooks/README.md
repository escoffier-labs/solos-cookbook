# Hooks templates

Drop-in skeletons for the three hook layers covered in [`../../automation/hooks.md`](../../automation/hooks.md).

| File | Layer | Use when |
|------|-------|----------|
| `pre-push` | Boundary | Block pushes that contain RFC 1918 IPs, secrets, or internal hostnames |
| `claude-code-posttooluse.json` | Tool-call | Append context after a Claude Code tool call (substitution caveats inline) |
| `openclaw-sync-hook.ts` | Tool-call | Substitute persisted tool output in OpenClaw, sync-only with the Promise-return warning called out |

## How to use

1. Copy the file you need.
2. Replace every `<ANGLE_BRACKETS>` placeholder.
3. Install per the comments at the top of each file.
4. Verify with the `Verification` commands in the parent guide.

## A note on Layer 3 (lifecycle)

Lifecycle hooks (`SessionStart`, `before_prompt_build`, `message_sending`, `agent_end`) are not shipped as standalone templates because the useful version is the four-hook pattern in [`tool-narration-guard`](https://github.com/openclaw/openclaw) — track tool calls per `runId`, evaluate at `llm_output`, inject enforcement at `before_prompt_build`, persist state to disk with TTL. Lift that whole shape, not a single-event skeleton.

License: MIT (see [`../../LICENSE`](../../LICENSE)).
