# MCP Catalog

> Every MCP server published from this stack, what each one wraps, and where it fits. Most exist because a service the agent needed to talk to did not have a maintained MCP yet, so I wrote one.

**As of 2026-10-17.** Repository and package names below were checked against GitHub and the npm registry on that date.
**Last updated:** 2026-10-17

## What this is

An index of the MCP servers shipped from this cookbook's parent stack. Every repo linked here is public. Most follow the same shape: a thin TypeScript wrapper that converts MCP tool calls into authenticated REST or RPC calls against an existing service, with confirmation gates on destructive operations. Several of the newer ones are "ctrl" tools: a CLI first, with an MCP adapter over the same code, and writes off or gated by default.

Two naming quirks to know up front. Some repos were renamed after their npm package shipped, so the npm name and the repository name differ (the npm column below says which). And a few useful servers here are not on npm at all, so the install column matters.

If you are looking for the agent-side patterns for how these get consumed (Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI), see [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md). This guide is about the inventory.

## Why this way

Three reasons there are this many of them:

1. **Most third-party tools do not ship MCPs yet, or ship thin ones.** The 2026-era MCP ecosystem is still mostly experiments. If you want an agent to manage a service that already has a clean HTTP API, the gap between "no MCP" and "good MCP" is a weekend.
2. **A purpose-built MCP beats a generic HTTP MCP.** A generic `http_request` MCP forces the agent to remember endpoints, auth schemes, and response shapes. A typed MCP turns the same workflow into named tools with input validation, confirmation gates, and uniform error surfacing.
3. **The catalog grows along the workload, not ahead of it.** Each MCP in the list below was written because the orchestrator already needed to do that work weekly and was doing it through shell scripts or browser automation.

The cost is maintenance: every MCP is a small TypeScript repo with its own release cadence, README, and schema-drift exposure. That cost is bounded by [`repo-redeploy.md`](repo-redeploy.md) and the MCP release publish checklist.

## Catalog

Grouped by what the underlying service does. Versions move, so see each repo or `npm view <package> version` for current. The README pattern and the client setup blocks are in [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md).

### Media & home services

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`jellyctrl`](https://github.com/lidless-labs/jellyctrl) (`jellyfin-mcp` on npm) | Jellyfin media server | List libraries, scan, list sessions, control playback, manage playlists/collections, manage users, run scheduled tasks, Quick Connect auth |
| [`immichctrl`](https://github.com/lidless-labs/immichctrl) (`immich-mcp` on npm) | Immich photo library | Search by metadata or smart search, albums, tags, people, duplicate finding and resolution, trash audit, jobs, shared links. Writes are off by default |
| [`reelgrep-mcp`](https://github.com/solomonneas/reelgrep-mcp) | A local [reelgrep](https://github.com/solomonneas/reelgrep) subtitle index | Search subtitles, find a quote, list videos and recent cues, inspect saved searches and exports. Read-only |
| [`media-cli`](https://www.npmjs.com/package/@solomonneas/media-cli) | Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr, Jellyseerr, Tdarr (the "arr" media stack) | A single bash script (binary `media`), not an MCP. The agent shells out to it (`media movies search`, `media movies add`, `media downloads active`), locally or over SSH. Public now: `npm i -g @solomonneas/media-cli` or curl the script. Pairs with [`jellyctrl`](https://github.com/lidless-labs/jellyctrl) for Jellyfin playback. See [`repo-redeploy.md`](repo-redeploy.md) for how it stays current |

### Network & infrastructure

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`proxmox-mcp`](https://github.com/lidless-labs/proxmox-mcp) (`@solomonneas/proxmox-mcp` on npm) | Proxmox VE | Inventory VMs and containers, tasks, storage, backups, snapshots, firewall, HA, and permissions audits. Every write is gated before the Proxmox API sees it. Not the unscoped `proxmox-mcp` package on npm, which is someone else's project |
| [`adguardctrl`](https://github.com/lidless-labs/adguardctrl) (`@solomonneas/adguard-mcp` on npm) | AdGuard Home | Status, stats, query log, filter lists, rewrites, clients, user rules. Every write needs confirm and destructive flags. CLI plus MCP adapter, no daemon |
| [`librenmsctrl`](https://github.com/lidless-labs/librenmsctrl) (`@solomonneas/librenms-mcp` on npm) | LibreNMS | Devices, ports, and alerts over one stdio control surface, writes gated |

### Social & publishing

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`postiz-mcp`](https://github.com/solomonneas/postiz-mcp) | Postiz scheduled-posting platform | Create/schedule/delete posts and post groups, list integrations, check integration health, get post + platform analytics, find next scheduling slot, upload media, invoke per-provider integration tools |
| [`n8nctrl`](https://github.com/lidless-labs/n8nctrl) (`n8n-ops-mcp` on npm) | n8n workflow automation | List/inspect/validate workflows and executions, trigger and toggle workflows, read execution status and errors, manage credentials metadata, with confirmation gates on activate/deactivate. CLI plus MCP |

### Security operations

The SOC-side stack lands more than ten MCPs against a typical purple-team toolchain (Wazuh, TheHive, Cortex, MISP, Suricata, Zeek, and the two commercial platforms below). Each one has a confirmation gate on destructive operations, and the Wazuh one is read-only.

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`wazuh-mcp`](https://github.com/lidless-labs/wazuh-mcp) | Wazuh SIEM/XDR | List/search alerts, agent inventory, agent processes/ports/packages/network, FIM files, manager config + logs, rules/decoders, SCA checks, rootcheck |
| [`thehive-mcp`](https://github.com/lidless-labs/thehive-mcp) | TheHive case management | Cases, alerts, tasks, observables, custom fields - read-leaning, with explicit write tools gated |
| [`cortex-mcp`](https://github.com/lidless-labs/cortex-mcp) (`thehive-cortex-mcp`) | Cortex analyzer/responder runs | Job submission, results, analyzer catalog. Pairs with `thehive-mcp` |
| [`misp-mcp`](https://github.com/lidless-labs/misp-mcp) | MISP threat-intel platform | Event/attribute/tag CRUD, feeds, sharing groups, taxonomies |
| [`rapid7-mcp`](https://github.com/solomonneas/rapid7-mcp) | Rapid7 InsightIDR | SIEM log search, investigations, alerts, UBA, threat intelligence |
| [`sophos-mcp`](https://github.com/solomonneas/sophos-mcp) | Sophos Central | Endpoint management, EDR/XDR detections, alerts, Live Discover queries, security policies |
| [`hotwash`](https://github.com/lidless-labs/hotwash) | Incident-response runbooks | A visual playbook builder plus an MCP so an agent can start a run, advance steps, attach artifacts, and accept or dismiss suggestions. Not on npm, install from source |

### Network security telemetry

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`suricata-mcp`](https://github.com/lidless-labs/suricata-mcp) | Suricata IDS/IPS (and Zeek) | Analyze EVE JSON alerts, hunt threats, manage rules |
| [`zeek-mcp`](https://github.com/lidless-labs/zeek-mcp) | Zeek (network security monitor) and Suricata logs | Query, hunt, and correlate network telemetry across conn/dns/http/ssl/files |

### Threat-intel framework

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`mitre-mcp`](https://github.com/lidless-labs/mitre-mcp) | MITRE ATT&CK knowledge base | Look up techniques, tactics, mitigations, groups, software, and campaigns. Map an alert to a technique, profile a group, analyze detection coverage, export a Navigator layer |

### OSINT graph

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`maltego-mcp`](https://github.com/lidless-labs/maltego-mcp) | Maltego CE graphs | Primitive entity/relationship CRUD over MTGX graph files, plus whois, DNS, ASN, and crt.sh lookups. Works on the Basic plan. The repo moved to the `lidless-labs` org, so older links redirect |

### Code, memory, and skills for agents

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`graphtrail`](https://github.com/escoffier-labs/graphtrail) (`graphtrail-mcp` binary, on crates.io) | A local SQLite code graph | Callers, callees, impact, and context over a read-only MCP, no daemon and no network. The GitHub repo is an archived mirror, and the source lives in Brigade's `engines/code-graph` |
| [`brigade`](https://github.com/escoffier-labs/brigade) memory and skills servers | Brigade's memory cards and skill registry | `brigade memory serve-mcp --stdio` serves cards read-only (list, search, get). `brigade skills serve-mcp --stdio` serves skills (search, get, metadata, history, lint). Part of [Brigade](brigade.md), not a separate install |

[`miseledger`](https://github.com/escoffier-labs/miseledger) (a local SQLite full-text ledger for agent work history, source in Brigade's `engines/evidence-ledger`) is the same family but a CLI, not an MCP.

### Agent infrastructure (not MCPs, but agent-facing)

These are not MCPs - they ship as standalone tools the orchestrator or other agents shell out to:

| Tool | What it is |
|------|-----------|
| [Brigade guard](https://brigade.tools/docs/commands/guard) | Embedded policy scanner for outbound content. Runs on `pre-push` and in publish pipelines. Catches RFC 1918 IPs, secrets, and internal hostnames before they leave the workspace |
| [`usage-tracker`](https://github.com/escoffier-labs/usage-tracker) | Token usage and cost analytics across providers. Tails session JSONLs, attributes spend per agent/channel/model |
| [`agentpantry`](https://github.com/escoffier-labs/agentpantry) | Encrypted browser session, cookie, and secret sync between agent machines so a logged-in host stays authenticated. Go binary, dual-key PSK rotation |
| [`agent-notify`](https://github.com/escoffier-labs/agent-notify) | Private operator notifications for agent events - long-running run completions, approvals, blockers. Go binary, ships SBOM |
| [`cloche`](https://github.com/escoffier-labs/cloche) | Agent-neutral screenshot capture CLI (renamed from appshots). Rust, on crates.io (`cargo install cloche`) |
| [`openclaw-overlay`](https://github.com/solomonneas/openclaw-overlay) | HUD for session monitoring - which agent is talking to which channel, what tools fired, what cron job is in flight |
| [`opsdeck`](opsdeck.md) | Self-hosted ops dashboard - tasks, services, projects, memory, usage, security, architecture, and agent activity |

### Upstream contributions (not owned, but maintained alongside)

These are not published from this stack but they get tracked in the same release cadence because the agent depends on them:

| Project | Relationship |
|---------|--------------|
| [`steipete/mcporter`](https://github.com/steipete/mcporter) | Contributor. Fork at `solomonneas/mcporter` for PR work |
| [`@vincentkoc/tokenjuice`](https://github.com/vincentkoc/tokenjuice) | Contributor. PRs covering Claude Code, Codex, OpenClaw, and Hermes adapters |
| [`openclaw/octopool`](https://github.com/openclaw/octopool) | User. A shared GitHub read relay and cache that the agents use for public, read-only GitHub lookups. The unscoped `octopool` name on npm belongs to that upstream project |
| [`microsoft/playwright`](https://github.com/microsoft/playwright) | Contributor for playwright-cli sources |

## Conventions across every MCP

The repos share enough that you can read one and predict the rest:

- **TypeScript, MCP SDK transport.** Almost all speak the official MCP server-stdio transport. Where a server is shared between clients, I run it once behind a loopback-only HTTP endpoint instead, but none of the published packages tunnel MCP over the network.
- **Confirmation gates on destructive operations.** Anything that deletes, modifies, or restarts production state requires a `confirm: true` argument. Without it, the tool returns a structured "confirm required" response. The pattern lives in [`mcp-tool-handler-test-pattern`](https://github.com/lidless-labs/jellyctrl/tree/main/tests).
- **`--help` on the binary.** Every MCP can be launched directly from the command line for smoke checks: `npx <mcp-name> --help` prints tool list, required env vars, and version.
- **Five-client README.** Every README includes setup blocks for Claude Desktop, Claude Code, OpenClaw, Hermes Agent, and Codex CLI. See [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md).
- **No hard-coded service URLs.** Service base URL, token, and any per-instance flags come from environment variables. The README documents each one.
- **Secrets via env, never CLI args.** No MCP accepts a token as a command-line argument. It is too easy for it to land in `ps`, logs, or shell history.
- **Secrets injected per server at launch, not stored in client config.** Clients like Claude Code forward only a safe environment whitelist plus the explicit `env` block, so credentials would otherwise end up in plaintext in the client's JSON. I register each server with a small wrapper as its command: the wrapper reads a mode-0600 env file (the path comes from an environment variable, so each server can point at its own file), exports it, then `exec`s the real server command. The env file itself is rendered from the secret store, and the client config only holds the wrapper path and the server's script path.

## Lifecycle

A new MCP enters the catalog when:

1. The agent has already been doing the same thing through shell/curl/browser automation for at least two weeks.
2. There is no maintained MCP for the service already (or the existing one is too partial to use).
3. The service has a stable, documented API. Reverse-engineering web UI calls is not a basis for an MCP. That work belongs in a browser-automation layer.

A MCP leaves the catalog when:

- The underlying service is decommissioned in the stack.
- An upstream-maintained MCP for the same service ships at parity. In that case, the local MCP is archived with a pointer to the replacement.

## Verification

Spot-check that the catalog is honest about what is published:

```bash
# Every catalogued npm package resolves.
for pkg in jellyfin-mcp immich-mcp reelgrep-mcp postiz-mcp n8n-ops-mcp maltego-mcp \
           wazuh-mcp thehive-mcp thehive-cortex-mcp misp-mcp rapid7-mcp sophos-mcp \
           suricata-mcp zeek-mcp mitre-mcp \
           @solomonneas/proxmox-mcp @solomonneas/adguard-mcp @solomonneas/librenms-mcp; do
    npm view "$pkg" version >/dev/null 2>&1 \
      && echo "$pkg: OK" \
      || echo "$pkg: MISSING ON NPM"
done

# Every catalogued GitHub repo exists and is public. Expect PUBLIC on every line.
for repo in lidless-labs/jellyctrl lidless-labs/immichctrl lidless-labs/proxmox-mcp \
            lidless-labs/adguardctrl lidless-labs/librenmsctrl lidless-labs/hotwash \
            lidless-labs/maltego-mcp escoffier-labs/graphtrail; do
    echo "$repo: $(gh repo view "$repo" --json visibility -q .visibility)"
done

# Every MCP's repo has a five-client README (for repos you have checked out).
for mcp in jellyfin-mcp postiz-mcp n8n-ops-mcp; do
    grep -E "Claude Desktop|Claude Code|OpenClaw|Hermes|Codex CLI" \
         "$HOME/repos/$mcp/README.md" | wc -l
done    # Expect: 5 per README
```

A healthy stack: every catalog entry resolves on npm or on GitHub, every README contains all five client blocks, and `repo-redeploy.sh` is current for the MCPs that need a built `dist/` locally.

## Gotchas

**MCP names on npm and on GitHub are not always identical.** `cortex-mcp` is `thehive-cortex-mcp` on npm because `cortex-mcp` was taken. The "ctrl" repos kept their original package names (`jellyctrl` publishes `jellyfin-mcp`, `n8nctrl` publishes `n8n-ops-mcp`, `immichctrl` publishes `immich-mcp`). And the bare `proxmox-mcp` name on npm is a different author's package, so mine is scoped. Track both names in the redeploy manifest and in the catalog above, and always check `npm view <pkg> repository.url` before installing from a name you only half remember.

**One shared secrets file means every wrapped server can read every secret.** The launch wrapper sources a single env file by default, so a server that only needs its own token still gets the others in its environment. Point `MCP_SECRETS_FILE` at a per-server file for the high-value ones. The wrapper also logs a warning and carries on if the file is unreadable, so a missing file shows up as a server that fails on missing env vars, not as a wrapper error.

**A confirmation gate in one direction is not symmetry.** Destructive tools require `confirm: true`, but the agent has no way to require `confirm: false` for safety. Defense in depth: also gate the dangerous tools at the agent's `tools.allow` policy.

**Test fixtures that hit a real API will rot.** Each MCP has a fake-server capture pattern for unit tests. The integration-style tests are deliberately not in the repo (see [`mcp-tool-handler-test-pattern`](https://github.com/lidless-labs/jellyctrl)). If you add a new MCP, copy that pattern - do not write tests that hit a live service.

**`npm publish` on a working tree with private files in `dist/` will leak.** Always `npm pack --dry-run` before `npm publish` and review the tarball contents. The MCP release publish checklist lives in the parent repo's notes and has bitten every catalog entry at least once.

**The catalog is the README. Drift between this file and the actual published set is a bug.** Pair every new MCP publish with a catalog edit and a `git grep <mcp-name>` to find stale references.

## Templates

- [`../templates/ai-stack/`](../templates/ai-stack/) - model alias and adapter snippets that pair with these MCPs
- [`../templates/skills/SKILL.md`](../templates/skills/SKILL.md) - the skill shape that often wraps a single MCP tool call

## Related

- [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md) - the README shape every MCP repo ships with
- [`repo-redeploy.md`](repo-redeploy.md) - how these stay current on the agent host
- [`opsdeck.md`](opsdeck.md) - the dashboard that surfaces MCP health alongside service health
- [`../ai-stack/skills-development.md`](../ai-stack/skills-development.md) - skill patterns that wrap MCP tools
