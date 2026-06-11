# Glossary

Plain definitions for the terms this book leans on. If a recipe uses a word you
do not recognize, look here first.

## Agent

A long-running program built on a language model that can read context, call
tools, and take actions on your behalf. In this book the always-on agent is the
one that owns shared memory and drives recurring work.

## Harness

The tool you run a model inside of. Coding harnesses like Codex CLI, Claude
Code, and OpenCode each see one repo and one task at a time and do the actual
work.

## Orchestrator

The always-on layer that hosts the agent, routes messages, and keeps it alive
across sessions. OpenClaw and Hermes are the orchestrators used here.

## Gateway

The local service that the orchestrator runs as. It receives messages, holds the
agent session, and dispatches work. It is the process you restart after config
changes.

## MCP (Model Context Protocol)

An open standard for connecting models to external tools and data sources. An MCP
server exposes a set of tools the agent can call without custom glue code.

## Subagent

A second agent the main agent spawns to handle a scoped task in parallel.
Subagents get a limited slice of context and report a result back, instead of
sharing the main session.

## Memory owner

The single agent that is the source of truth for durable knowledge. Many tools
write to it through handoffs, but only one owner ingests and reconciles those
writes.

## Handoff

A short, structured note a coding session writes back to the memory owner at the
end of its work. It captures decisions, root causes, and gotchas so the next
session starts with current state.

## Bootstrap file

A workspace file the agent loads at the start of every session to establish who
it is and what it may do. Identity, rules, tools, and the memory index are all
bootstrap files.

## Memory card

A focused note on one topic, with frontmatter for tags and category. Cards hold
the detail behind a one-line memory index entry so the index stays scannable.

## MEMORY.md

The index of durable knowledge. It lists one-line entries that point at the
memory cards holding the full detail. The owner keeps it current as handoffs come
in.

## Cron job

A task scheduled to run on a fixed interval, such as a nightly memory sweep. It
runs without anyone present, so it must fail loudly and target the right place.

## Local-first

A design rule that keeps data and processing on your own machine by default,
reaching out to remote services only when needed. It keeps secrets and private
context off third-party servers.

## Self-hosted

Software you run on hardware you control rather than a managed cloud service. You
own the uptime, the backups, and the data, and nothing leaves the box unless you
send it.

## Homelab

A home server or cluster you run for self-hosting, experimentation, and learning.
In this stack it hosts the agent, the shared memory, and the supporting services.

## Sandbox

A restricted lane that gates risky actions before they run. Command wrappers sit
ahead of the real binaries in your PATH and can deny or rewrite dangerous calls.

## Prompt caching

A model feature that reuses an already-processed prompt prefix across requests so
repeated context is cheaper and faster. Editing an early bootstrap file
invalidates the cache for the rest of the session.

## Context window

The fixed amount of text a model can consider at once, measured in tokens. When a
conversation grows past it, older content gets pruned or summarized to make room.
