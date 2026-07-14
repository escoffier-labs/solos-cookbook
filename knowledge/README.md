# Knowledge management

How durable knowledge flows: cards, indexes, handoffs, sync. The goal is "future-me can pick up cold."

## Start here

If you want the full memory operating model this repo uses, read in this order:

1. [`memory-token-optimization.md`](memory-token-optimization.md): physical layout, local embeddings, and why the memory index stays tiny
2. [`memory-architecture.md`](memory-architecture.md): trust hierarchy, stale-claim handling, and the decay loop for cards
3. [`../ai-stack/self-improving-agents.md`](../ai-stack/self-improving-agents.md): memory sweep workflow that promotes recent session history into cards and rules
4. [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md): scheduled ingest path for machine-local handoffs back into canonical memory
5. [`../automation/openclaw-cron-deep-dive.md`](../automation/openclaw-cron-deep-dive.md): cron scheduling patterns for sweeps, ingest jobs, and card-staleness scans

## Guides

- [x] [`memory-token-optimization.md`](memory-token-optimization.md) - three-tier memory architecture, local semantic search, and operational sweep cadence
- [x] [`claude-code-memory-handoffs.md`](claude-code-memory-handoffs.md) - cross-machine sync format and auto-promoting ingester that keeps OpenClaw the canonical owner
- [x] [`memory-architecture.md`](memory-architecture.md) - operating model: memory as point-in-time claims (not live state), trust hierarchy, write/verify/decay loops, cross-store reconciliation
- [x] [`bootstrap-files.md`](bootstrap-files.md) - what AGENTS, CLAUDE, SOUL, USER, TOOLS, MEMORY, and safety files each own
- [x] [`obsidian-sync.md`](obsidian-sync.md) - bidirectional cloud sync without conflict roulette
- [x] [`session-jsonl.md`](session-jsonl.md) - using transcript logs as a memory source, not noise
- [x] [`evidence-pipeline.md`](evidence-pipeline.md) - MiseLedger imports local harness sessions into a searchable SQLite evidence archive with FTS and citable, untrusted evidence bundles

> 🦞 Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
