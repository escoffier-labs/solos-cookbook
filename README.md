<p align="center">
  <img src="docs/assets/solos-cookbook-social-preview.jpg" alt="Solomon's Guide to Cookin' with Gas banner" width="900">
</p>

<h1 align="center">Solomon's Guide to Cookin' with Gas</h1>

<p align="center">
  <img src="docs/assets/marks/solos-cookbook-circle.svg" alt="" width="40" height="40">
</p>

<p align="center">
  <strong>Production notes for running long-lived agents beside daily coding tools.</strong>
</p>

<p align="center">
  <a href="https://escoffierlabs.dev/cookbook/">Read the cookbook</a> &middot;
  <a href="https://escoffierlabs.dev/cookbook/recipes">Browse all recipes</a> &middot;
  <a href="https://escoffierlabs.dev/cookbook/edition">2026 Edition</a>
</p>

<p align="center">
  <img src="https://shieldcn.dev/badge/code-MIT-green.svg" alt="Code license: MIT">
  <img src="https://shieldcn.dev/badge/content-CC_BY--NC--ND_4.0-lightgrey.svg" alt="Content license: CC BY-NC-ND 4.0">
  <img src="https://shieldcn.dev/badge/guides-61-red.svg" alt="61 guides">
  <img src="https://shieldcn.dev/badge/updated-2026--07--13-gold.svg" alt="Updated July 13, 2026">
</p>

This repository is the source for [Le Répertoire](https://escoffierlabs.dev/cookbook/), a cookbook built from systems that were deployed, broken, repaired, and checked again. It covers OpenClaw and Hermes memory ownership, Codex and Claude Code handoffs, automation, self-hosted infrastructure, security, publishing, and the hardware underneath the stack.

The website is the reading interface. The repository holds the markdown sources and copyable templates.

## Start here

Pick the path that matches the problem in front of you:

| You need to | Start with |
|---|---|
| Keep one durable memory across coding tools | [Memory architecture](knowledge/memory-architecture.md) |
| Route work across several models | [Multi-model orchestration](ai-stack/multi-model-orchestration.md) |
| Decide where scheduled work belongs | [Cron patterns](automation/cron-patterns.md) |
| Recover the stack after a bad host failure | [Backup and recovery](infrastructure/backup-recovery.md) |
| Lock down a host that agents can touch | [Linux hardening](security/linux-hardening.md) |
| Stop private infrastructure details at publication time | [Publish-time scrubbing](publishing/publish-time-scrubbing.md) |

For the memory system, read these in order:

1. [Memory token optimization](knowledge/memory-token-optimization.md)
2. [Memory architecture](knowledge/memory-architecture.md)
3. [Memory handoffs](knowledge/claude-code-memory-handoffs.md)
4. [Self-improving agents](ai-stack/self-improving-agents.md)

## Chapters

| Chapter | Recipes | Covers |
|---|---:|---|
| [AI agent stack](ai-stack/) | 15 | Model routing, sessions, context, OAuth, local fallbacks |
| [Automation](automation/) | 8 | Cron, hooks, n8n, channels, publishing jobs |
| [Self-hosted infrastructure](infrastructure/) | 9 | Backups, service isolation, host topology, recovery |
| [Security](security/) | 7 | Host hardening, secrets, incident response, agent controls |
| [Knowledge management](knowledge/) | 7 | Memory ownership, handoffs, evidence, Obsidian, transcripts |
| [Hardware and host](hardware/) | 3 | Bare metal, disks, kernel tuning |
| [Tools](tools/) | 6 | Brigade, Skillet, MCP catalogs, redeploys, OpsDeck |
| [Publishing](publishing/) | 2 | Scrub gates and review boundaries |
| [Philosophy](philosophy/) | 4 | Scope, tradeoffs, and operating principles |

The [templates](templates/) directory contains public-safe bootstrap files, hook examples, service snippets, scrubber rules, and setup checklists. Copy only the pieces you understand, then replace every placeholder before use.

## Cookbook and Brigade

The cookbook explains the operating model and the failures behind it. [Brigade](https://brigade.tools) is the separate installable project that wires up handoff inboxes, bootstrap files, content guards, work receipts, and multi-model runs.

Use the guides on their own, or install Brigade when you want the shared layout:

```bash
pipx install brigade-cli
brigade operator quickstart --target ./my-repo --harnesses codex
```

The cookbook does not need Brigade to be useful, and this repository is not a second Brigade distribution.

## 2026 Edition

All 61 recipes remain free on the website. The planned paid edition is a $39 designed PDF with a linked table of contents, chapter openers, print typography, full-page diagrams, a setup checklist, and a glossary.

Payment will use Stripe. Checkout stays disabled until the final PDF, file delivery, receipt email, refund terms, and a test purchase are ready. A purchase will include every 2026 Edition revision published through June 30, 2027. A later named edition may be a separate purchase.

[Preview the 2026 Edition](https://escoffierlabs.dev/cookbook/edition).

## Local site

Node 22.12 or newer is required.

```bash
git clone https://github.com/escoffier-labs/solos-cookbook.git
cd solos-cookbook
npm --prefix site ci
npm --prefix site run dev
```

The markdown at the repository root is the source of truth. The Astro app in `site/` renders it.

## Contributing

Corrections and verification reports are welcome. New guides need runnable verification commands and a `## Gotchas` section. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

This is a public repository. Use RFC 5737 documentation addresses and generic hostnames in examples. The tracked pre-push hook checks committed content for private infrastructure details:

```bash
git config core.hooksPath hooks
```

## License

- Code, scripts, and templates: [MIT](LICENSE)
- Narrative guides and essays: [CC BY-NC-ND 4.0](CONTENT-LICENSE)
