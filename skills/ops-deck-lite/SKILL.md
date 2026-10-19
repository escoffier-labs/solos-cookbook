---
name: ops-deck-lite
version: 1.1.0
description: "Local agent productivity stack: one small semantic code search service. Lightweight, cheap to run, and useful long before you need a giant ops dashboard."
tags:
  - code-search
  - embeddings
  - productivity
  - local-tools
category: tools
---

# Ops Deck Lite

Build one small local service before you build a giant agent dashboard.

## Goal

Give the agent a capability that pays off immediately: semantic code search.

## Component: Semantic code search

Search code by meaning, not only exact text.

Useful for queries like:
- authentication middleware
- retry logic
- database pooling
- error handling

### Core design

- chunk source files
- generate embeddings locally or through a provider you control
- store chunks, metadata, and optional summaries in a small database
- expose one search endpoint with a few modes: `hybrid`, `code`, `summary`

## Why this stack works

- cheap to run
- private by default
- easy to back up
- useful to both humans and agents
- much smaller blast radius than a full operations suite

## Minimal setup guidance

Use any stack you like, but keep the shape simple:
- one code-search API
- one small database
- one lightweight process manager or service supervisor

## Agent integration pattern

Teach the agent one habit: check semantic code search before grepping dozens of files.

## Suggested API shape

- `POST /api/search`
- `GET /api/health`
- `POST /api/index`

Keep `POST /api/index` behind a credential or off the network. It rewrites the index, and an agent with tool access will find and call it.

## Verification

A good smoke test:
- query a concept not literally present in source code
- confirm semantic search still finds the right area

## Anti-pattern

Do not start with a full control plane, analytics wall, sprint board, and seven side panels. Start with the one tool that actually saves tokens and time.
