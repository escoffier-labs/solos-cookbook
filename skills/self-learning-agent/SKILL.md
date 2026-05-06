---
name: self-learning-agent
version: 1.0.0
description: "Persistent agent memory using a slim master index, atomic knowledge cards, and daily logs. Designed for agents that restart fresh each session but still need durable memory."
tags:
  - memory
  - learning
  - self-improving
  - knowledge-management
  - persistence
category: agent
---

# Self-Learning Agent

Use a three-layer memory system instead of one giant memory file.

## Goal

Keep session startup cheap while preserving durable knowledge.

## Architecture

```text
workspace/
├── MEMORY.md
└── memory/
    ├── cards/
    │   ├── topic-name.md
    │   └── another-topic.md
    └── YYYY-MM-DD.md
```

## Model

- `MEMORY.md`: slim index loaded every session
- `memory/cards/*.md`: curated knowledge cards, one topic per file
- `memory/YYYY-MM-DD.md`: raw daily session logs

## Why this works

- The index stays small.
- Durable knowledge is split into searchable units.
- Raw logs do not pollute the always-loaded context.
- The agent loads only the memory it needs for the current task.

## Session workflow

1. Read `MEMORY.md`.
2. Search for task-relevant cards.
3. Skim recent daily logs when recency matters.
4. Work.
5. Write back durable lessons as cards.
6. Log the session briefly in the daily file.

## Card format

```markdown
---
topic: Descriptive Topic Name
category: system|human|infrastructure|tools|workflow|projects|lessons|security|models
tags: [tag1, tag2, tag3]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

Dense, factual content.
Include specific commands, decisions, paths, or gotchas when they matter.
Keep it short enough to stay easy to retrieve and update.
```

## Card rules

1. One topic per card.
2. Prefer updates over duplicates.
3. Write for future-you with zero context.
4. Store decisions and lessons, not chatter.
5. Keep examples concrete.

## Capture triggers

Write or update a card when you learn:
- a hard-won fix
- a recurring workflow
- a user correction
- a non-obvious system fact
- a durable preference or rule

## Do not capture

- trivial facts
- one-off noise
- full conversation transcripts
- stale information you already replaced elsewhere

## Daily log format

```markdown
## HH:MM - Brief title

What happened, what changed, what was learned.
Link any new or updated cards.
```

## Maintenance loop

Periodically:
1. review recent daily logs
2. promote durable lessons into cards
3. merge duplicate cards
4. prune outdated index entries

## Anti-pattern

Do not keep appending everything to one massive memory file. That turns recall into sludge and makes every future session more expensive.
