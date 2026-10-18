# OpsDeck

> A self-hosted dashboard that surfaces the parts of the stack you'd otherwise check by opening five terminals. Forty-odd routes, a companion Express API on port 8005, and one place to inspect projects, services, memory, usage, security, and agent operations.

**Tested on:** React 19, Vite 7, Express 5, Node 22
**Last updated:** 2026-10-17

## What this is

A React dashboard called `opsdeck` that reads live operator state through a companion API and renders 43 routes over the daily stack (42 explicit routes plus a catch-all that keeps the sidebar visible on an unknown URL). The source is not published, so this guide describes the shape and the decisions rather than a clone command. It started as 20 routes and grew a page every time a manual check became a habit.

The table groups the pages by purpose. The router has more entries than rows here, because related pages share a row:

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
| **Social / Network / Intel** | Publishing pipeline, tracking data, agent intelligence feed | The non-code loops that still need status |
| **Media / Blog / Tweet planner** | Content candidates, drafts, banner studio, post analytics | The publishing pipeline in one place, with the scrub gates applied server-side |
| **Subscriptions / Model fitness** | Recurring charges totaled monthly and yearly, model benchmark results | Spend and model choice without a spreadsheet |
| **Academy / Recipes / Labs** | Long-form deep dives, recipe pages, fleet lab write-ups | Reference material that lives next to the live state |

The frontend is React 19 + Vite 7. Live pages use the companion API on port 8005, and the UI falls back where it can when the API is absent. The agent does not consume the UI. The UI consumes the agent's filesystem and service state.

The companion API is a separate Express 5 app (a single ESM `server.js` under pm2). It is not part of the UI repo, and it is not a Python service. Keeping it separate means the UI can be redeployed without touching the process that reads the workspace.

## Why this way

Three forces shape the design:

1. **The default `openclaw dashboard` is fine for "is the gateway up?" and nothing else.** Once you have memory cards, a prompt library, semantic search, and a daily session journal, you need a place to read them that is not VS Code.

2. **The data the dashboard cares about already lives on disk as flat files.** No new database. The companion API reads the workspace and serves it through a thin service layer, and the Memory and Journal pages only read from it. If the dashboard dies, the data is untouched. If a card moves, the dashboard picks it up on next page load.

3. **The UI must survive a missing API.** When the companion API is unreachable, the adapter layer falls back where it can so the UI still loads and shows you what is wrong. A dashboard that hard-fails because one service is down is the opposite of what you want at 2 am.

The alternatives that lose:

| Alternative | Why it loses |
|-------------|--------------|
| A Grafana board over Prometheus | Real metrics, no narrative content. No memory cards, no journal, no prompt library |
| Notion / Obsidian over the same files | One-way render only, no search-backed code surfaces, no live repo state |
| The OpenClaw CLI for everything | Fine for queries, terrible for browsing 100+ memory cards |
| Building a fresh UI per data source | The data sources are flat files. One UI over all of them is cheaper to maintain |

## Prerequisites

- Node.js 22 or newer
- An OpenClaw workspace at `~/.openclaw/workspace` (the Memory and Journal pages read it)
- Optional: a code-search service (port 5204) and a prompt-library service (port 5202) for the Search and Prompts pages
- The `gh` CLI authenticated, if you want live repo data
- An API key for the companion API (see Auth). The API refuses to start on a non-loopback address without one

## Before / After

**Before:** to know what happened yesterday, you `cat ~/.openclaw/workspace/memory/2026-05-11.md`. To find a memory card by topic, you `rg <topic> ~/.openclaw/workspace/memory/cards/`. To see what repos are featured, you keep a list in your head.

**After:** a dashboard on `http://localhost:5173`. Tasks, services, projects, journal, memory, usage, security, architecture, and config are all grouped in one sidebar. The same content, with one URL instead of seven shell commands. The UI listens on loopback only, and a reverse proxy with its own authentication fronts it for other devices on the network.

## Implementation

### Get the dashboard up

Start the API first, then the UI. The source is not published, so substitute your own checkouts:

```bash
# Companion API: Express 5, port 8005, loopback by default.
cd /path/to/dashboard-api
npm install
OPSDECK_API_KEY=<a-real-secret> node server.js

# UI: Vite dev server, port 5173.
cd /path/to/dashboard-ui
npm install
npm run dev
```

Open `http://localhost:5173`. Live pages need the companion API on `localhost:8005`. Static and local-only pages still render without it.

### Point at your real workspace

The API resolves the workspace from the `WORKSPACE` environment variable and defaults to `~/.openclaw/workspace`:

```bash
WORKSPACE=$HOME/.openclaw/workspace OPSDECK_API_KEY=<a-real-secret> node server.js
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

The dashboard treats the overlays as read-only inputs.

### Bring code search and prompts online

The Search and Prompts pages call out to a separate skill:

- A code-search service listens on port 5204.
- A prompt-library service listens on port 5202.
- The dashboard's UI detects whether those ports are answering and either lights the pages up or shows an empty state.

This split is intentional. The dashboard does not embed a vector database, the search service does that work.

### Auth

The API is default-deny. Every `/api` route needs an `X-API-Key` header that matches `OPSDECK_API_KEY`, reads included. The one public route is `GET /api/health`, so a load balancer or uptime check can reach it without a credential. The allowlist is a short constant in `auth.js`, which means a new route is private the moment someone adds it.

Three details that cost me time:

- **A second, read-scoped key.** `OPSDECK_API_KEY_READONLY` is accepted on GET, HEAD, and OPTIONS only. A mutating method with that key gets a 403, so a credential that rides along on every page load cannot be replayed as a write.
- **The browser never holds a key.** The UI calls same-origin `/api`, and the Vite dev-server proxy strips any `X-API-Key` and `Cookie` header the browser sent, then injects the server-held key. A key pasted into devtools never reaches the API.
- **Fail closed at startup.** With no key set and a non-loopback `BIND_HOST`, the API logs the reason and exits before it listens. A keyless run needs loopback and an explicit development flag, which opens every route and prints a warning.

For a homelab where other devices need the dashboard, set `BIND_HOST` on the API, keep the Vite server on loopback, and put a reverse proxy with its own authentication in front of the UI. Passing a wildcard host to Vite on the command line overrides the config and exposes the deck unauthenticated, so check the listen address after every redeploy.

CORS is an exact-match allowlist from `OPSDECK_ALLOWED_ORIGINS` (comma separated), defaulting to the two loopback UI origins. There is no wildcard or LAN pattern.

## Verification

After installing:

```bash
# Dashboard answers.
curl -fs http://localhost:5173 >/dev/null && echo "UI: OK"

# The one public route answers without a key.
curl -fs http://localhost:8005/api/health | jq .status

# Any other route is refused without a key (expect 401).
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8005/api/projects

# With the key, the same route answers (expect 200). The key goes in through a curl config on a pipe,
# not -H, so it never appears in curl's argv (visible to any local user in `ps` and /proc).
# printf is a shell builtin, so the expanded key is not in any process's argv either.
curl -s -o /dev/null -w "%{http_code}\n" --config <(printf 'header = "X-API-Key: %s"\n' "$OPSDECK_API_KEY") http://localhost:8005/api/projects

# The UI proxy refuses a request that has no dev-server session cookie (expect 403 from a bare curl).
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/api/projects

# Memory page lists cards.
# Same config-on-a-pipe pattern as above.
curl -fs --config <(printf 'header = "X-API-Key: %s"\n' "$OPSDECK_API_KEY") http://localhost:8005/api/memory/cards | jq 'length'

# If the search service is running, port 5204 answers. Otherwise the page degrades cleanly.
curl -fs http://localhost:5204/healthz && echo "search: OK"
```

A healthy install: the UI loads, `/api/health` returns `ok`, a direct call to any other route returns 401 without the key and 200 with it, a bare call through the UI proxy returns 403, and the search service either answers or the page is in empty state.

## Gotchas

**`WORKSPACE` must be the directory containing `memory/`, not the parent.** A common mistake is pointing at `~/.openclaw` (which contains `agents/`, `cron/`, and `workspace/` as siblings). The API expects to read `<workspace>/memory/` directly.

**Health checks need the right path and the right expectation.** `GET /api/health` is the only unauthenticated route. A probe aimed at `/healthz` or any other path gets a 401 from the default-deny layer, which looks like an outage and is not one. Point uptime monitors at `/api/health`.

**A key that differs between the dev server and the API fails every request.** Both read the key from a secrets render, and when a template, a rendered file, and the process environment held three different values, every keyed request returned 401. The proxy now resolves the rendered file first and re-reads it when its inode, size, or mtime changes, so a rotation does not need a restart.

**The frontend alone is not the whole dashboard.** `npm run dev` starts the Vite UI. Live services, journal, memory, and health pages need the companion API on port 8005. If those pages are empty, check the API before debugging React.

**`gh repo list` calls fail if `gh` is unauthenticated.** If you have not run `gh auth login` on the host, the Projects page cannot show live GitHub state and falls back to local repo data.

**The semantic-search and prompt-library services are not bundled.** This is deliberate (they have their own data and lifecycle), but it confuses first-time users who expect the Search page to "just work." The dashboard surfaces a clear empty state, but if your users assume it is broken, document the optional companion install in your README.

**Port 5173 and 8005 collide with common dev servers.** If you run Vite for another project on 5173 or have a separate service on 8005, the dashboard ports clash. Override the Vite port and the companion API port together.

**CORS allowlist must include the UI origin.** A direct browser request to the API fails CORS unless `OPSDECK_ALLOWED_ORIGINS` includes the UI origin. If you change the UI port, update the allowlist too.

**Treat the Memory page as a reader.** The API has keyed write routes for memory files and cards, but I do not use them from the UI, and new contributors look for a "save my edit" button that is not there. Durable memory changes happen through the agent or the [memory handoff path](../knowledge/claude-code-memory-handoffs.md), so there is one owner of the files. Other pages, such as the media board, do write, and those writes go through the keyed proxy.

**The dashboard is a window, not the source of truth.** If the underlying file changes while you are looking at it, the dashboard does not auto-refresh. Reload the page. This is a deliberate cost-saving for a single-user dashboard - server-sent events for one viewer is not worth the code.

## Templates

OpsDeck does not ship a template skeleton. The whole repo is the template. Lift the structure if you are building a similar internal dashboard:

- `src/appRouter.tsx` and `src/pages/` for one route per operator view
- `src/hooks/useApi.ts` for same-origin fetches against the companion API (the dev-server proxy adds the credential)
- `server/` for the dev-server plugins: the `/api` key-injecting proxy, a session-cookie gate, and symlink-safe file access
- `src/data/` for local fallback datasets and repo metadata

## Related

- [`mcp-catalog.md`](mcp-catalog.md) - the MCP catalog the dashboard surfaces on the Tools and Repos pages
- [`repo-redeploy.md`](repo-redeploy.md) - how the dashboard itself stays current as you push fixes to the public repo
- [`../knowledge/memory-architecture.md`](../knowledge/memory-architecture.md) - the memory model the Memory tab renders
- [`../publishing/publish-time-scrubbing.md`](../publishing/publish-time-scrubbing.md) - the scrubber pipeline that gates public dashboard docs and releases
