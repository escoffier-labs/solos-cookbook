# Running Claude Code in OpenClaw via ACP

In April 2026, Anthropic stopped accepting subscription OAuth from third-party harnesses. The `anthropic:claude-cli` backend that many OpenClaw users had plugged a Max subscription into stopped working overnight. The replacement I ran was Claude Code as its own process, spoken to over the **Agent Client Protocol** (ACP), so OpenClaw orchestrates Claude Code instead of impersonating it.

That setup is still the one I use for explicit ACP sessions. For code review and second opinions, the preferred lane is the [Claude Code tmux relay](claude-code-tmux-relay.md). This guide covers the ACP side: install, wrapper script, config, permissions, and the auth boundary that decides whether the whole thing works.

**Tested on:** OpenClaw 2026.10.4 (embedded ACPX runtime, a vendored `acpx` package pinned `^0.19.2` is also on the host), Claude Code 2.1.302, Claude Opus 5 behind a pinned wrapper (`ANTHROPIC_MODEL=claude-opus-5`). Earlier revisions of this guide were written against OpenClaw 2026.4.x, ACPX 0.7.x, and Opus 4.x.
**Last updated:** 2026-10-17

---

## What Changed (and Why This Exists)

Before April 2026, OpenClaw could talk directly to the `claude` CLI as a model backend. Max subscription OAuth tokens flowed through OpenClaw and you got frontier Claude for your monthly sub cost.

Anthropic then rejected those tokens unless the request came from Claude Code itself. Two practical consequences at the time:

1. **Stored `anthropic:claude-cli` tokens stopped refreshing cleanly.** The deprecation warning in `openclaw doctor` was real.
2. **Subscription Claude inside OpenClaw had to go through Claude Code as the first-party harness.** In ACP, Claude Code runs as its own process, OpenClaw speaks ACP to it, and the subscription check passes because Claude Code is making the call.

Since then OpenClaw's own docs describe a native `claude-cli` runtime (`agentRuntime.id: "claude-cli"` on an `anthropic/*` model ref) that runs through the installed Claude Code executable. My live config declares that runtime for Opus 5.5 and Sonnet 5.5. I describe what the config shows and what I verified in [the migration guide](claude-cli-to-acp-migration.md). The ACP path below is separate and is the one I use when I want a Claude Code session as an ACP endpoint.

## Architecture

```
┌────────────────────┐   ACP over stdio    ┌───────────────────────────────┐
│  OpenClaw gateway  │◄───────────────────►│  wrapper script               │
│  (acpx backend)    │                     │  -> claude-agent-acp adapter  │
└────────────────────┘                     │  -> Claude Code (first-party) │
         │                                 └───────────────────────────────┘
         ▼                                                │
   Discord / TG etc.                                      ▼
                                                    Anthropic API
```

OpenClaw does not hold the Claude credentials. The gateway spawns the wrapper as a subprocess, the wrapper starts the Claude ACP adapter, and the adapter runs Claude Code. From Anthropic's side it is a Claude Code session.

## Install ACPX

ACPX is the OpenClaw plugin runtime that wraps the ACP protocol. How you install it depends on your OpenClaw version:

- **OpenClaw 2026.10 and later:** the `acpx` plugin embeds the ACP runtime. There is no separate binary or version to configure. Install or enable the plugin and confirm it:

  ```bash
  openclaw plugins list | grep -i acpx
  openclaw config get plugins.entries.acpx.enabled
  ```

  Run `/acp doctor` from a session for an on-demand health probe.
- **Older 2026.4 to 2026.6 installs:** ACPX was a user-local package that the plugin pointed at with a load path and a `command`. That is the layout earlier revisions of this guide described.

My host still has a vendored package from the older layout, pinned so it stays on one minor line:

```bash
mkdir -p ~/.openclaw/vendor/acpx
cd ~/.openclaw/vendor/acpx
npm init -y
npm install acpx@^0.19.2
~/.openclaw/vendor/acpx/node_modules/.bin/acpx --version
```

On 2026.10.4 the gateway does not load from that directory: no `plugins.load.paths` entry points there. I keep it so I can run the `acpx` CLI by hand when debugging an adapter. If your OpenClaw version embeds the runtime, you can skip this block.

## Install Claude Code

ACP drives the `claude` binary through an adapter. If it is not installed:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

Log in once interactively to seed the credentials:

```bash
claude
# complete the browser login, then exit once it confirms
```

The credentials land in `~/.claude/`. Do not copy them anywhere. The adapter inherits them by running Claude Code as a subprocess under the same OS account as the gateway.

## The Wrapper Script

Each Claude ACP agent is a small shell script that pins the model and starts the adapter. Mine is this shape (a Node variant lives in [`../templates/ai-stack/acp-wrapper.mjs`](../templates/ai-stack/acp-wrapper.mjs), set `ACP_MODEL` to pin the model and point the `command` entry at the file):

```bash
#!/usr/bin/env bash
# ACPX spawn wrapper: Claude ACP adapter with Claude Code pinned to one model.
# ANTHROPIC_MODEL is the env var Claude Code honors for a primary-model pin.
export ANTHROPIC_MODEL=claude-opus-5
exec npx -y @agentclientprotocol/claude-agent-acp "$@"
```

Make it executable (`chmod +x`). Keep one wrapper per model you want to be able to select, for example a second script that exports a different `ANTHROPIC_MODEL`. Two things to know about this shape:

- **The adapter is fetched by `npx -y` on first use.** Mine is unpinned, so a cold cache pulls whatever is current. If you want reproducible behavior, pin a version in the `npx` argument.
- **Do not export `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the wrapper.** See [The auth boundary](#the-auth-boundary).

## Wire It Into OpenClaw

Two pieces: a top-level `acp` block that turns ACP on and names the allowed agent ids, and the `acpx` plugin entry that maps each custom agent id to its wrapper.

```json
{
  "acp": {
    "enabled": true,
    "backend": "acpx",
    "defaultAgent": "codex",
    "allowedAgents": ["claude", "claude-opus-5", "codex", "cursor", "opencode"]
  },
  "plugins": {
    "allow": ["acpx"],
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "permissionMode": "approve-all",
          "timeoutSeconds": 120,
          "agents": {
            "claude-opus-5": {
              "command": "/absolute/path/to/agent-home/.openclaw/vendor/claude-acp/claude-opus-5-acp.sh"
            }
          }
        }
      }
    }
  }
}
```

`plugins.allow` here is shown with only `acpx` for brevity. If you already have an allowlist, add `acpx` to it rather than replacing it. Replace `/absolute/path/to/agent-home` with the gateway account's absolute home directory. Under systemd, `PATH` is minimal and relative lookups fail silently.

Apply changes with `openclaw config patch` (a validated JSON5 merge, `--dry-run` previews it) or `openclaw config set <path> <value>`. ACP policy changes (`enabled`, `defaultAgent`, `allowedAgents`) apply to new admissions without a gateway restart. A change to the plugin entry reloads the plugin. If in doubt, restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

### Permissions

`permissionMode` is an ACPX harness setting, separate from OpenClaw exec approvals:

| Value | Behavior |
|---|---|
| `approve-all` | Auto-approve all file writes and shell commands |
| `approve-reads` | Auto-approve reads only. Writes and exec need a prompt (OpenClaw's default) |
| `deny-all` | Deny every permission prompt |

A non-interactive ACP session cannot click a prompt, so with the default `approve-reads` any write or exec fails with `PermissionPromptUnavailableError`. I run `approve-all` because these sessions are headless, and I compensate by keeping `acp.allowedAgents` short and not exposing the Claude agent ids to channels I do not trust. Treat `approve-all` as a break-glass setting and pick it deliberately.

`timeoutSeconds` is the operation limit for ACPX runtime startup and control calls, including the startup health probe. The default is 120 and I run 120. Interactive turns can run past it until the turn budget ends.

## Using It

The ACP agent is selected by id, not by a model alias. From a session, spawn it with `/acp spawn claude-opus-5`, or from an agent tool call with `sessions_spawn({ runtime: "acp", agentId: "claude-opus-5" })`. Check readiness first with `/acp doctor`. OpenClaw only teaches agents about ACP spawning when the backend is enabled and healthy.

My main agent runs on a different model entirely (GPT 6.1 Sol), so Claude via ACP is an escalation target, not the orchestrator. Do not set it as a fallback for the main agent: ACP sessions are stateful and slow to start, and falling into one mid-turn produces surprising latency.

### Dedicated ACP threads

For interactive sessions where you want to talk to Claude directly, bind an ACP session to its own Discord thread or Telegram topic instead of multiplexing it through the main agent's channel. Thread-bound spawns need the thread-binding flag for your channel (for Discord, `session.threadBindings.spawnSessions=true`).

## The auth boundary

Auth mistakes cost me more time than anything else in this setup, so they get their own section.

- **Claude Code authenticates from `~/.claude/.credentials.json` after a normal `/login`.** That is the file the ACP adapter should use.
- **`CLAUDE_CODE_OAUTH_TOKEN` in the environment overrides the credentials file**, including right after a successful `/login`. If a stale or revoked token is exported anywhere the gateway inherits (a secrets render, a systemd `Environment=` line, a login shell that gets sourced), the wrapper runs with the bad token and the fresh login never takes effect.
- **Keep `ANTHROPIC_API_KEY` unset.** If it is present, Claude Code can pick API billing instead of the subscription.

I hit this directly: a revoked environment token kept winning over a good credentials file. The fix was to remove the token from every secrets template and rendered environment, unset any inherited copy in the shell profile, and confirm the running gateway process carries neither variable. The check is in Verification below. After any auth change, verify in this order: direct `claude` output, a fresh interactive shell, the configured wrapper, then the gateway environment.

## Post-Upgrade Recovery

OpenClaw upgrades have reset plugin config on minor bumps in the past. Verify after every upgrade:

```bash
jq '.acp, .plugins.entries.acpx' ~/.openclaw/openclaw.json
```

If either returns `null`, restore from your snapshot (see [Upgrade Hygiene](../infrastructure/upgrade-hygiene.md)) and restart.

After a reboot, ACP sessions do not auto-resume. If Claude Code's credentials expired in the meantime, the first request to the ACP agent hangs until it times out. Fix:

```bash
claude   # interactive, completes any login or refresh
# exit, then retry the agent
```

## What ACP Is Good For

Use it for:

- **Review and critique.** Let the cheaper orchestrator produce a first pass, then hand it to Claude for a second opinion.
- **Architecture reasoning.** Design discussions, trade-off analysis, refactoring plans.
- **Security analysis.** A second set of eyes on failure modes and attack surface.
- **Research-heavy analysis.** Dense source review and synthesis.

Do not use it for:

- **Tool loops with many iterations.** ACP startup and round-trip latency adds up.
- **Cron jobs.** The subprocess model is heavier than scheduled triage needs. Use a cheaper model, or the one-shot relay for a Claude call.
- **High-cadence edits.** ACP applies edits through Claude Code's own tool, which is fine but slower than OpenClaw's direct edit backend.

## Print mode and the other Claude lanes

There are three ways to reach Claude from this stack, and the rule for each is different. This is the current split on my host, not a general claim about Claude Code:

| Caller | Lane | Why |
|---|---|---|
| OpenClaw scripts, cron, agent exec calls that need a Claude one-shot | The [tmux relay](claude-code-tmux-relay.md) (`claude-tmux-oneshot.py`) | It authenticates the way the interactive session does, handles long jobs, and can report back to a channel. I do not use bare `claude -p` for OpenClaw tool use |
| Headless reviewer or worker dispatched from a coding harness | `claude --print --model opus --disallowedTools Task Agent`, prompt on stdin | One flat pass, no internal fan-out. The disallowed-tools flag takes a list, so put the prompt on stdin or after a `--` |
| A Claude Code session as an ACP endpoint | This guide | Explicit ACP integration |

The reason for the OpenClaw-side caution is history, not a current bug report: in mid-2026, spawned `claude` processes on this host fell back to an expired credentials file and returned `401 Invalid authentication credentials`, because a different token in the environment was the one that worked. Billing for `claude -p` is also set by Anthropic and has changed before. OpenClaw's docs note that `claude -p` and Agent SDK usage draw from the signed-in subscription's limits, so check `claude auth status` if cost predictability matters.

## Verification

After config changes, sanity-check before trusting routing:

```bash
# ACPX plugin is enabled
openclaw config get plugins.entries.acpx.enabled
# Expected: true

# ACP is on and the Claude agent id is allowed
jq '.acp.enabled, .acp.backend, (.acp.allowedAgents | index("claude-opus-5") != null)' ~/.openclaw/openclaw.json
# Expected: true, "acpx", true

# The wrapper is wired and executable
jq -r '.plugins.entries.acpx.config.agents["claude-opus-5"].command' ~/.openclaw/openclaw.json | xargs ls -l

# Claude Code is logged in through the first-party provider
claude auth status | jq '{loggedIn, apiProvider}'
# Expected: {"loggedIn": true, "apiProvider": "firstParty"}

# The gateway process carries neither override variable (prints variable NAMES only)
PID=$(systemctl --user show openclaw-gateway -p MainPID --value)
tr '\0' '\n' < /proc/"$PID"/environ | grep -E '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=' | cut -d= -f1
# Expected: no output
```

Then run a live round trip: spawn the agent (`/acp spawn claude-opus-5`) and ask it to reply with a fixed string. A healthy status check is not enough. The first live turn is what proves the wrapper, the adapter, and the credentials work together.

If the first call hangs well past the 120 second timeout, the `claude` subprocess is probably stuck re-authenticating or the adapter fetch failed. Run `claude` interactively once, and run the wrapper by hand to see its stderr.

## Gotchas

1. **A token in the environment beats a good login.** `CLAUDE_CODE_OAUTH_TOKEN` overrides `~/.claude/.credentials.json`, including after `/login`. Check the gateway process environment, not just your shell.

2. **Leftover `claude-cli` auth from the pre-April setup confuses startup.** Old `anthropic:claude-cli` profiles and `cliBackends` entries produce misleading errors. On a modern install, list profiles with `openclaw models auth list` and remove stale ones with `openclaw models auth logout <profile-id>`. Auth state is in SQLite now, so there is no `auth-profiles.json` to `jq` through.

3. **Credentials live in `~/.claude/`, not `~/.openclaw/`.** Do not back them up with your OpenClaw workspace. They are host-specific and one interactive login regenerates them.

4. **`plugins.allow` must list `acpx`.** If you use an allowlist, omitting it blocks the backend. `/acp doctor` reports the missing entry.

5. **Positional args are MCP config paths on some Claude Code versions.** Since Claude Code 2.1.92, a positional argument can be taken as an MCP config path when `--strict-mcp-config` is active. The ACP adapter handles the prompt over stdio, so you do not pass one, but any script you write that calls `claude` directly should use stdin.

6. **`permissionMode` defaults to `approve-reads`.** Headless write or exec work fails with `PermissionPromptUnavailableError` until you change it, and changing it to `approve-all` is a real trust decision.

7. **Do not route the main orchestrator through ACP.** Latency and statefulness both fight you. Keep ACP as an escalation target.

8. **The `npx -y` adapter fetch can fail on a host with no network or a cold cache.** Pre-warm it, pin a version, or install the adapter another way.
