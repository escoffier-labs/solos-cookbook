# Migrating from claude-cli to ACP

How to move Claude Opus off the main-agent slot and onto an ACP escalation path after Anthropic blocked subscription OAuth from third-party harnesses in April 2026.

**Tested on:** OpenClaw 2026.4.x, Claude Code 2.1.92+, Claude Max subscription
**Last updated:** 2026-04-19

---

## What Changed

In April 2026, Anthropic started rejecting Claude Max subscription OAuth tokens when used through third-party harnesses (OpenClaw, OpenRouter-style proxies, etc.). The official Claude Code CLI still works with Max, but only when Anthropic's own client handles the handshake.

**The concrete impact on an OpenClaw host:**

- The bundled `anthropic` plugin's `claude-cli` backend stopped authenticating.
- Main-agent routing through `claude-cli/claude-opus-4-6` now returns `Unknown model` or auth errors.
- Any cron job, hook, or skill that assumed Opus was the primary model silently fails or falls back to another provider.

The path forward is to keep Opus reachable via the **Agent Client Protocol (ACP)** through the ACPX plugin. Claude Code runs natively on your machine as an ACP server; OpenClaw connects to it as a client. Anthropic's own CLI handles the Max OAuth handshake, and OpenClaw treats the resulting session as a sub-agent.

Opus becomes an **escalation target**, not a primary orchestrator. Your main agent runs on something else (we use GPT 5.4 via Codex Pro — see [multi-model orchestration](multi-model-orchestration.md)).

## Who This Is For

Anyone whose `openclaw.json` currently references:

- `anthropic/claude-*` as the primary model, OR
- `claude-cli/claude-*` as the primary model or a coder/researcher sub-agent, OR
- `agents.defaults.cliBackends.claude-cli` with a `command` path.

If none of those apply, you're already post-migration and can skip this guide.

## Pre-Migration Checks

### 1. Confirm Claude Code is Installed Natively

ACPX shells out to the Claude Code CLI. Install it first if you haven't:

```bash
# Official install
curl -fsSL https://claude.ai/install.sh | bash

# Or via npm
npm install -g @anthropic-ai/claude-code

# Confirm
claude --version
which claude
```

Note the absolute path (`which claude`). You'll need it for the ACPX config.

### 2. Confirm Claude Code Can Authenticate

```bash
claude --help
# Run an interactive session once to complete OAuth
claude
```

Authenticate with your Max subscription. The session state persists in `~/.claude/`. Once this works directly, ACPX will work.

### 3. Back Up Your Current Config

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-acp.$(date +%F)
```

Also back up the four auth-profiles files (OpenClaw sometimes stores a claude-cli profile in each):

```bash
for f in ~/.openclaw/agents/{main,coder,builder}/agent/auth-profiles.json \
         ~/.openclaw/workspace/.openclaw/agents/main/agent/auth-profiles.json; do
  [ -f "$f" ] && cp "$f" "$f.pre-acp.$(date +%F)"
done
```

---

## Step 1: Install the ACPX Plugin

ACPX is distributed as a user-local binary. It is not part of the OpenClaw core install.

```bash
mkdir -p ~/.openclaw/vendor/acpx
cd ~/.openclaw/vendor/acpx
npm init -y >/dev/null
npm install @openclaw/acpx@latest
```

Confirm the binary path:

```bash
ls ~/.openclaw/vendor/acpx/node_modules/.bin/acpx
# Should print the path. This is what OpenClaw invokes.
```

---

## Step 2: Register the Plugin in openclaw.json

Use `config.patch` for all edits below. Never `config.apply` unless you mean to replace the whole file.

### 2a. Add ACPX to `plugins.allow`

`plugins.allow` is an exclusive whitelist. Any plugin not listed is blocked, even bundled ones. Make sure ACPX is in:

```json
{
  "plugins": {
    "allow": [
      "telegram", "discord", "signal",
      "google", "browser", "openai", "zai", "brave",
      "memory-core", "tool-narration-guard", "content-scrubber",
      "acpx"
    ]
  }
}
```

### 2b. Register the Plugin Load Path

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/home/YOUR_USER/.openclaw/vendor/acpx/node_modules/@openclaw/acpx"
      ]
    }
  }
}
```

### 2c. Enable the Plugin Entry

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "command": "/absolute/path/to/claude",
          "args": ["--permission-mode", "bypassPermissions"],
          "input": "stdin"
        }
      }
    }
  }
}
```

Notes on the config block:

- **`command`** must be the absolute path to the Claude Code binary. Under systemd, `PATH` is minimal; relative names like `claude` won't resolve.
- **`--permission-mode bypassPermissions`** passes the CLI's permission classifier where `--dangerously-skip-permissions` hard-blocks. Same practical effect, different enforcement path.
- **`"input": "stdin"`** is required. Claude Code 2.1.92+ treats positional args as MCP config file paths when `--strict-mcp-config` is active, which breaks prompt passing.

---

## Step 3: Remove the Old claude-cli Backend

### 3a. Drop the cliBackends Entry

```json
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "claude-cli": null
      }
    }
  }
}
```

(Use `config.patch` with a null value to delete the key.)

### 3b. Remove claude-cli from the Primary/Fallback Chain

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai-codex/gpt-5.4",
        "fallbacks": [
          "openai-codex/gpt-5.3-codex"
        ]
      }
    }
  }
}
```

Replace the primary with whatever you're standardizing on. Keep the fallback list short and confined to providers you actively use — fallback hops you haven't tested will silently degrade quality when the primary hiccups.

### 3c. Delete claude-cli Auth Profiles

Subscription-OAuth profiles for `anthropic:claude-cli` are no longer usable. They can also cause fallback roulette if another provider's rate limit trips. Remove them:

```bash
for f in ~/.openclaw/agents/{main,coder,builder}/agent/auth-profiles.json \
         ~/.openclaw/workspace/.openclaw/agents/main/agent/auth-profiles.json; do
  [ -f "$f" ] && jq 'del(.profiles[] | select(.provider == "anthropic:claude-cli"))' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
```

### 3d. Remove the `anthropic` Plugin from `plugins.allow` (Optional)

If you're not using *any* Anthropic-provided model path, drop it from the whitelist. If you're keeping direct-API access for a specific escalation lane, leave it in.

**Warning:** Removing `anthropic` from `plugins.allow` also unregisters the `claude-cli` CLI backend symbol. If you later add `claude-cli/...` back to a model chain without re-enabling the plugin, you'll get `Unknown model: claude-cli/...`.

---

## Step 4: Wire Opus as an ACP Escalation Target

### 4a. Register the ACP Agent

```json
{
  "agents": {
    "list": [
      { "id": "main",       "model": "openai-codex/gpt-5.4" },
      { "id": "coder",      "model": "gpt54" },
      {
        "id": "acp-claude",
        "model": "acpx/claude-opus-4-6",
        "description": "Escalation target for resume, intel, design, review, humanize, academic work"
      }
    ]
  }
}
```

### 4b. Add a Discord Thread Pattern (Optional but Recommended)

Dedicate a Discord thread for direct Opus access. Posting in the thread routes straight to the ACP session, keeping Opus isolated from your main GPT 5.4 session:

```json
{
  "channels": {
    "discord": {
      "routing": {
        "threads": {
          "acp-opus": { "agentId": "acp-claude" }
        }
      }
    }
  }
}
```

Create the thread in Discord with the matching name (`acp-opus` or whatever you picked). The first message spins up the ACP session; subsequent messages continue it.

### 4c. Teach Your Main Agent When to Escalate

Update your AGENTS.md (or equivalent) with explicit escalation criteria. Mine:

```markdown
## Escalate to ACP Opus (via acp-claude) when:
- Resume/CV writing or review
- Long-form reasoning over intel dossiers
- Design critique (architecture, visual, content)
- PR review that needs taste, not just correctness
- "Humanize" passes on machine-generated content
- USF academic work (all of it)

Do NOT escalate for:
- Code generation → coder (GPT 5.4)
- File scanning, grep, bulk ops → coder
- Email triage, cron output → main (GPT 5.4)
```

Without explicit criteria, GPT 5.4 either over-escalates (burns Opus quota) or never escalates (loses the quality win).

---

## Step 5: Restart and Verify

```bash
systemctl --user restart openclaw-gateway
journalctl --user -u openclaw-gateway -n 50 --no-pager | grep -iE "acpx|claude|plugin"
```

You should see ACPX loading cleanly and no `Unknown model: claude-cli/...` errors.

### Verification Commands

```bash
# ACPX plugin is allowed + loaded
jq '.plugins.allow | contains(["acpx"])' ~/.openclaw/openclaw.json

# The binary exists
test -x ~/.openclaw/vendor/acpx/node_modules/.bin/acpx && echo "✓ binary present"

# No stale claude-cli references
grep -r "claude-cli" ~/.openclaw/openclaw.json \
  ~/.openclaw/agents/*/agent/auth-profiles.json 2>/dev/null \
  | grep -v "claude-cli.*null" || echo "✓ no stale claude-cli refs"

# Primary model is NOT on claude-cli
jq '.agents.defaults.model.primary' ~/.openclaw/openclaw.json
# Expected: a non-anthropic, non-claude-cli model string
```

### Live Test

Open the Discord ACP thread and send a message that matches your escalation criteria. Watch logs:

```bash
journalctl --user -u openclaw-gateway -f | grep -iE "acpx|spawn|agent"
```

You should see the ACP session initialize, Claude Code launch as a child process, and the response stream back.

---

## Rollback

If the migration breaks something:

```bash
cp ~/.openclaw/openclaw.json.pre-acp.<DATE> ~/.openclaw/openclaw.json
systemctl --user restart openclaw-gateway
```

If `claude` itself stopped working (Anthropic rolled out a new block), rollback doesn't help — you need to move your primary off Claude regardless. That's what this migration prepares you for.

---

## What You Lose in the Move

Worth naming honestly:

- **Opus no longer sees every incoming message.** The main agent does. If you valued Opus's injection resistance and nuance on every interaction, that goes away.
- **ACP sessions are short-lived by design.** Each invocation is a fresh Claude Code session. Cross-turn memory relies on your workspace files, not the model's context.
- **Response latency is higher.** ACP adds a subprocess hop. Expect 1–3s overhead on top of normal model latency.
- **Tool use is mediated twice.** Claude Code has its own tool layer. OpenClaw wraps the ACP session. Complex tool chains can get tangled — keep escalation tasks narrow.

For most users, the trade is worth it: you preserve access to Opus for the tasks where it shines, and you stop fighting Anthropic's subscription-OAuth policy.

---

## Gotchas

1. **OpenClaw upgrades can reset plugin config.** Every minor upgrade across the 2026.4.x line has silently dropped custom directives from the systemd unit and (less reliably) reset `plugins.entries`. After any upgrade, re-verify `jq '.plugins.entries.acpx' ~/.openclaw/openclaw.json` and `grep EnvironmentFile ~/.config/systemd/user/openclaw-gateway.service`.

2. **`--strict-mcp-config` semantics flipped.** Under the new Claude Code, positional args are MCP config paths, not prompts. Always use `"input": "stdin"` in the ACPX config.

3. **`--permission-mode bypassPermissions` vs. `--dangerously-skip-permissions`.** The flag names sound different but do the same thing at runtime. Bypass passes the harness's pre-exec classifier where the dangerous one gets caught. Use bypass.

4. **The Claude Code OAuth token is in `~/.claude/`, not OpenClaw's config.** Don't try to copy it into `auth-profiles.json`. ACPX launches Claude Code as a subprocess and inherits its auth state.

5. **CLI backend warmup warnings are cosmetic.** OpenClaw logs a warmup failure for `claude-cli/*` models at startup if any are referenced anywhere (including dead fallback chains). Clean up the references; don't try to silence the warning at the log layer.

6. **Don't put ACP Opus in the primary/fallback chain.** It's an escalation target, invoked by agent ID. The fallback chain is for cases where the primary provider is down. Opus via ACP is slower and meant for specific task shapes, not a generic fallback.

7. **Anthropic may block the ACP path too.** The Max subscription's terms let them update the client-detection heuristic anytime. If the ACP escalation also breaks, your options narrow to direct Anthropic API billing (pay-as-you-go) or moving fully off Claude. Keep the rest of your stack resilient so Opus remains optional.
