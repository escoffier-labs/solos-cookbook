# Multi-Model Orchestration

How to run multiple AI models in one OpenClaw setup, assign each to the right task tier, and stop burning expensive tokens on work that doesn't need them.

**Tested on:** Anthropic Max ($200/mo), OpenAI Pro ($200/mo), Ollama local GPU
**Last updated:** 2026-03-17

---

## Why Multi-Model Matters

Running one model for everything is like hiring a senior architect to answer phones. Your orchestration model (the one that reads email, processes documents, decides what to do) needs to be your strongest. Everything else can run cheaper or free.

This isn't about saving money. It's about using the right tool for each job. A 7B local model handles embeddings better than a frontier model wasting API calls on it. A code-specialized model generates cleaner code than a generalist. Your orchestrator handles ambiguity and adversarial input better than a budget model ever will.

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
ollama pull nomic-embed-text       # embeddings (274M params, tiny)
ollama pull qwen2.5-coder:14b     # commit messages, code tasks
ollama pull qwen2.5:7b            # triage/screening
```

**OpenClaw config** (memory search using Ollama as OpenAI-compatible endpoint):

```json
{
  "memorySearch": {
    "provider": "openai",
    "remote": {
      "baseUrl": "http://127.0.0.1:11434/v1/"
    },
    "model": "nomic-embed-text"
  }
}
```

**Hardware:** Any NVIDIA GPU with 8GB+ VRAM handles these models. Even a laptop GPU works for the embedding model.

### Tier 2: Budget Cloud Model (Cheap Tasks)

Fast, cheap, good for mechanical work that passed local triage.

**Handles:**
- Cron jobs (email summaries, backup reports, standups)
- File scanning and code grep across large codebases
- Bulk find/replace operations
- Boilerplate generation from templates
- Simple data extraction

**When to use:** If the task requires scanning, not thinking. "Look at these 50 files and tell me which ones contain X" is budget model work.

**When NOT to use:** Anything requiring judgment, creativity, or handling untrusted input. Budget models are more susceptible to prompt injection and make worse autonomous decisions.

### Tier 3: Code-Specialized Model (Structured Builds)

Models like GPT 5.x Codex, specialized for code generation from clear specs.

**Handles:**
- Code generation from detailed prompts
- Code reviews
- Test and documentation generation
- Refactoring with clear patterns

**Spawn pattern:** Your main agent writes the spec, then spawns a sub-agent to execute:

```
Main agent (Opus) writes detailed PRD/spec
  → Spawns Codex sub-agent with the spec
  → Codex builds it
  → Main agent reviews the output
```

### Tier 4: Frontier Model (Orchestration & Judgment)

Your main agent. The model that decides what to do and when.

**Handles:**
- Main orchestration (processing incoming messages, deciding actions)
- Architecture and planning
- Creative content (writing, documentation)
- Security decisions (evaluating untrusted input)
- Complex reasoning
- Anything touching untrusted content (email, web scraping, group chats)

**Why frontier for orchestration:** Two reasons. First, best prompt injection resistance. Your orchestrator sees every incoming message and will encounter adversarial input. Second, best judgment about when NOT to act. A cheaper model might execute an ambiguous instruction. A frontier model asks for clarification.

## Example: How a Request Flows Through the Chain

```
1. Email arrives
   → Ollama (7B) triages: spam? SKIP. Important? ESCALATE.

2. Escalated email
   → Opus reads it, decides response strategy, drafts reply

3. "Build me a dashboard"
   → Opus writes the PRD and component spec
   → Spawns Codex sub-agent to build it
   → Opus reviews the output, does a polish pass

4. "Search codebase for auth patterns"
   → Opus spawns budget model to scan files
   → Reviews the findings

5. Git commit
   → Ollama generates commit message locally. Zero API cost.

6. Memory search
   → Ollama embeds query, searches local vector store. Free.
```

The expensive model only touches steps 2, 3 (writing specs), and 4 (reviewing findings). Everything else runs cheaper or free.

## OpenClaw Agent Configuration

Define agents in your `openclaw.json`:

```json
{
  "agents": [
    {
      "id": "main",
      "name": "Main",
      "model": "anthropic/claude-opus-4-6"
    },
    {
      "id": "coder",
      "name": "Code Worker",
      "model": "openai-codex/gpt-5.4"
    },
    {
      "id": "researcher",
      "name": "Researcher",
      "model": "google-gemini-cli/gemini-3-pro-preview"
    }
  ]
}
```

Spawn sub-agents by ID:

```
sessions_spawn(agentId: "coder", task: "Build CRUD routes for this schema: ...")
```

## Token Optimization Patterns

### Heartbeat Batching

Instead of separate cron jobs for email, calendar, and notifications, batch them into one heartbeat every 30 minutes. One context load, multiple checks. Saves thousands of input tokens daily.

### Sub-Agent Isolation

Spawn sub-agents for tasks that don't need your main session's context. A Codex agent building a React component doesn't need your email history or personal notes. Isolated sessions start clean.

### Prompt Compression

Write tight, specific prompts for sub-agents. "Build CRUD routes for this schema" with the schema attached beats "Read all these files and figure out what to build." Less input tokens, better output.

## Approximate Cost Breakdown

| Tier | Monthly Cost | What It Does | % of Work |
|------|-------------|--------------|-----------|
| Ollama (local) | $0 | Embeddings, commits, triage | ~40% |
| Budget cloud | $5-10 | Scanning, bulk ops, cron jobs | ~15% |
| Code-specialized | Subscription | Code gen, reviews | ~25% |
| Frontier | Subscription | Orchestration, judgment | ~20% |

The frontier model handles 20% of the work, but it's the 20% that requires judgment, creativity, and security awareness.

## Verification

Check your agent configuration:

```bash
# Verify agents are configured
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
config = json.load(sys.stdin)
for agent in config.get('agents', []):
    print(f\"{agent['id']:15s} → {agent.get('model', 'default')}\")
"

# Verify Ollama is running
curl -s http://127.0.0.1:11434/api/tags | python3 -c "
import sys, json
models = json.load(sys.stdin).get('models', [])
for m in models:
    print(f\"{m['name']:30s} {m['size'] / 1e9:.1f}GB\")
"
```

## Gotchas

1. **Pre-flight check your agents.** Before spawning, verify the agent ID maps to the model you expect. We got burned spawning 4 Opus sub-agents for code gen because the coder agent was misconfigured.

2. **Don't put budget models on untrusted input.** Your main orchestrator will encounter prompt injections in email, web scrapes, and group chats. That needs your strongest model.

3. **Ollama binds to 127.0.0.1 by default.** This is correct. Don't change it to 0.0.0.0 unless you have firewall rules restricting access. See the [Linux hardening guide](../security/linux-hardening.md).

4. **Subscription models have rate limits.** Anthropic Max and OpenAI Pro both have hourly and weekly limits. The model chain helps here: if 80% of your work runs on cheaper tiers, you stay well within limits on the expensive tier.
