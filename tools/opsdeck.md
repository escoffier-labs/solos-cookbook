# OpsDeck

> A self-hosted dashboard that surfaces the parts of the stack you'd otherwise check by `cat`-ing log files. Eight pages, one auto-detected sidecar, no JavaScript framework du jour. If the agent dies overnight, this is the first place I look.

## What this is

A small React + FastAPI dashboard ([`ops-deck-oss`](https://github.com/solomonneas/ops-deck-oss)) that mounts the OpenClaw workspace read-only and renders eight specific views over it:

| Page | What it shows | Why I want it on one screen |
|------|---------------|------------------------------|
| **Repos** | Your GitHub repos with category and "featured" annotations | Quick links + grouping that `gh repo list` will not give you |
| **RepoDetail** | Per-repo deep-dives (architecture, tech stack, code excerpts) | Onboarding context for any repo, without opening the repo |
| **Codebase** | Semantic summaries of local code | "What is in this codebase" without reading every file |
| **Search** | Semantic code search (via the `ops-deck-lite` skill) | Better than `grep` for "where does the thing about X live" |
| **Prompts** | The prompt library (via the same skill) | Reusable prompt templates with metadata |
| **Journal** | Daily session journal from `~/.openclaw/workspace/memory/YYYY-MM-DD.md` | The agent's own write-up of what it did today |
| **Memory** | Browse `~/.openclaw/workspace/memory/cards/` | Durable knowledge cards searchable by topic + tags |
| **Config** | Dashboard settings and resolved env vars | "Why is this not working" debugging surface |

The whole thing runs as one `docker compose up -d` and stays out of the agent's way. The agent does not consume the UI; the UI consumes the agent's filesystem state.

## Why this way

Three forces shape the design:

1. **The default `openclaw dashboard` is fine for "is the gateway up?" and nothing else.** Once you have memory cards, a prompt library, semantic search, and a daily session journal, you need a place to read them that is not VS Code.

2. **The data the dashboard cares about already lives on disk as flat files.** No new database. The sidecar (`agent-intel`) mounts the workspace read-only and serves it through a thin FastAPI layer. If the dashboard dies, the data is untouched; if a card moves, the dashboard picks it up on next page load.

3. **The UI must run without the sidecar.** When the sidecar is unreachable, the adapter layer falls back to an "openclaw-only" stub so the UI still loads and shows you what is wrong. A dashboard that hard-fails because one service is down is the opposite of what you want at 2 am.

The alternatives that lose:

| Alternative | Why it loses |
|-------------|--------------|
| A Grafana board over Prometheus | Real metrics, no narrative content. No memory cards, no journal, no prompt library |
| Notion / Obsidian over the same files | One-way render only, no search-backed code surfaces, no live repo state |
| The OpenClaw CLI for everything | Fine for queries, terrible for browsing 100+ memory cards |
| Building a fresh UI per data source | The data sources are flat files; one UI over all of them is cheaper to maintain |

## Prerequisites

- Docker and `docker compose`
- An OpenClaw workspace at `~/.openclaw/workspace` (the dashboard mounts it read-only)
- Optional but recommended: the [`ops-deck-lite`](https://clawhub.ai) skill installed for code search (port 5204) and prompt library (port 5202)
- The `gh` CLI authenticated, if you want live repo data

## Before / After

**Before:** to know what happened yesterday, you `cat ~/.openclaw/workspace/memory/2026-05-11.md`. To find a memory card by topic, you `rg <topic> ~/.openclaw/workspace/memory/cards/`. To see what repos are featured, you keep a list in your head.

**After:** a dashboard on `http://localhost:5173`. The journal is a tab. The cards are a tab. Repos with categories and quick links are a tab. The same content, with one URL instead of seven shell commands.

## Implementation

### Get the dashboard up

```bash
git clone https://github.com/solomonneas/ops-deck-oss.git
cd ops-deck-oss
cp .env.example .env
docker compose up -d
```

Open [http://localhost:5173](http://localhost:5173). On first run, the sidecar mounts the bundled `./sample-workspace`, so the demo content shows up without any other setup.

### Point at your real workspace

Edit `.env`:

```bash
OPENCLAW_WORKSPACE=/home/<you>/.openclaw/workspace
```

Restart:

```bash
docker compose down && docker compose up -d
```

The Memory and Journal tabs now render your actual cards and daily session files.

### Optional overlays

The sidecar reads three optional overlay files from inside the workspace:

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

By default the sidecar binds to `127.0.0.1`. Anything that can reach `localhost` can talk to it. For a homelab where multiple devices hit the same dashboard, set:

```bash
OPSDECK_API_KEY=<a-real-secret>
VITE_OPSDECK_API_KEY=<same-secret>
BIND_HOST=0.0.0.0
```

This adds `X-API-Key` enforcement on the sidecar and bakes the same key into the UI at build time. The CORS allowlist is independent (`ALLOWED_ORIGINS=`).

## Verification

After installing:

```bash
# Dashboard answers.
curl -fs http://localhost:5173 >/dev/null && echo "UI: OK"

# Sidecar is healthy.
curl -fs http://localhost:8005/healthz | jq

# Journal page reads today's session log.
curl -fs http://localhost:8005/api/journal/$(date +%F) | head

# Memory page lists cards.
curl -fs http://localhost:8005/api/memory/cards | jq 'length'

# If the search skill is running, port 5204 answers; otherwise the page degrades cleanly.
curl -fs http://localhost:5204/healthz && echo "search: OK"
```

A healthy install: UI loads, sidecar reports health, journal renders today's date, memory page lists at least one card, optional search service either answers or the page is in empty-state.

## Gotchas

**`OPENCLAW_WORKSPACE` must be the directory containing `memory/`, not the parent.** A common mistake is pointing at `~/.openclaw` (which contains `agents/`, `cron/`, and `workspace/` as siblings). The sidecar expects to read `<workspace>/memory/` directly.

**`docker compose down -v` deletes the bundled sample workspace.** The sample workspace lives in the project tree, but the `-v` flag wipes the named volume the sidecar mounts. If you ran with `-v`, restore by `git checkout -- sample-workspace/`.

**`gh repo list` calls fail in the container if `gh` is unauthenticated on the host.** The sidecar uses the host's gh credentials via volume mount. If you have not run `gh auth login` on the host, the Repos page is empty. Set `GH_ENABLED=false` to skip the live call and rely entirely on the overlay file.

**The semantic-search and prompt-library services are not bundled.** This is deliberate (they have their own data and lifecycle), but it confuses first-time users who expect the Search page to "just work." The dashboard surfaces a clear empty state, but if your users assume it is broken, document the optional companion install in your README.

**Port 5173 and 8005 collide with common dev servers.** If you run Vite for another project on 5173 or have a separate service on 8005, the dashboard ports clash. Override with `VITE_PORT` and the sidecar's published port in `docker-compose.yml`.

**CORS allowlist must include both the UI origin and the sidecar origin.** A request that the UI makes to the sidecar fails CORS unless `ALLOWED_ORIGINS` includes the UI's `http://localhost:5173`. The default config has both; if you change the UI port, update both.

**Read-only workspace mount means nothing the dashboard does writes back.** This is the whole point, but new contributors look for a "save my edit" button on the Memory page. There is no such button. Memory edits happen through the agent or through the [memory handoff path](../knowledge/claude-code-memory-handoffs.md), not the dashboard.

**The dashboard is a window, not the source of truth.** If the underlying file changes while you are looking at it, the dashboard does not auto-refresh. Reload the page. This is a deliberate cost-saving for a single-user dashboard - server-sent events for one viewer is not worth the code.

## Templates

OpsDeck does not ship a template skeleton; the whole repo is the template. Lift the structure if you are building a similar internal dashboard:

- `ui/src/data-sources/` for an adapter pattern over multiple optional backends
- `agent-intel/server.py` for a minimal FastAPI sidecar with read-only filesystem mounts
- `.githooks/` for the content-guard integration pattern used across this stack

## Related

- [`mcp-catalog.md`](mcp-catalog.md) - the MCP catalog the dashboard surfaces on the Tools and Repos pages
- [`repo-redeploy.md`](repo-redeploy.md) - how the dashboard itself stays current as you push fixes to the public repo
- [`../knowledge/memory-architecture.md`](../knowledge/memory-architecture.md) - the memory model the Memory tab renders
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - the scrubber pipeline that gates the public ops-deck-oss repo itself
