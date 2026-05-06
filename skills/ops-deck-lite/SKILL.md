---
name: ops-deck-lite
version: 1.0.0
description: "Local agent productivity stack: semantic code search plus a reusable prompt library. Lightweight, cheap to run, and useful long before you need a giant ops dashboard."
tags:
  - code-search
  - prompt-library
  - embeddings
  - productivity
  - local-tools
category: tools
---

# Ops Deck Lite

Build two small local services before you build a giant agent dashboard.

## Goal

Give the agent two capabilities that pay off immediately:
1. semantic code search
2. a reusable prompt library

## Component 1: Semantic code search

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

## Component 2: Prompt library

Store prompts as reusable templates instead of rewriting them every session.

Each prompt should have:
- title
- category
- body
- optional tags
- optional variables

## Why this stack works

- cheap to run
- private by default
- easy to back up
- useful to both humans and agents
- much smaller blast radius than a full operations suite

## Minimal setup guidance

Use any stack you like, but keep the shape simple:
- one code-search API
- one prompt-library API
- one small database per service or shared storage if you prefer
- one lightweight process manager or service supervisor

## Agent integration pattern

Teach the agent two habits:

1. Check semantic code search before grepping dozens of files.
2. Check the prompt library before drafting a fresh prompt from scratch.

## Suggested API shape

### Code search
- `POST /api/search`
- `GET /api/health`
- `POST /api/index`

### Prompt library
- `GET /api/prompts`
- `GET /api/prompts/:id`
- `POST /api/prompts`
- `PUT /api/prompts/:id`
- `DELETE /api/prompts/:id`

## Verification

A good smoke test:
- query a concept not literally present in source code
- confirm semantic search still finds the right area
- retrieve a known prompt by category and reuse it successfully

## Anti-pattern

Do not start with a full control plane, analytics wall, sprint board, and seven side panels. Start with the two tools that actually save tokens and time.
