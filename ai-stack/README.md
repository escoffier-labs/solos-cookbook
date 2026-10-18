# AI agent stack

Multi-model orchestration. One orchestrator, many models, escalation lanes, and a multi-vendor worker fleet behind it. Most of these guides assume OpenClaw as the agent framework, but the patterns generalize. The worker layer (Brigade roster seats and T3 Code delegated tasks) is described in [`multi-model-orchestration.md`](multi-model-orchestration.md) and [`sub-agent-patterns.md`](sub-agent-patterns.md).

## Guides

- [x] [`multi-model-orchestration.md`](multi-model-orchestration.md) - GPT 6.1 Sol orchestrator, Claude and Gemini seats, browser-LLM and Ollama lanes, and the worker fleet that does the building
- [x] [`claude-cli-to-acp-migration.md`](claude-cli-to-acp-migration.md) - how Claude moved off the main-agent slot after Anthropic's April 2026 OAuth block, and the current `claude-cli` and ACP options
- [x] [`acp-claude-code.md`](acp-claude-code.md) - running Claude Code as an ACP endpoint through ACPX when ACP is explicitly needed
- [x] [`claude-code-tmux-relay.md`](claude-code-tmux-relay.md) - driving first-party Claude Code through tmux for recoverable review and scripted one-shot calls
- [x] [`sub-agent-patterns.md`](sub-agent-patterns.md) - in-gateway sub-agents versus worker seats, spawn patterns, model assignment, error handling
- [x] [`gpt-55-orchestration.md`](gpt-55-orchestration.md) - orchestrating with GPT 6.1 Sol: `executionContract`, the tool-narration guard, silent-loop triage (filename kept for URL stability)
- [x] [`self-improving-agents.md`](self-improving-agents.md) - correction capture, behavioral-guard plugins, scheduled memory sweeps
- [x] [`session-management.md`](session-management.md) - channel layouts, session scope and reset, cron isolation
- [x] [`skills-development.md`](skills-development.md) - writing custom skills, structuring them for discoverability, real examples
- [x] [`prompt-caching.md`](prompt-caching.md) - cache hygiene across providers and the habits that break it
- [x] [`compaction-and-context-tuning.md`](compaction-and-context-tuning.md) - compaction, memory flush, context pruning, session search
- [x] [`browser-llm-stack.md`](browser-llm-stack.md) - Chromium with persistent login profiles and flock-locked concurrency for browser-native LLM work
- [x] [`local-llm-fallback.md`](local-llm-fallback.md) - local Ollama models for embeddings and bounded utility work, and when to reach for them
- [x] [`oauth-token-lifecycle.md`](oauth-token-lifecycle.md) - subscription OAuth traps: rotating-token reuse, token storage, fallback profiles, the 402 red herring
- [x] [`model-retirement-and-fallbacks.md`](model-retirement-and-fallbacks.md) - where model ids hide, the retirement sweep, fallback chain ordering, and the empty-chain case

## Browser Chromium lane

Not every useful model path is an API.

This stack also uses a dedicated Chromium lane for browser-native AI workflows where logged-in sessions matter more than clean API abstractions. That includes things like:

- Perplexity research from a logged-in Pro account
- Gemini browser workflows
- Claude web workflows
- ChatGPT web workflows
- any task where cookies, subscriptions, uploads, or persistent session state are the real dependency

The pattern is covered in [`browser-llm-stack.md`](browser-llm-stack.md):

- keep a persistent Chromium profile for each provider or workflow
- run it in a controlled environment
- serialize fragile browser tasks with a lock when needed
- treat browser automation as a first-class lane, not an embarrassing fallback

This matters because some of the highest-value agent workflows still live behind browser auth, subscription entitlements, or UI-only features. If your stack ignores that reality, you end up designing around an imaginary clean-room API world.

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
