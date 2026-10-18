# Multi-Model Orchestration

How to run multiple AI models in one OpenClaw setup, assign each to the right task tier, and stop burning expensive tokens on work that doesn't need them.

**Tested on:** OpenClaw 2026.10.4, Claude Code 2.1.302, codex-cli 0.163.0, brigade 0.28.0, ACPX 0.19.x, Ollama 0.18 (local embeddings plus cloud models), OpenAI and Claude subscription lanes, browser lanes as systemd services (Chrome over CDP, noVNC for login)
**Last updated:** 2026-10-17

---

## Why Multi-Model Matters

Running one model for everything is like hiring a senior architect to answer phones. Your orchestrator needs to be strong enough to handle ambiguity and adversarial input. Everything else can run cheaper or free.

This isn't about saving money. It's about using the right tool for each job. A local embedding model handles memory and code retrieval better than a frontier chat model wasting quota on vector work. Browser-driven LLMs handle research and UI-only workflows, while OpenClaw's built-in image generation call handles `gpt-image-2` image jobs without browser automation. Your orchestrator handles judgment and security decisions in the main loop.

## What Changed Since the April 2026 Version of This Guide

Anthropic blocked subscription OAuth from third-party harnesses in April 2026, and the stack was rebuilt around that. Six months later the shape has settled:

- **The orchestrator is GPT 6.1 Sol** on a Codex subscription, running through the Codex runtime. GPT 5.5 and GPT 5.3 Codex are retired and survive only in this guide's history notes.
- **Claude models are reachable two ways.** Live config maps Opus 5.5 and Sonnet 5.5 to the `claude-cli` agent runtime in `agents.defaults.models`, and `acp.allowedAgents` lists a Claude ACP endpoint run through ACPX. I still drive long reviews through the first-party Claude Code harness in tmux, because it gives a recoverable session. Pick one path per job and do not stack them.
- **Bulk work moved out of the OpenClaw agent list.** The multi-vendor worker fleet (Brigade seats, T3 Code delegated tasks) does the building. OpenClaw keeps the conversation, the cron jobs, and a small browser agent.

See [claude-cli → ACP migration](claude-cli-to-acp-migration.md) for the Claude endpoint history and [Claude Code via tmux relay](claude-code-tmux-relay.md) for the recoverable review lane.

## The Model Chain

Always use the cheapest model that can handle the task. Escalate up only when the work demands it.

### Cheap vs Capable Is About Blast Radius, Not Just Budget

The tier rule has a second axis that the cost table hides. The question is never just "can a small model do this task?" It's "what does it cost me when the small model does the task *wrong*?"

The incident that taught me this: a Haiku-class sub-agent on a routine cron job read a local API's OpenAPI spec, found a `DELETE /api/index` endpoint, and called it three times unprompted. It wiped 71,000 indexed chunks and 28,000 LLM-generated summaries, roughly $40 of inference, on a job whose own inference cost was a fraction of a cent. The full post-mortem is in [agent security hardening](../security/agent-security-hardening.md), and the security lesson there is real: any model with tool access will eventually exercise every endpoint it can see, so remove the destructive paths.

But there's a model-selection lesson too. Match the tier to the *judgment* the lane requires, then to the blast radius the lane permits:

- **Cheap model, read-only lane: the sweet spot.** Triage, summaries, classification, embeddings. A wrong answer costs you a re-run. This is where Tier 1 earns its keep.
- **Cheap model, writable lane: the trap.** The savings on inference are dwarfed by one bad tool call. If a lane can mutate state, either fence the lane until a wrong action is survivable, or pay for the model that can tell a cleanup endpoint from a self-destruct button.
- **Expensive model, trivial lane: the slow leak.** Spawning the escalation model for work a small model handles is the same mistake in reverse. It burns quota you'll want later and shows up as a correction in every token audit I run (see [self-improving agents](self-improving-agents.md)).

The rule I actually operate by: **cheapest model that can handle the task, in the most fenced lane the task tolerates.** Cost-per-token and blast-radius-per-mistake are both part of "can handle."

### Tier 1: Local Models via Ollama (Free)

Zero API costs. Zero latency. Zero data leaving your machine.

**Handles:**
- Semantic memory search embeddings
- Code search embeddings

Commit messages and cron triage used to run on a local 7B and 14B model. I retired that: the only model resident on the box now is the embedding model (`ollama list` shows `qwen3-embedding:8b` plus cloud-tagged entries). Scheduled triage jobs pin GPT 6 Luna (15 of my 36 cron jobs name it explicitly, the rest inherit the default), which is cheap enough on the subscription that a second local model was not worth the VRAM and the upkeep.

**Embedding system:**

The current retrieval system standardizes on `qwen3-embedding:8b` through Ollama's local OpenAI-compatible endpoint.

OpenClaw memory search embeds the incoming query, then compares it against stored memory vectors. Code search uses the same embedding model, but it stores two kinds of vectors: direct code-chunk vectors and natural-language summary vectors. The summary vectors carry more of the search weight because humans usually search by intent, not by exact symbol names.

| Model | Role | Why it is used |
|---|---|---|
| `qwen3-embedding:8b` | Embeddings for memory search, code search, and semantic similarity | Local, zero API cost, 4096-dimensional vectors, strong enough retrieval quality, and one consistent vector space across memory and code |
| `qwen3-coder-next:cloud` | Summary helper before embedding code chunks | Cheap structured summaries with good identifier retention. It improves semantic search, but it is not the embedding model |

Do not swap embedding models casually. If the embedding model changes, re-index the stored vectors instead of only changing config.

**Setup:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-embedding:8b    # embeddings for memory + code search
```

**OpenClaw config** (memory search using Ollama as an OpenAI-compatible endpoint). On 2026.10 this lives under top-level `memory.search`, not under `agents.defaults.memorySearch`:

```json
{
  "memory": {
    "citations": "auto",
    "search": {
      "provider": "openai",
      "remote": {
        "baseUrl": "http://127.0.0.1:11434/v1/",
        "apiKey": "<ollama-placeholder-key>"
      },
      "fallback": "none",
      "model": "qwen3-embedding:8b"
    }
  }
}
```

My live file stores the key as a file-backed secret reference rather than a literal string. Ollama ignores the key value, so any non-empty placeholder works.

**Hardware:** Any NVIDIA GPU with 8GB+ VRAM handles these models. Even a laptop GPU works for the embedding model.

### Tier 1b: Ollama Cloud Models

Ollama Cloud is the middle lane between local models and frontier subscriptions. It is useful for bulk summarization, strict-format offload chores, commit message and changelog prep, and model bakeoffs where you want cheap cloud inference without moving the main orchestrator.

**Results from the April 2026 bakeoffs** (a snapshot, re-run the gauntlet before trusting it for a new model generation):
- `qwen3-coder-next:cloud`: best default for code-search summaries and strict structured offload.
- `kimi-k2.6:cloud`: best tested fallback for code-search summaries, strongest identifier retention, but slower and more verbose.
- `gemma4:31b-cloud`: clean generalist, but reject for bulk code-search summaries because of lower retention and severe tail latency.
- `deepseek-v4-flash:cloud`: promising, but needs thinking behavior controlled and had worse tail latency.
- `deepseek-v4-pro:cloud`: clean when it returns, but reject for bulk code-search summaries because the April 28 run had 7 failures, two 180s timeouts, low retention, and severe tail latency.
- `minimax-m2.7:cloud`: useful for deeper supervised agent work, not for terse code-search summaries.

**Code-search backfill gauntlet, April 25 and April 28:**

| Model | Success | Median | P95 | Key retention | Decision |
|---|---:|---:|---:|---:|---|
| `qwen3-coder-next:cloud` | 100/100 | 1.64s | 3.01s | 0.293 | Primary |
| `kimi-k2.6:cloud` | 100/100 | 2.59s | 4.76s | 0.296 | Fallback |
| `gemma4:31b-cloud` | 100/100 | 2.16s | 31.11s | 0.247 | Reject for bulk summaries |
| `deepseek-v4-flash:cloud` | 100/100 | 1.88s | 14.41s | 0.288 | Candidate |
| `deepseek-v4-pro:cloud` | 93/100 | 2.29s | 56.24s | 0.218 | Reject |
| `deepseek-v3.2:cloud` | 100/100 | 5.61s | 8.78s | 0.212 | Too slow |
| `minimax-m2.7:cloud` | 27/100 | 5.93s | 9.69s | 0.189 | Reject |

**Setup:**

```bash
ollama signin
ollama pull qwen3-coder-next:cloud
ollama pull deepseek-v4-flash:cloud
```

Local tools can call cloud models through the localhost Ollama daemon after `ollama signin`. For direct hosted calls to the Ollama cloud API (`https://ollama.com`), use the provider auth flow documented by Ollama. For most OpenClaw automation, the simpler path is to sign in once with `ollama signin` and let local tools call the cloud models through the localhost Ollama daemon.

Check Ollama's current plan page for cloud limits before you plan around them: usage is metered as infrastructure utilization with session and weekly windows, and the numbers have changed more than once. Cloud-tagged models are used here for bulk summaries and bakeoffs, not for anything that touches untrusted input.

### Tier 2: Orchestrator: GPT 6.1 Sol via Codex subscription

Your main agent. This is what receives every message, makes every decision, and spawns sub-agents or dispatches workers for the heavy lifting.

**Why GPT 6.1 Sol on a Codex subscription:**
- Subscription cost is predictable and flat
- Codex OAuth works with OpenClaw's primary-model slot, and `agentRuntime: { "id": "codex" }` runs it through the Codex harness
- Strong enough for orchestration, tool use, and delegation
- Short aliases (`sol61`, `luna6`) make cron jobs and agent entries readable

This is the recommended stack when the agent is active every day or the same subscription also does heavy repo work. Keep light, repeatable work on the cheaper Luna model so Sol's quota goes to orchestration and hard slices.

**Handles:**
- Main orchestration (processing incoming messages, deciding actions)
- Architecture and planning
- Security decisions (evaluating untrusted input)
- Anything touching untrusted content (email, web scraping, group chats)

Bulk implementation does not belong here anymore. It goes to the worker fleet below.

**Config** (shape taken from the live file, secrets and IDs omitted):

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-6.1-sol",
        "fallbacks": []
      },
      "models": {
        "openai/gpt-6.1-sol": { "alias": "sol61", "agentRuntime": { "id": "codex" } },
        "openai/gpt-6-sol":   { "alias": "sol6",  "agentRuntime": { "id": "codex" } },
        "openai/gpt-6-luna":  { "alias": "luna6", "agentRuntime": { "id": "codex" } },
        "anthropic/claude-opus-5-5":   { "agentRuntime": { "id": "claude-cli" } },
        "anthropic/claude-sonnet-5-5": { "agentRuntime": { "id": "claude-cli" } }
      },
      "modelPolicy": {
        "allow": [
          "openai/gpt-6.1-sol",
          "openai/gpt-6-luna",
          "anthropic/claude-opus-5-5",
          "anthropic/claude-sonnet-5-5"
        ]
      },
      "subagents": { "maxConcurrent": 8, "model": "openai/gpt-6-luna" }
    }
  }
}
```

Three things changed from the 2026.4 shape:

- Model refs use the `openai/` prefix. The old `openai-codex/` prefix is gone.
- The runtime is chosen per model entry with `agentRuntime`, not implied by the provider.
- `agents.defaults.modelPolicy.allow` is an allowlist. A model that is not on it is refused, which is a cheap guard against a stale alias or a cron payload that names a retired model. My `models` map also carries a few aliases that are not on the allowlist, so keep the two lists in step on purpose rather than by accident.

**My fallback list is empty.** `openclaw models fallbacks list` prints `Fallbacks (0)`. With a single primary and no chain, a Sol outage or a quota event surfaces as an error instead of a quiet downgrade. That is easier to notice than a silent hop, but it also means no automatic recovery. I treat it as a gap to close rather than a design to copy: [Model retirement and fallbacks](model-retirement-and-fallbacks.md) explains the trap it leaves open and how I check for it.

### The worker fleet: Brigade seats and T3 Code tasks

OpenClaw is the conversation and scheduling layer. Substantial or parallel implementation runs in a separate worker fleet, and the orchestrator picks a seat the way it would pick a tool.

**Dispatch surfaces**

| Surface | What it is | Use it for |
|---|---|---|
| `brigade run` | Plans a task, dispatches it to roster seats, synthesizes the result. `--worker <seat>` skips planning and sends the whole task to one seat. `--worktree` isolates edits in a detached git worktree, `--read-only` forbids edits, `--wait` queues behind an active run lock. | Multi-step or parallel implementation, reviews, anything that should leave an artifact trail |
| T3 Code delegated tasks | A T3 Code session exposes `delegate_task` and a fleet client for launching, monitoring, and recovering child sessions on any connected host. | Claude and Codex work that benefits from its own session and worktree |
| Antigravity (`agy`) | Gemini seat on a Gemini subscription. | Fast read-only scouting and research |
| `brigade run cloud launch` | Launches a Jules or Cursor Cloud session from a prompt file. | Self-contained repository issues that can run unattended |

**Seat shapes.** A roster seat names a CLI, a model, a timeout, whether it can run read-only, and a one-line role:

```toml
[agents.sol61]
cli = "codex"
model = "gpt-6.1-sol"
reasoning = "high"
timeout_seconds = 1500
read_only_capable = true
role = "Implement bounded slices with regression evidence."

[agents.luna6]
cli = "codex"
model = "gpt-6-luna"
reasoning = "medium"
timeout_seconds = 900
read_only_capable = true
role = "Bounded read-only research, issue triage, and test-gap analysis."

[agents.opus55]
cli = "claude"
model = "opus"
read_only_capable = true
role = "Independent architecture and correctness review."
```

The roster also carries a Gemini scout seat on Antigravity, a Sonnet seat for compatibility and test review, and a security-review seat. A top-level `allow_models` list in `[limits]` decides which CLIs a run may use, and a seat whose CLI is not allowed is a hard error, so adjusting quota-driven routing is a one-line edit.

**Routing policy I run**

| Work | Lane |
|---|---|
| Building, grounding, drafting, fixes, QA | Claude Sonnet 5.5 |
| Final review, architecture, disputed judgment | Claude Opus 5.5 |
| Routine implementation, triage, research | GPT 6 Luna |
| Harder implementation slices | GPT 6.1 Sol |
| Fast read-only scouting | Gemini 3.8 Flash through Antigravity |
| Security review | A dedicated security-review seat |
| Second and third opinions on consequential decisions | Fable 5.1 and GPT 6 Astra |

The roster file, not this table, decides what is actually callable on a given day. Seats go quiet when a quota runs out or a health probe fails, so check before dispatching:

```bash
brigade fleet models list     # hub roster: seat, model, enabled flag, concurrency limit
brigade fleet status          # latest run state per node
brigade fleet claims          # active repo claims
```

`brigade fleet claims` shows which repository a live run already owns. A live claim is ownership, so wait or pick another target instead of starting a second run.

For one-shot `claude --print` workers, pin `--model opus`, keep each invocation to a single flat pass, and disable the `Task` and `Agent` tools so the worker cannot fan out on its own.

### Focused harness sub-agents

The harness matters as much as the model. The same model behaves differently under a repo-aware coding harness than under a chat runtime.

| Focused lane | Harness | Use it for |
|---|---|---|
| `main` | OpenClaw runtime on the Codex harness, Sol 6.1 | Conversation handling, routing, tool orchestration, safety decisions |
| `browser-operator` | OpenClaw runtime, Luna 6, minimal tool profile plus `browser` and credential-fill tools | Authenticated browser tasks, one narrow skill |
| Brigade `sol61` / `luna6` seats | Codex CLI | Multi-file builds, refactors, test-driven fixes, read-only research |
| Brigade `opus55` seat or Claude Code in tmux | Claude Code | Architecture review, security review, design critique |

The in-gateway `agents.entries` list is deliberately short. Everything else is a Brigade seat.

### Tier 3: Browser-LLM Stack: Playwright + noVNC

Instead of fighting OAuth policy changes for research and UI-only workflows, we drive the web UIs of frontier models through Playwright. A persistent Chromium runs under Xvfb with noVNC attached so you can see what the headless browser is doing.

**Handles:**
- Deep research via Perplexity Pro
- Long-context analysis via the Gemini web UI (search grounding, file uploads)
- Web-only visual workflows that the built-in image call does not cover
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
- One profile per provider. `flock` on a per-provider lockfile so concurrent skill invocations serialize cleanly

This swaps a CLI backend for a tool surface. Your orchestrator calls the browser skill like any other tool, and the response comes back as text the agent can reason over.

### Tier 3a: Built-in OpenClaw Image Generation: gpt-image-2

Current OpenClaw has a first-class image generation call. Use it before browser automation for normal image jobs.

The OpenAI image provider defaults to `gpt-image-2` when configured. It supports generation, edits with up to five reference images, PNG/JPEG/WebP output, and common square, portrait, landscape, and 4K sizes.

Example call shape:

```ts
image_generate({
  model: "openai/gpt-image-2",
  prompt: "Clean technical diagram of a multi-model agent stack",
  size: "2048x1152",
  outputFormat: "png"
})
```

My config sets no explicit `imageModel` (`openclaw models status --json` shows `imageModel: null`), so the call falls through to the provider default. Set one with `openclaw models set-image` if you want it pinned.

Use the browser path when the job needs a web-only product feature, a logged-in UI workflow, or manual visual review. Otherwise, `image_generate` is cleaner, repeatable, and easier to wire into automation.

### Tier 4: Escalation: Opus 5.5 for review and architecture

Opus is not the main agent. It is the escalation target for review, architecture, and disputed judgment, where the quality difference pays for the quota.

**Handles:**
- Architecture review
- Security review (alongside the dedicated security-review seat)
- Design critique
- Long-form reasoning and research-heavy analysis
- PR review when a second opinion is worth the quota

**How to invoke:**

1. **Brigade seat.** `brigade run --worker opus55 --read-only "<review prompt>"` sends one bounded review to a Claude seat and returns the report as a run artifact.
2. **Tmux relay.** Start a named Claude Code tmux session in `--permission-mode plan`, send a bounded review prompt, then capture the pane as a local review artifact. This keeps the review inside the first-party harness with a recoverable session.
3. **ACP endpoint.** Use ACPX only when OpenClaw itself needs an ACP endpoint. The live `acp.allowedAgents` list includes Claude, Codex, Cursor, and OpenCode endpoints.

The relay helper lives in [`../templates/ai-stack/claude-tmux-relay.sh`](../templates/ai-stack/claude-tmux-relay.sh). See [Claude Code via tmux Relay](claude-code-tmux-relay.md) for the handoff commands, and the [ACP migration guide](claude-cli-to-acp-migration.md) when you need ACPX.

**When NOT to escalate:** Code generation, file scanning, bulk edits, and mechanical ops work. Escalation is for judgment, not labor.

## Example: How a Request Flows Through the Chain

```
1. Email arrives
   → A Luna-pinned cron job triages: spam? SKIP. Important? ESCALATE.

2. Escalated email
   → Sol 6.1 reads it and decides the response strategy

3. "Build me a dashboard"
   → Sol 6.1 writes the spec
   → Dispatches a Brigade implementation seat (Sol for a hard slice, Luna for routine parts)
   → Orchestrator reviews the output and runs the verification gate

4. "Deep research this topic before I make a decision"
   → Sol 6.1 sends a read-only scouting task to a Gemini Flash seat, or calls the browser research skill
   → Findings come back as text, orchestrator synthesizes

5. "Review this PR for architectural soundness"
   → Sol 6.1 dispatches the Opus seat in read-only mode
   → Opus returns structured findings; a security-review seat runs in parallel if the diff touches auth or secrets

6. Memory search
   → Ollama embeds the query with qwen3-embedding:8b, searches the local vector store. Free.
```

Opus only touches step 5. Everything else stays on the cheaper subscription lanes, the browser stack, or local embeddings.

## OpenClaw Agent Configuration

On 2026.10 the agent roster lives under `agents.entries`, with an `ownership` field, instead of the old `agents.list` array. Mine has two entries:

```json
{
  "agents": {
    "ownership": "explicit",
    "entries": {
      "main": {
        "model": { "primary": "openai/gpt-6.1-sol", "fallbacks": [] },
        "thinkingDefault": "medium",
        "subagents": { "allowAgents": ["browser-operator"] }
      },
      "browser-operator": {
        "model": { "primary": "openai/gpt-6-luna", "fallbacks": [] },
        "thinkingDefault": "low",
        "skills": ["browser-automation"],
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["browser", "browser_credential_fill"],
          "elevated": { "enabled": false }
        }
      }
    }
  }
}
```

With `ownership: "explicit"` and more than one agent, also set `agents.defaults.systemAgent.agentId` (mine is `main`) or cover every channel with a binding. Otherwise traffic and jobs with no matching route have no owner. `main` is deliberately absent from its own `allowAgents`: listing it would let the orchestrator spawn more orchestrators instead of staying in the narrow lane.

Aliases (`sol61`, `luna6`) resolve against `agents.defaults.models`. Check them with `openclaw models aliases list`.

There is no `coder` agent. Coding goes to Brigade seats, review goes to a Claude seat, and research is a read-only seat or a browser skill. Spawn an in-gateway sub-agent only for the narrow browser job:

```
# In-gateway sub-agent (only agents named in allowAgents)
sessions_spawn(agentId: "browser-operator", task: "Open the dashboard and export the report.")
```

```bash
# Serious repo work through a Brigade seat
brigade run --worker sol61 --worktree "Build CRUD routes for this schema: ..."

# Review lane through Claude Code's tmux relay
templates/ai-stack/claude-tmux-relay.sh send \
  "Review this architecture for failure modes. Findings first. Do not edit files."
```

## Token Optimization Patterns

### Sub-Agent Isolation

Spawn sub-agents for tasks that don't need your main session's context. A worker building a React component doesn't need your email history or personal notes. Isolated sessions start clean. The gateway caps concurrency (`agents.defaults.subagents.maxConcurrent` is 8 here), and its default sub-agent model is Luna.

### Prompt Compression

Write tight, specific prompts for sub-agents. "Build CRUD routes for this schema" with the schema attached beats "Read all these files and figure out what to build." Less input tokens, better output.

### Thinking-Budget Tuning

Set `thinkingDefault` per agent entry: `medium` for the main agent, `low` for the browser agent. Scheduled work that does not need depth belongs on Luna rather than on a lowered Sol setting. Reserve higher reasoning for hard implementation slices (the `sol61` seat runs `reasoning = "high"`).

### Heartbeat Batching

If you run a heartbeat, batch email, calendar, and notification checks into it instead of running separate cron jobs. I currently run with `heartbeat.every` set to `"0m"` (off) and use explicit cron jobs, which are easier to audit. See [cron patterns](../automation/cron-patterns.md).

## Approximate Cost Breakdown

| Tier | Cost model | What It Does |
|------|-----------|--------------|
| Ollama (local) | Hardware only | Embeddings for memory and code search |
| Ollama cloud models | Plan-based | Bulk summaries, strict offload, bakeoffs |
| Built-in image generation | Provider-backed | Image generation and edits |
| Browser-LLM stack | Existing web subscriptions | Research, web-only workflows, second opinions |
| Codex subscription | Flat | Orchestration plus Sol and Luna worker seats |
| Claude subscription | Flat | Opus and Sonnet seats, tmux review lane |
| Gemini subscription | Flat | Flash scouting through Antigravity |

Every lane rides a subscription or a local box. The point of the roster is to spend each subscription's quota on the work it is best at and to keep one exhausted pool from stopping the others: when a quota runs out, remove that CLI from `allow_models` and the run routes around it.

## Verification

Check your agent configuration:

```bash
# Primary model and fallbacks
jq '.agents.defaults.model' ~/.openclaw/openclaw.json
# Expected: {"primary": "openai/gpt-6.1-sol", "fallbacks": []} (or your own chain)

# Agents and their models
jq '.agents.entries | map_values(.model.primary)' ~/.openclaw/openclaw.json

# Aliases and the allowlist
openclaw models aliases list
jq '.agents.defaults.modelPolicy.allow' ~/.openclaw/openclaw.json

# Memory search points at the local embedding model
jq '.memory.search | {provider, model}' ~/.openclaw/openclaw.json
# Expected: {"provider": "openai", "model": "qwen3-embedding:8b"}

# Ollama is up and the embedding model is pulled
curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[].name | select(contains("embed"))'

# Worker fleet: which seats are enabled right now
brigade fleet models list
# Expected: a table of provider, model, seat, enabled (yes/no), limit, binding

# A Claude Code tmux review session is reachable (if you use the relay)
tmux has-session -t claude-code-review

# ACPX is allowed (only if you use ACP)
jq '.plugins.allow | index("acpx") != null' ~/.openclaw/openclaw.json
```

## Gotchas

1. **Pre-flight check your agents.** Before spawning, verify the agent ID maps to the model you expect. `jq '.agents.entries | map_values(.model.primary)' ~/.openclaw/openclaw.json` is cheap insurance. I once spawned Opus for code generation because a coder agent was misconfigured.

2. **Don't put budget models on untrusted input.** Your main orchestrator will encounter prompt injections in email, web scrapes, and group chats. That needs the strongest model you run as the orchestrator, not a local 7B and not a free-tier worker.

3. **Ollama binds to 127.0.0.1 by default.** This is correct. Don't change it to 0.0.0.0 unless you have firewall rules restricting access. See the [Linux hardening guide](../security/linux-hardening.md).

4. **Subscription rate limits are real.** A weekly quota can run out mid-week. The Brigade roster is the pressure valve: take the exhausted CLI out of `allow_models` and the remaining seats absorb the work. A seat whose CLI is not allowed is a hard error, so comment out the seat block in the same edit.

5. **OpenAI OAuth rotating refresh tokens.** The desktop Codex CLI and OpenClaw can share a refresh token. When one refreshes, the other's stored copy is invalidated. Symptom: `401 refresh_token_reused`. See [oauth token lifecycle](oauth-token-lifecycle.md) for the current recovery path.

6. **ACP wrappers are user-local.** On 2026.10 the ACPX runtime is embedded in OpenClaw, but the wrapper scripts your `acpx` agents point at live under OpenClaw's user-local vendor directory, not in a global location. After OpenClaw upgrades, verify the `plugins.entries.acpx` block is still present. Upgrades have been observed to reset plugin config.

7. **Claude has two live paths and they are easy to confuse.** The `claude-cli` runtime entries in `agents.defaults.models` and the ACP endpoints in `acp.allowedAgents` are separate mechanisms. If a Claude model errors, find out which one the request took before debugging the other.

8. **Do not trust the fleet to be wide open.** An idle seat can still be unavailable: a health probe, a quota, or an `allow_models` edit can take it out. Run `brigade fleet models list` before you promise someone a particular lane.

9. **Xvfb starts black.** The headless X display Playwright runs against is black until Chromium actually loads a page. If you VNC in and see a black screen, that's normal. Trigger a skill run and the browser will appear.

10. **Browser skills need per-provider flock locks.** Two concurrent skill invocations on the same Chromium profile will clobber each other. A `flock` on `/tmp/browser-<provider>.lock` around the skill entry point keeps concurrent calls serialized per provider while different providers run in parallel. This is in the skill itself, not OpenClaw config.

## History

- **April 2026:** Anthropic blocked subscription OAuth from third-party harnesses. The `claude-cli` backend stopped working as a main-agent backend then. Opus moved to an escalation role.
- **June 2026:** GPT 5.5 on Codex was the orchestrator, with GPT 5.3 Codex as the sole fallback, `:cron` and `:high` model suffix aliases, and a dedicated `coder` agent. All retired.
- **October 2026:** Sol 6.1 became primary, the model suffix aliases were dropped in favor of separate models and `agentRuntime`, and the worker fleet took over bulk implementation.
