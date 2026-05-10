# AI agent stack

Multi-model orchestration. One orchestrator, many models, escalation lanes. Most of these guides assume OpenClaw as the agent framework, but the patterns generalize.

## Guides

- [x] [`multi-model-orchestration.md`](multi-model-orchestration.md) - GPT 5.5 + ACP Opus + browser-LLM + Ollama in one setup, right model per task
- [x] [`claude-cli-to-acp-migration.md`](claude-cli-to-acp-migration.md) - move Opus off main-agent slot after Anthropic's April 2026 OAuth block
- [x] [`acp-claude-code.md`](acp-claude-code.md) - running Claude Code as an ACP-driven escalation agent
- [x] [`sub-agent-patterns.md`](sub-agent-patterns.md) - spawn patterns, model assignment, ACP escalation, error handling
- [x] [`gpt-55-orchestration.md`](gpt-55-orchestration.md) - tool-narration guard, strict-agentic gaps, action-verb tuning
- [x] [`self-improving-agents.md`](self-improving-agents.md) - correction capture, behavioral-guard plugins, daily memory sweeps
- [x] [`session-management.md`](session-management.md) - Discord channel layouts, cron isolation, hybrid approach
- [x] [`skills-development.md`](skills-development.md) - write custom skills, structure for discoverability, real-world examples
- [x] [`prompt-caching.md`](prompt-caching.md) - cache hygiene across Anthropic and OpenAI
- [x] [`compaction-and-context-tuning.md`](compaction-and-context-tuning.md) - compaction, memory flush, context pruning, session search
- [ ] `browser-llm-stack.md` - headless Chromium + persistent login profiles + flock-locked concurrency for browser-native LLM work
- [ ] `local-llm-fallback.md` - Ollama for embeddings, commits, triage; when to reach for it

## Browser Chromium lane

Not every useful model path is an API.

This stack also uses a dedicated Chromium lane for browser-native AI workflows where logged-in sessions matter more than clean API abstractions. That includes things like:

- Perplexity research from a logged-in Pro account
- Gemini browser workflows
- Claude web workflows
- ChatGPT web workflows
- any task where cookies, subscriptions, uploads, or persistent session state are the real dependency

The pattern is simple:
- keep a persistent Chromium profile for each provider or workflow
- run it in a controlled environment
- serialize fragile browser tasks with a lock when needed
- treat browser automation as a first-class lane, not an embarrassing fallback

This matters because some of the highest-value agent workflows still live behind browser auth, subscription entitlements, or UI-only features. If your stack ignores that reality, you end up designing around an imaginary clean-room API world.

A full guide will live in `browser-llm-stack.md`.

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
