# Running Claude Code in OpenClaw via ACP

In April 2026, Anthropic blocked subscription OAuth from third-party harnesses. The `anthropic:claude-cli` backend that most OpenClaw users had plugged a Max subscription into stopped working overnight. The replacement: run Claude Code natively via the **Agent Client Protocol** (ACP), with OpenClaw orchestrating over it instead of impersonating the CLI.

This is the setup that works as of April 2026.

**Tested on:** OpenClaw 2026.4.x, Claude Code 2.1.113, ACPX plugin 0.4.0
**Last updated:** 2026-04-20

---

## What Changed (and Why This Exists)

Before April 2026, OpenClaw could talk directly to the `claude` CLI as a model backend. OAuth tokens from your Max subscription flowed through OpenClaw, and you got frontier Claude for free-ish (just your monthly sub cost).

Anthropic now rejects those tokens unless the request comes from Claude Code itself. Two practical consequences:

1. **Don't store `anthropic:claude-cli` tokens anymore.** They won't refresh cleanly, and the deprecation warning in `openclaw doctor` is real.
2. **If you want subscription Claude inside OpenClaw, use ACP.** Claude Code runs as its own process, OpenClaw speaks ACP to it, and the subscription check passes because it really is Claude Code making the call.

Direct Anthropic API access (billed per-token) still works through the `anthropic` plugin — but if you have a Max sub you already paid for, ACP is how you get it back.

## Architecture

```
┌────────────────────┐     ACP over stdio     ┌──────────────────────┐
│  OpenClaw gateway  │◄──────────────────────►│  Claude Code (acpx)  │
│  (orchestrator)    │                        │  with Max OAuth      │
└────────────────────┘                        └──────────────────────┘
         │                                               │
         ▼                                               ▼
   Discord / TG etc.                             Anthropic API
```

OpenClaw does not see the OAuth tokens. It spawns Claude Code as a subprocess and exchanges ACP messages with it. From Anthropic's side, it's indistinguishable from a user running Claude Code in a terminal.

## Install ACPX

ACPX is the OpenClaw plugin that wraps the ACP protocol. Install it user-local (not system-wide) so upgrades don't trample it:

```bash
mkdir -p ~/.openclaw/vendor/acpx
cd ~/.openclaw/vendor/acpx
npm init -y
npm install @openclaw/acpx@^0.4.0
```

Verify the binary landed:

```bash
ls -l ~/.openclaw/vendor/acpx/node_modules/.bin/acpx
```

## Install Claude Code

ACPX drives the `claude` binary. If it's not already installed:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Log in once interactively to seed the OAuth tokens:

```bash
claude
# complete the OAuth flow in your browser
# exit the REPL once it confirms
```

The tokens now live in `~/.claude/`. Don't copy them anywhere — ACPX will hand them off implicitly by running `claude` as a subprocess.

## Wire It Into OpenClaw

Add the plugin and a model alias to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["acpx"],
    "entries": {
      "acpx": {
        "enabled": true,
        "command": "/home/you/.openclaw/vendor/acpx/node_modules/.bin/acpx",
        "agent": {
          "command": "/home/you/.local/bin/claude",
          "args": ["--print", "--output-format", "stream-json", "--input-format", "stream-json"]
        }
      }
    }
  },
  "models": {
    "acp:claude-opus-4-7": {
      "backend": "acpx",
      "model": "claude-opus-4-7"
    }
  }
}
```

Use the absolute path to `acpx` and `claude`. Under systemd, `PATH` is minimal and shell lookup will silently fail.

Restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

## Assign It to an Agent

ACP is best used for **escalation**, not as the default orchestrator. GPT-5.4 or another subscription model handles the hot path (tool loops, routing, cron); Claude Code-via-ACP handles the work that genuinely benefits from deeper reasoning — resume work, long-form writing, architecture review, humanizing output.

```json
{
  "agents": {
    "entries": {
      "main": {
        "model": "openai:gpt-5.4",
        "fallbacks": ["openai:gpt-5.3-codex"]
      },
      "reviewer": {
        "model": "acp:claude-opus-4-7",
        "tools": ["read", "grep", "glob"]
      }
    }
  }
}
```

Route to `reviewer` from your orchestrator for the specific lanes where you want Claude. Don't set ACP as a fallback for the main agent — ACP sessions are stateful and slow to spin up, and falling into one mid-turn produces surprising latency.

## Dedicated ACP Channels

For interactive Claude Code sessions (where you want to talk to Opus directly, not via the orchestrator), expose ACP through a dedicated Discord thread or Telegram topic. The ACP agent holds its own session state and conversation history — don't try to multiplex it through the main agent's channel.

A minimal channel config:

```json
{
  "channels": {
    "discord": {
      "threads": {
        "acp-opus": {
          "agent": "reviewer",
          "mode": "assist"
        }
      }
    }
  }
}
```

## Post-Upgrade Recovery

OpenClaw upgrades can reset `plugins.entries` — ACPX config in particular goes missing on minor bumps. Verify after every upgrade:

```bash
jq '.plugins.entries.acpx' ~/.openclaw/openclaw.json
```

If that returns `null`, restore from your snapshot (see [Upgrade Hygiene](../infrastructure/upgrade-hygiene.md)) and restart.

After a machine reboot, ACP sessions don't auto-resume. The `claude` subprocess needs to re-authenticate if its OAuth cache expired. Symptoms: first request to the ACP agent hangs for ~30 seconds then times out. Fix:

```bash
claude  # interactive, completes any token refresh
# exit, then retry the agent
```

## What ACP Is Good For

Use it for:

- **Review and critique.** Let your cheaper orchestrator produce a draft, hand it to ACP for a second opinion.
- **Long-form writing.** Blog posts, documentation, email drafts where tone matters.
- **Architecture reasoning.** Design discussions, trade-off analysis, refactoring plans.
- **Humanizing output.** When a downstream consumer (reader, reviewer) is going to read the result, polish it here.
- **Academic or formal writing.** If you have a pipeline that cares about voice consistency.

Don't use it for:

- **Tool loops with many iterations.** ACP startup and round-trip latency adds up. GPT-5.4 on Codex cycles faster.
- **Cron jobs.** The subprocess model is heavier than needed for scheduled triage work. Use a cheaper model with a short thinking budget.
- **Anything that needs the `edit` tool at high cadence.** ACP applies edits through Claude Code's own tool, which is fine but slower than OpenClaw's direct edit backend.

## Verification

After config changes, sanity-check before trusting routing:

```bash
# Gateway sees the model
openclaw models list | grep acp:

# Plugin actually loaded
journalctl --user -u openclaw-gateway -n 50 | grep -i acpx

# Round-trip a prompt
openclaw infer --agent reviewer "say hi"
```

If `openclaw infer` hangs for more than 15 seconds on first call, the `claude` subprocess is probably stuck re-authenticating. Run `claude` interactively once to clear it.

## Gotchas

1. **`claude-cli` config left behind breaks startup.** If you upgraded from the pre-April setup, any leftover `anthropic:claude-cli` entries in `cliBackends` or `auth-profiles.json` will produce confusing errors. Delete them fully — `jq 'del(.cliBackends["claude-cli"])'` in `openclaw.json`, and remove the `claude-cli` profile from every `auth-profiles.json`.

2. **OAuth tokens live in `~/.claude/`, not `~/.openclaw/`.** Don't back them up as part of your OpenClaw workspace backup — they're machine-specific and regenerate fine with one interactive `claude` login.

3. **`plugins.allow` must list `acpx`.** If you use the allowlist (see [Upgrade Hygiene](../infrastructure/upgrade-hygiene.md)), omitting acpx silently disables it. The gateway starts, the model vanishes from `openclaw models list`, and routing falls back without any warning.

4. **Claude Code 2.1.92+ changed arg parsing.** Positional args get treated as MCP config file paths when `--strict-mcp-config` is active. The ACPX agent config must set `"input": "stdin"` and use `--print` with `--input-format stream-json` — don't pass the prompt positionally.

5. **Don't route the main orchestrator through ACP.** Latency and statefulness both fight you. Keep ACP as an escalation target, not the default.
