# Migrating from claude-cli to ACP

How to move Claude off the main-agent slot and onto an ACP escalation path after Anthropic blocked subscription OAuth from third-party harnesses in April 2026, and what the `claude-cli` runtime looks like on a current OpenClaw.

**Tested on:** OpenClaw 2026.10.4, Claude Code 2.1.302, ACPX plugin 2026.10.4 (embedded runtime), Claude Max subscription. The original migration was done on OpenClaw 2026.4.x with Claude Code 2.1.92+. Steps below are rewritten for the 2026.10 config shape.
**Last updated:** 2026-10-17

> **Where this fits now:** This is the ACPX compatibility runbook. For normal second-opinion code review I use the [Claude Code tmux relay](claude-code-tmux-relay.md), which keeps Claude in its first-party interactive harness and gives recoverable sessions. The wrapper-script and permissions details for the ACP lane itself are in [Running Claude Code in OpenClaw via ACP](acp-claude-code.md).

---

## What Changed

In April 2026, Anthropic started rejecting Claude Max subscription OAuth tokens when used through third-party harnesses (OpenClaw, OpenRouter-style proxies, and similar). The official Claude Code CLI still worked with Max, but only when Anthropic's own client handled the handshake.

**The concrete impact on an OpenClaw host at the time:**

- The bundled `anthropic` plugin's `claude-cli` backend stopped authenticating with stored subscription tokens.
- Main-agent routing through `claude-cli/claude-opus-4-6` (the Opus model current then) returned `Unknown model` or auth errors.
- Any cron job, hook, or skill that assumed Opus was the primary model silently failed or fell back to another provider.

The April 2026 path forward was to keep Claude reachable through the **Agent Client Protocol (ACP)** and the ACPX plugin. Claude Code runs natively on your machine, OpenClaw connects to it as an ACP client, and Anthropic's own CLI handles the login. Claude becomes an **escalation target**, not a primary orchestrator. My main agent runs on something else (GPT 6.1 Sol today, see [multi-model orchestration](multi-model-orchestration.md)).

### What `claude-cli` looks like now

The "claude-cli backend no longer works" statement in earlier revisions of this guide was true of the April 2026 mechanism: OpenClaw holding a stored subscription token and presenting it as itself. OpenClaw 2026.10 documents a different mechanism under the same name. An `anthropic/*` model ref can carry `agentRuntime: { id: "claude-cli" }`, which runs the turn through the installed `claude` executable on the same host using that executable's own login. OpenClaw copies no token.

This is what my live config shows, and nothing more:

```bash
jq '.agents.defaults.models | with_entries(select(.key | startswith("anthropic/")))' ~/.openclaw/openclaw.json
```

```json
{
  "anthropic/claude-opus-5-5":   { "agentRuntime": { "id": "claude-cli" } },
  "anthropic/claude-sonnet-5-5": { "agentRuntime": { "id": "claude-cli" } }
}
```

- Both models are in `agents.defaults.modelPolicy.allow`, and `anthropic` is in `plugins.allow`.
- `openclaw models list` shows both as configured with auth present, under the aliases `opus` and `sonnet`.
- The default model is `openai/gpt-6.1-sol` and its fallback list is empty, so no ordinary turn runs on these entries. They exist so the models can be picked per chat or per bot.
- I have not made `claude-cli` the escalation path. Escalation still goes through the ACP wrapper in [the ACP guide](acp-claude-code.md) or the [tmux relay](claude-code-tmux-relay.md).
- I did not run a turn through the `claude-cli` runtime while writing this, so I am not claiming it works end to end on my host. The config and the model list are what I verified.

If you are starting fresh in 2026.10, that runtime is worth testing before you build an ACP lane. If you are cleaning up a 2026.4 config, the leftover `claude-cli` pieces in the steps below are the part to remove.

## Who This Is For

Anyone whose `openclaw.json` still references:

- `anthropic/claude-*` or `claude-cli/claude-*` as the primary model of an agent you did not intend to run on Claude, OR
- `agents.defaults.cliBackends.claude-cli` with a `command` path (the pre-2026.6 shape), OR
- an `anthropic:claude-cli` auth profile holding a stored subscription token.

If none of those apply, you are already post-migration and can skip this guide.

## Pre-Migration Checks

### 1. Confirm Claude Code is installed natively

ACP shells out to Claude Code through an adapter. Install it first if you have not:

```bash
# Official install
curl -fsSL https://claude.ai/install.sh | bash

# Or via npm
npm install -g @anthropic-ai/claude-code

# Confirm
claude --version
which claude
```

### 2. Confirm Claude Code can authenticate

```bash
claude auth status | jq '{loggedIn, apiProvider}'
# Expected: {"loggedIn": true, "apiProvider": "firstParty"}
```

If it is not logged in, run `claude` interactively once and complete the browser login. The session state persists in `~/.claude/`. Once this works directly, the ACP adapter will work.

Make sure no stale token is overriding that login. `CLAUDE_CODE_OAUTH_TOKEN` in the environment beats `~/.claude/.credentials.json`, even right after a fresh `/login`. See [the auth boundary](acp-claude-code.md#the-auth-boundary).

### 3. Back up your current config and look at auth state

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-acp.$(date +%F)
openclaw models auth list
```

On 2026.10, auth profiles live in a SQLite store under the agent directory, not in per-agent `auth-profiles.json` files. `openclaw models auth list` prints the store path and every profile with its provider and type. Do not hand-edit the store.

---

## Step 1: Enable the ACPX plugin

On 2026.10 the `acpx` plugin is a stock plugin that embeds the ACP runtime, so there is no separate binary to install:

```bash
openclaw plugins list | grep -i acpx
openclaw config set plugins.entries.acpx.enabled true
```

On a 2026.4 to 2026.6 install, ACPX was a user-local package under `~/.openclaw/vendor/acpx` that the plugin was pointed at with a load path and a `command`. If you are migrating forward from that layout, delete the stale `plugins.load.paths` entry for the vendored package. My host still has a vendored copy pinned to `^0.19.2` for running the `acpx` CLI by hand, but the gateway does not load from it.

## Step 2: Register the plugin and ACP in openclaw.json

Use `openclaw config patch` for the edits below (a validated JSON5 merge: objects merge, arrays and scalars replace, `null` deletes a key, add `--dry-run` to preview). Use `config.apply` only when you mean to replace the whole file.

### 2a. Add ACPX to `plugins.allow`

`plugins.allow` is an exclusive allowlist. Any plugin not listed is blocked, even bundled ones. Add `acpx` to the list you already have. Arrays replace on patch, so read your current list first and write the full list back:

```bash
jq '.plugins.allow' ~/.openclaw/openclaw.json
```

### 2b. Turn ACP on and name the allowed agents

```json
{
  "acp": {
    "enabled": true,
    "backend": "acpx",
    "defaultAgent": "codex",
    "allowedAgents": ["claude", "claude-opus-5", "codex", "cursor", "opencode"]
  }
}
```

`allowedAgents` is the list of ACP agent ids that sessions may spawn. `claude` is a built-in ACPX harness alias. `claude-opus-5` is a custom id defined in the next step.

### 2c. Map the custom agent id to a wrapper script

```json
{
  "plugins": {
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

Notes on the config block:

- **`command`** is the absolute path to a wrapper script that runs the Claude ACP adapter with the model pinned. Under systemd, `PATH` is minimal and relative names do not resolve. The wrapper is two lines and is shown in [the ACP guide](acp-claude-code.md#the-wrapper-script).
- **`permissionMode`** defaults to `approve-reads`. Headless sessions cannot answer permission prompts, so writes and exec fail under the default. `approve-all` fixes that and is a real trust decision. Keep `allowedAgents` short.
- The old `config.command` plus `"input": "stdin"` plus `--permission-mode bypassPermissions` block from the 2026.4 layout is gone. The adapter speaks ACP over stdio, so the prompt never goes in as a positional argument.

---

## Step 3: Remove the old claude-cli pieces

### 3a. Drop a legacy `cliBackends` entry

```bash
openclaw config patch --stdin <<'EOF'
{ "agents": { "defaults": { "cliBackends": { "claude-cli": null } } } }
EOF
```

My live config has no `cliBackends` key at all. If yours does not either, skip this.

### 3b. Check the primary and fallback chain

```bash
jq '.agents.defaults.model' ~/.openclaw/openclaw.json
```

The primary should be the model you actually standardize on, with a short fallback list confined to providers you run and have tested. Fallback hops you have not exercised degrade quality silently when the primary hiccups. See [model retirement and fallbacks](model-retirement-and-fallbacks.md) for what an empty list costs you.

### 3c. Remove stale `anthropic:claude-cli` auth profiles

Subscription-token profiles for `anthropic:claude-cli` are no longer usable and can cause fallback roulette when another provider's rate limit trips. List and remove them through the supported command:

```bash
openclaw models auth list | grep -i claude-cli
openclaw models auth logout <profile-id>
```

`logout` asks for confirmation (`--yes` skips it) and takes `--agent <id>` if the profile belongs to a non-default agent. On 2026.10 there are no `auth-profiles.json` files to `jq` through. If you are migrating from 2026.4 and still have them, back them up first and remove the `claude-cli` profile with `jq`. OpenClaw has already imported such files into the SQLite store on my host (the agent directory holds `sqlite-import` backups of them), so a hand-edited JSON file may no longer be what the gateway reads.

### 3d. Decide what to do about `claude-cli` model entries

If `agents.defaults.models` carries `agentRuntime: { id: "claude-cli" }` entries for `anthropic/*` refs (as mine does), those are the current native-runtime route, not leftovers. Keep them if you use them in a picker, remove them if you do not. Do not remove `anthropic` from `plugins.allow` while any such entry remains, or you will get `Unknown model` for it.

---

## Step 4: Wire Claude as an ACP escalation target

### 4a. Create the wrapper

```bash
mkdir -p ~/.openclaw/vendor/claude-acp
cat > ~/.openclaw/vendor/claude-acp/claude-opus-5-acp.sh <<'EOF'
#!/usr/bin/env bash
# ACPX spawn wrapper: Claude ACP adapter with Claude Code pinned to one model.
export ANTHROPIC_MODEL=claude-opus-5
exec npx -y @agentclientprotocol/claude-agent-acp "$@"
EOF
chmod +x ~/.openclaw/vendor/claude-acp/claude-opus-5-acp.sh
```

### 4b. Spawn it by id

ACP sessions are addressed by agent id. From a chat, `/acp spawn claude-opus-5`. From an agent tool call, `sessions_spawn({ runtime: "acp", agentId: "claude-opus-5" })`. Run `/acp doctor` first if you are unsure the backend is healthy.

Optionally dedicate a Discord thread to direct Claude access so it stays isolated from your main session. Thread-bound ACP spawns need `session.threadBindings.spawnSessions=true` for the channel.

### 4c. Teach your main agent when to escalate

Put explicit escalation criteria in your AGENTS.md or equivalent. Mine, in shape:

```markdown
## Escalate to Claude via ACP when:
- Long-form reasoning over research dossiers
- Design critique (architecture, visual systems, UX)
- PR review that needs taste, not just correctness
- Security review where failure-mode analysis matters

Do NOT escalate for:
- Code generation -> a worker lane
- File scanning, grep, bulk ops -> a worker lane
- Email triage, cron output -> the main agent
```

Without explicit criteria the main agent either over-escalates (burns Claude quota) or never escalates (loses the quality gain).

---

## Step 5: Restart and check

ACP policy changes (`enabled`, `defaultAgent`, `allowedAgents`) apply to new sessions without a restart, and a plugin config change reloads the plugin. When in doubt:

```bash
systemctl --user restart openclaw-gateway
journalctl --user -u openclaw-gateway -n 50 --no-pager | grep -iE "acpx|acp|plugin"
```

You should see ACPX load cleanly and no `Unknown model: claude-cli/...` errors.

## Verification

```bash
# ACPX plugin is allowed and enabled
jq '.plugins.allow | index("acpx") != null' ~/.openclaw/openclaw.json
# Expected: true
openclaw plugins list | grep -i acpx
# Expected: a row showing acpx as enabled

# ACP is configured and the Claude id is allowed
jq '.acp | {enabled, backend, claude: (.allowedAgents | index("claude-opus-5") != null)}' ~/.openclaw/openclaw.json
# Expected: {"enabled": true, "backend": "acpx", "claude": true}

# The wrapper exists and is executable
jq -r '.plugins.entries.acpx.config.agents["claude-opus-5"].command' ~/.openclaw/openclaw.json | xargs test -x && echo "wrapper ok"

# No legacy cliBackends entry and no stale claude-cli auth profile
jq '.agents.defaults.cliBackends // "none"' ~/.openclaw/openclaw.json
openclaw models auth list | grep -ci claude-cli
# Expected: "none", then 0

# The primary model is the one you chose
jq '.agents.defaults.model.primary' ~/.openclaw/openclaw.json
```

### Live test

Spawn the agent in a chat (`/acp spawn claude-opus-5`) and send a message that matches your escalation criteria. Watch logs:

```bash
journalctl --user -u openclaw-gateway -f | grep -iE "acpx|spawn|agent"
```

You should see the ACP session initialize, the wrapper launch Claude Code as a child process, and the reply stream back. A clean status check without this live turn proves nothing about the wrapper or the credentials.

---

## Rollback

If the migration breaks something:

```bash
cp ~/.openclaw/openclaw.json.pre-acp.<DATE> ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway
```

If `claude` itself stopped working (Anthropic rolled out a new block), rollback does not help. You need to move your primary off Claude regardless, which is what this migration prepares you for.

---

## What You Lose in the Move

- **Claude no longer sees every incoming message.** The main agent does. If you valued Claude's injection resistance and nuance on every interaction, that goes away.
- **ACP sessions are separate sessions.** Cross-turn memory relies on your workspace files unless you keep a thread-bound session alive.
- **Response latency is higher.** ACP adds a subprocess hop and an `npx` adapter start. Expect seconds of overhead on top of normal model latency.
- **Tool use is mediated twice.** Claude Code has its own tool layer and OpenClaw wraps the ACP session. Keep escalation tasks narrow.

For most setups the trade is worth it: you keep Claude for the tasks where it helps and stop fighting Anthropic's subscription policy.

---

## Gotchas

1. **OpenClaw upgrades can reset plugin config.** Minor upgrades have dropped custom directives from the systemd unit and, less reliably, reset `plugins.entries`. After any upgrade, re-run `jq '.acp, .plugins.entries.acpx' ~/.openclaw/openclaw.json` and check the unit with `systemctl --user cat openclaw-gateway`.

2. **A stale environment token beats a good login.** `CLAUDE_CODE_OAUTH_TOKEN` overrides `~/.claude/.credentials.json`, including after `/login`. If the wrapper authenticates as the wrong identity or 401s right after a fresh login, check the gateway process environment (command in the [ACP guide](acp-claude-code.md#verification)).

3. **The Claude Code OAuth state is in `~/.claude/`, not OpenClaw's config.** Do not try to copy it into OpenClaw's auth store. The wrapper launches Claude Code as a subprocess and inherits its login.

4. **`--strict-mcp-config` semantics changed in Claude Code 2.1.92.** Positional args can be read as MCP config paths. This was why the old backend config needed `"input": "stdin"`. The ACP adapter does not take the prompt positionally, so the problem goes away, but any script that calls `claude` directly should pass the prompt on stdin.

5. **CLI backend warmup warnings can be cosmetic.** OpenClaw can log a warmup failure for a `claude-cli` model at startup if one is referenced anywhere, including dead fallback chains. Clean up the references. Do not try to silence the warning at the log layer.

6. **Do not put ACP Claude in the primary or fallback chain.** It is an escalation target invoked by agent id. The fallback chain is for when the primary provider is down, and an ACP session is slower and meant for specific task shapes.

7. **Anthropic may block the ACP path too.** The subscription terms let them update client detection at any time. If the escalation breaks, your options narrow to direct API billing or moving fully off Claude. Keep the rest of the stack resilient so Claude stays optional.
