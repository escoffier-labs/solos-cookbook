---
name: last30days
version: 1.0.0
description: "Research a topic across Reddit, X, and the broader web with a strict last-30-days lens. Good for recent discourse, recommendations, product chatter, and breaking developments."
argument-hint: "cybersecurity trends, best AI coding tools, NVIDIA news, remote network admin jobs"
tags:
  - research
  - recency
  - web-search
  - synthesis
category: research
---

# last30days

Research what people are saying about a topic right now, not what ranked well six months ago.

## Goal

Survey recent discussion across:
- Reddit
- X
- the broader web

## Parse intent first

Extract:
1. `TOPIC`
2. `QUERY_TYPE`

Use one of these query types:
- `RECOMMENDATIONS`
- `NEWS`
- `GENERAL`

## Search plan

Run 6 to 10 searches from different angles.

### Reddit
- `site:reddit.com {TOPIC}`
- `reddit {TOPIC} recommendations`
- `reddit {TOPIC} discussion`

### X
- `site:x.com {TOPIC}`
- `{TOPIC} x thread`
- `{TOPIC} trending`

### Web
For `RECOMMENDATIONS`:
- `best {TOPIC} 2026`
- `{TOPIC} comparison`
- `top {TOPIC}`

For `NEWS`:
- `{TOPIC} news 2026`
- `{TOPIC} announcement`
- `{TOPIC} update`

For `GENERAL`:
- `{TOPIC} 2026`
- `{TOPIC} guide`
- `{TOPIC} overview`

Prefer a past-month freshness filter when the tool supports it.

## Deep dive

Fetch the 3 to 5 most promising results in full.

Prioritize:
- active Reddit threads
- detailed blog posts
- primary-source announcements
- news articles with specifics

## Output shape

### Recommendations
- rank the most-mentioned options
- explain why they are being recommended
- cite sources
- note disagreements or controversial picks

### News
- list key developments from the last 30 days
- include dates when available
- separate facts from community reaction

### General
- summarize major themes
- call out where people agree
- call out where opinion splits

## Rules

- prefer specific names, dates, and numbers
- weight recent discussion over stale SEO pages
- flag contradictions
- cite sources with links when possible
- keep the synthesis tight unless the user asks for a deep dive

## Anti-pattern

Do not answer with a generic web summary built from one or two results. The whole point is cross-source recency.
