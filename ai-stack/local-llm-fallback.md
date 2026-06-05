# Local LLM Fallback

> Use local models for boring, bounded work so your paid models stay available for judgment.

**Tested on:** OpenClaw 2026.4.x with Ollama local models, local embeddings, and cloud-model offload lanes
**Last updated:** 2026-05-11

## What this is

A local LLM fallback is a cheap utility lane for work that does not need a frontier model: embeddings, commit-message drafts, simple classification, dedupe, and first-pass triage. It is not a replacement for your orchestrator, and it should not sit blindly in the main model fallback chain.

The shape is: keep Ollama local, expose it through a loopback-only API, route only bounded jobs to it, and escalate anything ambiguous back to the main agent.

## Why this way

Local models are excellent when the task is narrow and the consequence of a weak answer is low. They are also fast enough to use constantly, which matters for memory search and background maintenance.

They are a bad fit when the task needs policy judgment, adversarial reasoning, tool orchestration, or high-quality user-facing prose. A small local model can look confident while being wrong. The fallback policy has to make that failure mode boring: local models may suggest, label, embed, summarize trusted input, or decline. They should not silently decide.

This is the key distinction:

- **Good local fallback:** "Classify this cron item as `skip`, `reply`, or `escalate`. Return JSON only."
- **Bad local fallback:** "The primary model failed, so let a small local model continue the main conversation."

## Prerequisites

- Linux host with enough RAM or VRAM for the selected models
- Ollama installed and reachable only from the local machine or a protected control plane
- `jq` for verification commands
- An orchestrator that can call model-specific helpers or route tasks by alias
- A willingness to re-index embeddings when the embedding model changes

## Before / After

Before:

- Every small background task spends main-model quota.
- Memory search depends on a remote embedding API.
- Commit messages and changelog chores wait on the main agent.
- Cron triage either uses the expensive model or trusts a weak model too much.
- Fallback chains silently degrade quality when a provider hiccups.

After:

- Local embeddings power memory and code search.
- Utility prompts run through named local aliases.
- Triage returns constrained labels and escalates uncertainty.
- The main model fallback chain stays short and high-quality.
- Local failures are visible health-check failures, not invisible quality drops.

## Implementation

### 1. Define what local models are allowed to do

Start with an allowlist. If a task is not on the allowlist, route it to the main agent.

Good local jobs:

| Job | Output shape | Escalate when |
|-----|--------------|---------------|
| Memory embeddings | vector | model changed or index is stale |
| Code-search embeddings | vector | repository language or chunker changed |
| Commit-message draft | short text | diff is large, security-sensitive, or mixed-purpose |
| Cron triage | JSON label | confidence is low or action has external effects |
| Duplicate detection | boolean plus reason | match is fuzzy or user-visible |
| Trusted-doc summary | bullets or JSON | source is untrusted or contradicts memory |

Bad local jobs:

- main conversational fallback
- final security decisions
- high-stakes financial, legal, or medical advice
- untrusted web or email instructions without a stronger model reviewing them
- public publishing actions
- multi-step tool orchestration

### 2. Install only the models you actually route to

Pull a small set and give each a job:

```bash
ollama pull qwen3-embedding:8b
ollama pull qwen3:7b
ollama pull qwen3-coder:14b
```

Example roles:

| Model | Role | Notes |
|-------|------|-------|
| `qwen3-embedding:8b` | memory and code-search embeddings | keep stable, re-index if changed |
| `qwen3:7b` | constrained triage and labels | require JSON, short outputs, and escalation labels |
| `qwen3-coder:14b` | commit-message and code-summary drafts | inspect output before using it |

The exact models can change. The durable rule is to tie each local model to a job, benchmark it on that job, and remove it if it drifts.

### 3. Keep the endpoint local

Ollama should bind to a loopback address by default. Keep that default unless you have a real network boundary around it.

Use placeholders in shared docs and templates:

```json
{
  "baseUrl": "<ollama-openai-compatible-base-url>",
  "apiKey": "ollama"
}
```

Store the real endpoint in local config or environment:

```bash
export OLLAMA_OPENAI_BASE_URL="<ollama-openai-compatible-base-url>"
```

Do not publish local service ports, hostnames, or private bind addresses in public config snippets.

### 4. Wire embeddings separately from chat

Embedding models are infrastructure, not chat fallbacks. Configure memory search as its own surface:

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai",
        "remote": {
          "baseUrl": "<ollama-openai-compatible-base-url>",
          "apiKey": "ollama"
        },
        "fallback": "none",
        "model": "qwen3-embedding:8b"
      }
    }
  }
}
```

If you change `qwen3-embedding:8b` to another embedding model, rebuild the index. Vector spaces are not interchangeable.

### 5. Use named utility aliases

Put local models behind explicit aliases so call sites reveal intent:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "ollama/qwen3:7b": {
          "alias": "localTriage",
          "params": {
            "temperature": 0,
            "numPredict": 256
          }
        },
        "ollama/qwen3-coder:14b": {
          "alias": "localCommit",
          "params": {
            "temperature": 0.2,
            "numPredict": 512
          }
        }
      }
    }
  }
}
```

Do not add `localTriage` or `localCommit` to the main fallback chain. Call them deliberately from tools, hooks, cron jobs, or helper scripts.

### 6. Make local outputs easy to reject

Design prompts with a safe escape hatch:

```text
Classify this cron item.

Return JSON only:
{
  "decision": "skip" | "summarize" | "escalate",
  "confidence": 0.0,
  "reason": "short reason"
}

Rules:
- choose "escalate" for ambiguity
- choose "escalate" for external-send, account, billing, auth, or security work
- choose "skip" only for obvious noise
```

Then enforce the gate in code:

```bash
decision="$(jq -r '.decision // "escalate"' result.json)"
confidence="$(jq -r '.confidence // 0' result.json)"

if [ "$decision" = "escalate" ] || awk "BEGIN { exit !($confidence < 0.80) }"; then
  echo "route=main"
else
  echo "route=local:$decision"
fi
```

The important part is not the exact threshold. It is that a malformed or low-confidence local answer routes upward.

### 7. Use local commit drafts as drafts

A local model can make a solid first pass at commit messages when the diff is small:

```bash
git diff --staged --stat
git diff --staged --no-ext-diff --unified=3 \
  | ollama run qwen3-coder:14b "Write one conventional commit subject. No body."
```

Review before using it. Local commit helpers are for reducing blank-page friction, not for outsourcing judgment about what changed.

### 8. Keep health checks boring

Local fallback is useful only if it is quiet when healthy and obvious when broken.

Create a smoke check that covers:

- daemon reachable
- expected models installed
- embedding model responds
- utility model returns parseable JSON
- no unexpected network bind

Run it after upgrades, before enabling cron jobs, and any time local jobs start escalating unexpectedly.

## Verification

List installed models:

```bash
ollama list
```

Check the daemon through your configured base URL:

```bash
curl -fsS "$OLLAMA_OPENAI_BASE_URL/models" | jq '.data[].id'
```

Confirm the embedding model exists:

```bash
ollama list | awk '{print $1}' | grep -x 'qwen3-embedding:8b'
```

Run a constrained triage smoke test:

```bash
printf '%s\n' 'Backup completed successfully.' \
  | ollama run qwen3:7b 'Return JSON only with decision skip, summarize, or escalate.'
```

Expected result:

- output parses as JSON or the wrapper escalates it
- safe routine input becomes `skip` or `summarize`
- ambiguous, external-send, auth, billing, or security input becomes `escalate`

Check OpenClaw config for accidental main-chain fallback:

```bash
jq '.agents.defaults.model.fallbacks' ~/.openclaw/openclaw.json
```

Expected result: local utility aliases should not appear in the main model fallback list.

## Gotchas

1. **Local fallback does not mean main fallback.** Keep local models out of the primary conversation fallback chain unless you are intentionally accepting a major quality drop.

2. **Embedding model swaps require re-indexing.** Changing the embedding model without rebuilding vectors gives you degraded search that looks like bad memory.

3. **Small models can produce empty or malformed output.** Cron prompts need parse checks and an escalation default. If JSON parsing fails, route to the main agent.

4. **Do not trust local models with prompt injection.** Untrusted email and web content can still manipulate weak models. Use local triage only behind strict output gates.

5. **Loopback is the right default.** Exposing Ollama on a network interface turns every installed model into a shared compute endpoint. Bind broadly only with firewall and auth controls.

6. **GPU memory pressure looks like model quality trouble.** If responses slow down or time out after adding a model, check resource usage before rewriting prompts.

7. **Model names are not architecture.** The architecture is the lane policy: embeddings stay stable, utility aliases are explicit, bad outputs escalate, and the main chain stays strong.

## Templates

- [`../templates/ai-stack/ollama-local-routing.openclaw.json`](../templates/ai-stack/ollama-local-routing.openclaw.json) - local embedding and utility alias fragment
- [`../templates/ai-stack/plugin-health-check.sh`](../templates/ai-stack/plugin-health-check.sh) - health-check shape for enabled agent plugins
- [`../templates/scrubbers/`](../templates/scrubbers/) - scrub local endpoints and paths before publishing examples

## Related

- [`multi-model-orchestration.md`](multi-model-orchestration.md) - full model-chain placement
- [`prompt-caching.md`](prompt-caching.md) - keep paid-model quota healthy while local jobs do utility work
- [`gpt-55-orchestration.md`](gpt-55-orchestration.md) - main-agent routing behavior and fallback hygiene
- [`../knowledge/memory-token-optimization.md`](../knowledge/memory-token-optimization.md) - local embeddings for memory search
- [`../automation/openclaw-cron-deep-dive.md`](../automation/openclaw-cron-deep-dive.md) - cron triage failure modes and escalation routing
- [`../security/linux-hardening.md`](../security/linux-hardening.md) - why local services should stay bound to protected interfaces
