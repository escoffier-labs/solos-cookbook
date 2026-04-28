# Multi-Model Orchestration

How to run multiple AI models in one OpenClaw setup, assign each to the right task tier, and stop burning expensive tokens on work that doesn't need them.

**Tested on:** OpenAI Pro ($200/mo Codex subscription), Anthropic Max via ACP, browser-LLM stack via Playwright + noVNC, Ollama local GPU
**Last updated:** 2026-04-19

---

## Why Multi-Model Matters

Running one model for everything is like hiring a senior architect to answer phones. Your orchestrator needs to be strong enough to handle ambiguity and adversarial input. Everything else can run cheaper or free.

This isn't about saving money. It's about using the right tool for each job. A 7B local model handles embeddings better than a frontier model wasting API calls on it. Browser-driven LLMs (Perplexity, Gemini web UI, Claude web UI) handle research and imagegen without burning API quota. Your orchestrator handles judgment and security decisions in the main loop.

## What Changed in April 2026

If you're coming from an older multi-model guide: **Anthropic blocked subscription OAuth (Claude Max) from third-party harnesses** in April 2026. The `claude-cli` backend no longer works as a main-agent backend. Opus 4.6 is still available via the ACPX plugin, but only as an escalation target, not the primary orchestrator.

See [claude-cli → ACP migration](claude-cli-to-acp-migration.md) for the full migration runbook.

The model chain below reflects the post-block world.

## The Model Chain

Always use the cheapest model that can handle the task. Escalate up only when the work demands it.

### Tier 1: Local Models via Ollama (Free)

Zero API costs. Zero latency. Zero data leaving your machine.

**Handles:**
- Semantic memory search embeddings
- Code search embeddings
- Git commit message generation
- Cron job triage (ESCALATE/SKIP decisions)

**Setup:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-embedding:8b    # embeddings for memory + code search
ollama pull qwen3-coder:14b       # commit messages, small code tasks
ollama pull qwen3:7b              # triage/screening
```

**OpenClaw config** (memory search using Ollama as OpenAI-compatible endpoint):

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai",
        "remote": {
          "baseUrl": "http://localhost:11434/v1/",
          "apiKey": "ollama"
        },
        "fallback": "none",
        "model": "qwen3-embedding:8b"
      }
    }
  }
}
```

**Hardware:** Any NVIDIA GPU with 8GB+ VRAM handles these models. Even a laptop GPU works for the embedding model.

### Tier 2: Orchestrator — GPT 5.4 via Codex Pro ($200/mo)

Your main agent. This is what receives every message, makes every decision, and spawns sub-agents for the heavy lifting.

**Why GPT 5.4 on Codex Pro:**
- Subscription cost is predictable ($200/mo flat)
- Codex OAuth works with OpenClaw's primary-model slot
- 5.4 medium thinking is strong enough for orchestration and delegation
- `:cron` and `:high` aliases let you tune thinking depth per task

**Handles:**
- Main orchestration (processing incoming messages, deciding actions)
- Code generation and review (coder role is the same model)
- File scanning, grep, bulk ops
- Architecture and planning
- Security decisions (evaluating untrusted input)
- Anything touching untrusted content (email, web scraping, group chats)

**Config:**

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai-codex/gpt-5.4",
        "fallbacks": [
          "openai-codex/gpt-5.3-codex"
        ]
      },
      "models": {
        "openai-codex/gpt-5.4": {
          "alias": "gpt54",
          "params": { "thinking": "medium" }
        },
        "openai-codex/gpt-5.4:cron": {
          "alias": "gpt54cron",
          "params": { "thinking": "low" }
        },
        "openai-codex/gpt-5.4:high": {
          "alias": "gpt54hi",
          "params": { "thinking": "high" }
        }
      }
    }
  }
}
```

The `:cron` and `:high` variants are the same model with different thinking budgets. Use `:cron` for scheduled background tasks where latency matters more than depth. Use `:high` for design work and architectural decisions.

**Fallback chain ordering matters.** Keep the fallback chain on providers you actually use. We keep `gpt-5.3-codex` as the sole fallback — both models share the Codex Pro subscription, so a fallback hop doesn't change your billing surface. Adding providers you don't actively run to the chain is asking for silent quality drops when the primary hiccups.

### Tier 3: Browser-LLM Stack — Playwright + noVNC

Instead of burning API quota (or fighting OAuth policy changes) for research and imagegen, we drive the web UIs of the frontier LLMs through Playwright. A persistent Chromium runs under Xvfb with noVNC attached so you can see what the headless browser is doing.

**Handles:**
- Deep research via Perplexity Pro
- Long-context analysis via the Gemini web UI (search grounding, file uploads)
- Imagegen via whichever web model is currently strongest
- "Second-opinion" passes against Claude.ai web or Gemini web from the orchestrator

**Why browser-driven instead of a CLI/API tier:**
- Uses the subscriptions you already pay for without API-billing complications
- Survives provider policy changes that break direct-API or OAuth paths (Anthropic's April 2026 move is exactly this class of problem)
- Gets features that aren't on the API (Perplexity's research mode, search-grounded responses, UI-only rendering paths)
- Concurrent sessions work via separate Chromium profiles and `flock`-based locking

**Setup sketch:**
- Xvfb + Chromium running headed-but-hidden
- x11vnc → noVNC so you (or an agent) can pop the session open in a browser
- Playwright-based skill in your workspace that launches against the persistent profile, performs the task, returns text/screenshots
- One profile per provider; `flock` on a per-provider lockfile so concurrent skill invocations serialize cleanly

This swaps a CLI backend for a tool surface. Your orchestrator calls the browser skill like any other tool, and the response comes back as text the agent can reason over.

### Tier 4: Escalation — Claude Opus 4.6 via ACP

Opus is no longer the main agent. It's now an escalation target for a specific set of tasks where its voice and reasoning quality still win.

**Handles:**
- Resume, intel, and design work
- Long-form reasoning and academic work (USF coursework, humanizer passes)
- PR review and architecture polish
- "Humanize" passes on machine-generated content

**How to invoke:**

Two paths:

1. **Dedicated Discord thread:** Open an ACP thread in Discord. Opus runs there, fully isolated from the main GPT 5.4 session.
2. **Orchestrator escalation:** Main agent calls `sessions_spawn(agentId: "acp-claude", task: "...")` when the task matches the escalation criteria.

The ACPX plugin ships as a user-local binary at `~/.openclaw/vendor/acpx/node_modules/.bin/acpx`. See the [ACP migration guide](claude-cli-to-acp-migration.md) for setup.

**When NOT to escalate:** Code generation (Codex is cleaner), file scanning (waste of context), mechanical ops work. Escalation is for *judgment and voice*, not labor.

## Example: How a Request Flows Through the Chain

```
1. Email arrives
   → Ollama (7B) triages: spam? SKIP. Important? ESCALATE.

2. Escalated email
   → GPT 5.4 reads it, decides response strategy, drafts reply

3. "Build me a dashboard"
   → GPT 5.4 writes the PRD and component spec
   → Spawns coder sub-agent (also GPT 5.4) to build it
   → Orchestrator reviews the output, does a polish pass

4. "Deep research this topic before I write about it"
   → GPT 5.4 calls the browser research skill (Perplexity Pro via Playwright)
   → Skill returns structured findings, orchestrator synthesizes

5. "Review this PR for architectural soundness"
   → GPT 5.4 recognizes escalation criteria, spawns ACP Opus thread
   → Opus reviews, returns structured findings

6. "Generate a banner image for this blog post"
   → GPT 5.4 calls the browser imagegen skill (Playwright against a persistent web-UI profile)
   → Returns the image, orchestrator delivers

7. Git commit
   → Ollama generates commit message locally. Zero API cost.

8. Memory search
   → Ollama embeds query with qwen3-embedding:8b, searches local vector store. Free.
```

The expensive escalation model only touches step 5. Everything else stays on the subscription tiers, runs in the browser against existing web subscriptions, or runs free.

## OpenClaw Agent Configuration

Define agents in the `agents.list` section of your `openclaw.json`:

```json
{
  "agents": {
    "list": [
      { "id": "main",  "model": "openai-codex/gpt-5.4" },
      { "id": "coder", "model": "gpt54" }
    ]
  }
}
```

Aliases resolve against `agents.defaults.models`. So `gpt54` above resolves to `openai-codex/gpt-5.4`.

Research is not a separate agent in this setup — it's a skill the main/coder invoke via the browser stack (see Tier 3).

Spawn sub-agents by ID:

```
sessions_spawn(agentId: "coder", task: "Build CRUD routes for this schema: ...")
```

## Token Optimization Patterns

### Heartbeat Batching

Instead of separate cron jobs for email, calendar, and notifications, batch them into one heartbeat. One context load, multiple checks. Saves thousands of input tokens daily.

### Sub-Agent Isolation

Spawn sub-agents for tasks that don't need your main session's context. A coder agent building a React component doesn't need your email history or personal notes. Isolated sessions start clean.

### Prompt Compression

Write tight, specific prompts for sub-agents. "Build CRUD routes for this schema" with the schema attached beats "Read all these files and figure out what to build." Less input tokens, better output.

### Thinking-Budget Tuning

The `gpt-5.4:cron` alias with `thinking: low` saves real tokens on scheduled work. A 5-minute email triage doesn't need medium thinking. Reserve medium/high for interactive work.

## Approximate Cost Breakdown

| Tier | Monthly Cost | What It Does | % of Work |
|------|-------------|--------------|-----------|
| Ollama (local) | $0 | Embeddings, commits, triage | ~40% |
| Browser-LLM stack | reuse existing web subs | Research, imagegen, second opinions | ~10% |
| Codex Pro | $200 | Orchestration + all code work | ~45% |
| ACP Opus (on Max) | bundled | Escalation only | ~5% |

The heavy lifter is Codex Pro. Opus via ACP is a quality escalation, not a workhorse, so it stays within the Max subscription's usage envelope. The browser-LLM stack costs whatever your existing Perplexity / Gemini / ChatGPT / Claude.ai subscriptions already cost — there's no additional per-request billing layered on top.

## Verification

Check your agent configuration:

```bash
# Verify agents are configured
jq '.agents.list | map({id, model})' ~/.openclaw/openclaw.json

# Verify primary + fallback chain
jq '.agents.defaults.model' ~/.openclaw/openclaw.json

# Verify Ollama is running with the embedding model
curl -s http://127.0.0.1:11434/api/tags | jq '.models[] | select(.name | contains("embed")) | .name'

# Verify ACPX plugin is loaded
jq '.plugins.allow | contains(["acpx"])' ~/.openclaw/openclaw.json
```

## Gotchas

1. **Pre-flight check your agents.** Before spawning, verify the agent ID maps to the model you expect. We got burned spawning Opus for code gen because the coder agent was temporarily misconfigured. `jq '.agents.list' ~/.openclaw/openclaw.json` is cheap insurance.

2. **Don't put budget models on untrusted input.** Your main orchestrator will encounter prompt injections in email, web scrapes, and group chats. That needs GPT 5.4 at minimum, not a local 7B.

3. **Ollama binds to 127.0.0.1 by default.** This is correct. Don't change it to 0.0.0.0 unless you have firewall rules restricting access. See the [Linux hardening guide](../security/linux-hardening.md).

4. **Subscription rate limits are real.** Codex Pro has weekly and hourly limits. The model chain helps: if 40% of your work runs on Ollama and 10% goes through the browser stack against your existing web subscriptions, you stay well within Codex's envelope.

5. **OpenAI OAuth rotating refresh tokens.** The Codex CLI desktop app and OpenClaw share the same refresh token. When one refreshes, the other's stored copy is invalidated. Symptom: `401 refresh_token_reused`. Fix: copy fresh token from `~/.codex/auth.json` to all OpenClaw auth-profiles.json files with `jq`, then restart the gateway.

6. **`openclaw models auth login` doesn't see openai-codex.** It only surfaces plugin providers. Codex OAuth is baked into the onboard wizard. Use `openclaw onboard --auth-choice openai-codex` or the manual token-copy path.

7. **ACPX binary is user-local.** It lives at `~/.openclaw/vendor/acpx/node_modules/.bin/acpx`, not in a global location. After OpenClaw upgrades, verify the `plugins.entries.acpx` block is still present — upgrades have been observed to reset plugin config.

8. **Xvfb starts black.** The headless X display Playwright runs against is black until Chromium actually loads a page. If you VNC in and see a black screen, that's normal — trigger a skill run and the browser will appear. Don't restart Xvfb in a panic.

9. **Browser skills need per-provider flock locks.** Two concurrent skill invocations on the same Chromium profile will clobber each other. A `flock` on `/tmp/browser-<provider>.lock` around the skill entry point keeps concurrent calls serialized per provider while different providers run in parallel. This is in the skill itself, not OpenClaw config — get it right once, forget about it.
