# Skills

Public, sanitized skills pulled from a real always-on agent stack.

These belong here because they express reusable patterns other people can adopt. Anything too dependent on one operator's machine, auth state, or private environment was rewritten or excluded before landing in this repo.

## Included skills

### `self-learning-agent`
Persistent agent memory built from a slim master index, atomic knowledge cards, and daily logs.

### `content-scrubber`
A deterministic redaction layer for outbound agent messages. Useful when your agent touches internal infrastructure, customer data, or operational notes.

### `ops-deck-lite`
A lightweight local productivity stack: semantic code search plus a reusable prompt library.

### `last30days`
A repeatable research workflow for surveying recent discussion across Reddit, X, and the broader web.

### `frontend-design`
An opinionated design-direction skill for avoiding generic AI-looking frontend work.

## Structure

```text
skills/
  <skill-name>/
    SKILL.md
```

## Sanitization rules

- no personal names or email addresses
- no private hostnames, internal IPs, or browser profile paths
- no secrets, tokens, or auth-state assumptions
- no hardcoded local repo paths from the source environment
- no operator-specific publishing or automation flow assumptions

## Philosophy

This folder is not a dump of one person's private setup. It is a curated set of patterns that survived contact with the real world and were cleaned up enough to be useful to someone else.
