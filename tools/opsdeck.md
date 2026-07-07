# OpsDeck

> A self-hosted dashboard that surfaces the parts of the stack you'd otherwise check by opening five terminals. Twenty routes, a companion API on port 8005, and one place to inspect projects, services, memory, usage, security, and agent operations.

## What this is

A React dashboard called `opsdeck` that reads live operator state through a companion API and renders 20 routes over the daily stack:

| Page | What it shows | Why I want it on one screen |
|------|---------------|------------------------------|
| **Tasks** | Task board and status tracking | What is open, blocked, and moving |
| **Calendar** | Cron schedule and events | What is supposed to happen next |
| **Services** | Running service health via the companion API | Which local service needs attention |
| **Memory / Journal** | Long-term memory, daily logs, diary entries | What the agent learned and did |
| **Usage / Observability** | Token, session, and tool-call analytics | Cost and behavior drift without log spelunking |
| **Projects** | Unified repo catalog with live git state and per-project detail | The repo map plus current local status |
| **Search / Prompts** | Code/content search and prompt library browsing | Reuse prior work without leaving the dashboard |
| **Security / Architecture / Config** | Audit logs, controls, backups, port registry, config files, skills, rules, crons | The operator view when something feels off |
| **Social / Network / Intel** | Publishing pipeline, job-hunt data, agent intelligence feed | The non-code loops that still need status |

The frontend is React 19 + Vite 7. Live pages use the companion API on port 8005, and the UI falls back where it can when the API is absent. The agent does not consume the UI; the UI consumes the agent's filesystem and service state.

## Why this way

Three forces shape the design:

1. **The default `openclaw dashboard` is fine for "is the gateway up?" and nothing else.** Once you have memory cards, a prompt library, semantic search, and a daily session journal, you need a place to read them that is not VS Code.

2. **The data the dashboard cares about already lives on disk as flat files.** No new database. The companion API mounts the workspace read-only and serves it through a thin service layer. If the dashboard dies, the data is untouched; if a card moves, the dashboard picks it up on next page load.

3. **The UI must survive a missing API.** When the companion API is unreachable, the adapter layer falls back where it can so the UI still loads and shows you what is wrong. A dashboard that hard-fails because one service is down is the opposite of what you want at 2 am.

The alternatives that lose:

| Alternative | Why it loses |
|-------------|--------------|
| A Grafana board over Prometheus | Real metrics, no narrative content. No memory cards, no journal, no prompt library |
| Notion / Obsidian over the same files | One-way render only, no search-backed code surfaces, no live repo state |
| The OpenClaw CLI for everything | Fine for queries, terrible for browsing 100+ memory cards |
| Building a fresh UI per data source | The data sources are flat files; one UI over all of them is cheaper to maintain |

## Prerequisites

- Node.js 22 or newer
- An OpenClaw workspace at `~/.openclaw/workspace` (the dashboard mounts it read-only)
- Optional but recommended: the [`ops-deck-lite`](https://clawhub.ai) skill installed for code search (port 5204) and prompt library (port 5202)
- The `gh` CLI authenticated, if you want live repo data

## Before / After

**Before:** to know what happened yesterday, you `cat ~/.openclaw/workspace/memory/2026-05-11.md`. To find a memory card by topic, you `rg <topic> ~/.openclaw/workspace/memory/cards/`. To see what repos are featured, you keep a list in your head.

**After:** a dashboard on `http://localhost:5173`. Tasks, services, projects, journal, memory, usage, security, architecture, and config are all grouped in one sidebar. The same content, with one URL instead of seven shell commands.

## Implementation

### Get the dashboard up

```bash
git clone <opsdeck-repo-url>
cd opsdeck
npm install
npm run dev
```

Open `http://localhost:5173`. Live pages need the companion API on `localhost:8005`; static and local-only pages still render without it.

### Point at your real workspace

Edit the environment used by the companion API:

```bash
OPENCLAW_WORKSPACE=/home/<you>/.openclaw/workspace
```

Restart:

```bash
npm run dev
```

The Memory and Journal tabs now render your actual cards and daily session files.

### Optional overlays

The companion API reads three optional overlay files from inside the workspace:

| File | Purpose |
|------|---------|
| `repos.json` | Adds `category` and `featured` annotations to `gh repo list` output |
| `repos-detail.json` | Per-repo deep-dive content (summary, tech stack, code snippets) |
| `codebase.json` | Semantic codebase entries (path, summary, language) |

Without these, the corresponding pages render skeletons. With them, you get a real "personal repo browser."

A `repos.json` skeleton:

```json
{
  "by-slug": {
    "my-mcp": { "category": "tools", "featured": true },
    "old-experiment": { "category": "archive" }
  }
}
```

The overlays are write-side; the dashboard treats them as read-only.

### Bring code search and prompts online

The Search and Prompts pages call out to a separate skill:

- The skill exposes a code-search service on port 5204.
- It exposes a prompt-library service on port 5202.
- The dashboard's UI auto-detects whether those ports are answering and either lights the pages up or shows an empty state.

This split is intentional - the dashboard does not embed a vector database; the search service does that work.

### Auth

By default the companion API binds locally. Anything that can reach `localhost` can talk to it. For a homelab where multiple devices hit the same dashboard, set:

```bash
OPSDECK_API_KEY=<a-real-secret>
VITE_OPSDECK_API_KEY=<same-secret>
BIND_HOST=0.0.0.0
```

This adds `X-API-Key` enforcement on the API and bakes the same key into the UI at build time. The CORS allowlist is independent (`ALLOWED_ORIGINS=`).

## Verification

After installing:

```bash
# Dashboard answers.
curl -fs http://localhost:5173 >/dev/null && echo "UI: OK"

# Companion API is healthy.
curl -fs http://localhost:8005/healthz | jq

# Journal page reads today's session log.
curl -fs http://localhost:8005/api/journal/$(date +%F) | head

# Memory page lists cards.
curl -fs http://localhost:8005/api/memory/cards | jq 'length'

# If the search skill is running, port 5204 answers; otherwise the page degrades cleanly.
curl -fs http://localhost:5204/healthz && echo "search: OK"
```

A healthy install: UI loads, the API reports health, journal renders today's date, memory page lists at least one card, optional search service either answers or the page is in empty-state.

## Gotchas

**`OPENCLAW_WORKSPACE` must be the directory containing `memory/`, not the parent.** A common mistake is pointing at `~/.openclaw` (which contains `agents/`, `cron/`, and `workspace/` as siblings). The API expects to read `<workspace>/memory/` directly.

**The frontend alone is not the whole dashboard.** `npm run dev` starts the Vite UI. Live services, journal, memory, and health pages need the companion API on port 8005. If those pages are empty, check the API before debugging React.

**`gh repo list` calls fail if `gh` is unauthenticated.** If you have not run `gh auth login` on the host, the Projects page cannot show live GitHub state. Set `GH_ENABLED=false` to skip the live call and rely on local repo data.

**The semantic-search and prompt-library services are not bundled.** This is deliberate (they have their own data and lifecycle), but it confuses first-time users who expect the Search page to "just work." The dashboard surfaces a clear empty state, but if your users assume it is broken, document the optional companion install in your README.

**Port 5173 and 8005 collide with common dev servers.** If you run Vite for another project on 5173 or have a separate service on 8005, the dashboard ports clash. Override the Vite port and the companion API port together.

**CORS allowlist must include the UI origin.** A request that the UI makes to the API fails CORS unless `ALLOWED_ORIGINS` includes the UI's `http://localhost:5173`. If you change the UI port, update the API allowlist too.

**Read-only workspace mount means nothing the dashboard does writes back.** This is the whole point, but new contributors look for a "save my edit" button on the Memory page. There is no such button. Memory edits happen through the agent or through the [memory handoff path](../knowledge/claude-code-memory-handoffs.md), not the dashboard.

**The dashboard is a window, not the source of truth.** If the underlying file changes while you are looking at it, the dashboard does not auto-refresh. Reload the page. This is a deliberate cost-saving for a single-user dashboard - server-sent events for one viewer is not worth the code.

## Templates

OpsDeck does not ship a template skeleton; the whole repo is the template. Lift the structure if you are building a similar internal dashboard:

- `src/pages/` for one route per operator view
- `src/hooks/useApi.ts` for authenticated fetches against the companion API
- `src/data/` for local fallback datasets and repo metadata

## Related

- [`mcp-catalog.md`](mcp-catalog.md) - the MCP catalog the dashboard surfaces on the Tools and Repos pages
- [`repo-redeploy.md`](repo-redeploy.md) - how the dashboard itself stays current as you push fixes to the public repo
- [`../knowledge/memory-architecture.md`](../knowledge/memory-architecture.md) - the memory model the Memory tab renders
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - the scrubber pipeline that gates public dashboard docs and releases
