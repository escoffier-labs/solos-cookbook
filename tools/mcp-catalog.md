# MCP Catalog

> Every MCP server published from this stack, what each one wraps, and where it fits. Most exist because a service the agent needed to talk to did not have a maintained MCP yet, so I wrote one.

## What this is

An index of the MCP servers shipped from this cookbook's parent stack. All are open source, all are dual-published to npm and ClawHub, and all follow the same shape: a thin TypeScript wrapper that converts MCP tool calls into authenticated REST or RPC calls against an existing service, with confirmation gates on destructive operations.

If you are looking for the agent-side patterns for how these get consumed (Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI), see [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md). This guide is about the inventory.

## Why this way

Three reasons there are this many of them:

1. **Most third-party tools do not ship MCPs yet, or ship thin ones.** The 2026-era MCP ecosystem is still mostly experiments. If you want an agent to manage a service that already has a clean HTTP API, the gap between "no MCP" and "good MCP" is a weekend.
2. **A purpose-built MCP beats a generic HTTP MCP.** A generic `http_request` MCP forces the agent to remember endpoints, auth schemes, and response shapes. A typed MCP turns the same workflow into named tools with input validation, confirmation gates, and uniform error surfacing.
3. **The catalog grows along the workload, not ahead of it.** Each MCP in the list below was written because the orchestrator already needed to do that work weekly and was doing it through shell scripts or browser automation.

The cost is maintenance: every MCP is a small TypeScript repo with its own release cadence, README, and schema-drift exposure. That cost is bounded by [`repo-redeploy.md`](repo-redeploy.md) and the MCP release publish checklist.

## Catalog

Grouped by what the underlying service does. Versions move; see each repo for current. Every MCP listed is published to both [npm](https://www.npmjs.com) and the [ClawHub](https://clawhub.ai) plugin registry, and tested against the five clients in [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md).

### Media & home services

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`jellyfin-mcp`](https://github.com/solomonneas/jellyfin-mcp) | Jellyfin media server | List libraries, scan, list sessions, control playback, manage playlists/collections, manage users, run scheduled tasks, Quick Connect auth |
| [`media-cli`](https://github.com/solomonneas/media-cli) | Radarr / Sonarr / Prowlarr ("arr stack") | This is a CLI, not an MCP. The agent shells out to it for `arr search`, `arr add`, `arr health`. See [`repo-redeploy.md`](repo-redeploy.md) for how it stays current |

### Social & publishing

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`postiz-mcp`](https://github.com/solomonneas/postiz-mcp) | Postiz scheduled-posting platform | Create/schedule/delete posts and post groups, list integrations, check integration health, get post + platform analytics, find next scheduling slot, upload media, invoke per-provider integration tools |

### Security operations

The SOC-side stack lands six MCPs against a typical purple-team toolchain. Each one has a confirmation gate on destructive operations.

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`wazuh-mcp`](https://github.com/solomonneas/wazuh-mcp) | Wazuh SIEM/XDR | List/search alerts, agent inventory, agent processes/ports/packages/network, FIM files, manager config + logs, rules/decoders, SCA checks, rootcheck |
| [`thehive-mcp`](https://github.com/solomonneas/thehive-mcp) | TheHive case management | Cases, alerts, tasks, observables, custom fields - read-leaning, with explicit write tools gated |
| [`cortex-mcp`](https://github.com/solomonneas/cortex-mcp) (`thehive-cortex-mcp`) | Cortex analyzer/responder runs | Job submission, results, analyzer catalog. Pairs with `thehive-mcp` |
| [`misp-mcp`](https://github.com/solomonneas/misp-mcp) | MISP threat-intel platform | Event/attribute/tag CRUD, feeds, sharing groups, taxonomies |
| [`rapid7-mcp`](https://github.com/solomonneas/rapid7-mcp) | Rapid7 InsightVM | Asset inventory, vulnerability findings, scan templates, site management |
| [`sophos-mcp`](https://github.com/solomonneas/sophos-mcp) | Sophos Central | Endpoint inventory, alerts, isolation, scan triggers |

### Network security telemetry

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`suricata-mcp`](https://github.com/solomonneas/suricata-mcp) | Suricata IDS | Alert search, rule management, ruleset reload, traffic stats |
| [`zeek-mcp`](https://github.com/solomonneas/zeek-mcp) | Zeek (network security monitor) | Log search across conn/dns/http/ssl/files, signature management |

### Threat-intel framework

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`mitre-mcp`](https://github.com/solomonneas/mitre-mcp) | MITRE ATT&CK + D3FEND knowledge bases | Lookup techniques, tactics, mitigations, groups, software, relationships |

### OSINT graph

| MCP | Wraps | What the agent does with it |
|-----|-------|----------------------------|
| [`maltego-mcp`](https://github.com/solomonneas/maltego-mcp) | Maltego CE graphs | Primitive entity/relationship CRUD over MTGX graph files. Phase B Python TRX bridges into Maltego Desktop for real-time pivots |

### Agent infrastructure (not MCPs, but agent-facing)

These are not MCPs - they ship as standalone tools the orchestrator or other agents shell out to:

| Tool | What it is |
|------|-----------|
| [`content-guard`](https://github.com/solomonneas/content-guard) | Policy-driven scanner for outbound content. Runs on `pre-push`, in publish pipelines, and in agent message hooks. Catches RFC 1918 IPs, secrets, internal hostnames before they leave the workspace |
| [`usage-tracker`](https://github.com/solomonneas/usage-tracker) | Token usage and cost analytics across providers. Tails session JSONLs, attributes spend per agent/channel/model |
| [`openclaw-overlay`](https://github.com/solomonneas/openclaw-overlay) | HUD for session monitoring - which agent is talking to which channel, what tools fired, what cron job is in flight |
| [`ops-deck-oss`](https://github.com/solomonneas/ops-deck-oss) | Self-hosted ops dashboard - service health, cron freshness, backup status, agent activity. See [`opsdeck.md`](opsdeck.md) |

### Upstream contributions (not owned, but maintained alongside)

These are not published from this stack but they get tracked in the same release cadence because the agent depends on them:

| Project | Relationship |
|---------|--------------|
| [`steipete/mcporter`](https://github.com/steipete/mcporter) | Contributor. Fork at `solomonneas/mcporter` for PR work |
| [`@vincentkoc/tokenjuice`](https://github.com/vincentkoc/tokenjuice) | Contributor. PRs covering Claude Code, Codex, OpenClaw, and Hermes adapters |
| [`microsoft/playwright`](https://github.com/microsoft/playwright) | Contributor for playwright-cli sources |

## Conventions across every MCP

The repos share enough that you can read one and predict the rest:

- **TypeScript, MCP SDK transport.** All speak the official MCP server-stdio transport. No HTTP-tunneled MCPs.
- **Confirmation gates on destructive operations.** Anything that deletes, modifies, or restarts production state requires a `confirm: true` argument. Without it, the tool returns a structured "confirm required" response. The pattern lives in [`mcp-tool-handler-test-pattern`](https://github.com/solomonneas/jellyfin-mcp/tree/main/tests).
- **`--help` on the binary.** Every MCP can be launched directly from the command line for smoke checks: `npx <mcp-name> --help` prints tool list, required env vars, and version.
- **Five-client README.** Every README includes setup blocks for Claude Desktop, Claude Code, OpenClaw, Hermes Agent, and Codex CLI. See [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md).
- **No hard-coded service URLs.** Service base URL, token, and any per-instance flags come from environment variables. The README documents each one.
- **Secrets via env, never CLI args.** No MCP accepts a token as a command-line argument - too easy for it to land in `ps`, logs, or shell history.

## Lifecycle

A new MCP enters the catalog when:

1. The agent has already been doing the same thing through shell/curl/browser automation for at least two weeks.
2. There is no maintained MCP for the service already (or the existing one is too partial to use).
3. The service has a stable, documented API. Reverse-engineering web UI calls is not a basis for an MCP; that work belongs in a browser-automation layer.

A MCP leaves the catalog when:

- The underlying service is decommissioned in the stack.
- An upstream-maintained MCP for the same service ships at parity. In that case, the local MCP is archived with a pointer to the replacement.

## Verification

Spot-check that the catalog is honest about what is published:

```bash
# Every catalogued MCP is on npm.
for mcp in jellyfin-mcp postiz-mcp n8n-ops-mcp maltego-mcp \
           wazuh-mcp thehive-mcp misp-mcp rapid7-mcp sophos-mcp \
           suricata-mcp zeek-mcp mitre-mcp \
           thehive-cortex-mcp; do
    npm view "$mcp" version >/dev/null 2>&1 \
      && echo "$mcp: OK" \
      || echo "$mcp: MISSING ON NPM"
done

# Every MCP's repo has a five-client README.
for mcp in jellyfin-mcp postiz-mcp n8n-ops-mcp; do
    grep -E "Claude Desktop|Claude Code|OpenClaw|Hermes|Codex CLI" \
         "$HOME/repos/$mcp/README.md" | wc -l
done    # Expect: 5 per README
```

A healthy stack: every catalog entry resolves on npm, every README contains all five client blocks, and `repo-redeploy.sh` is current for the MCPs that need a built `dist/` locally.

## Gotchas

**MCP names on npm and on GitHub are not always identical.** `cortex-mcp` is `thehive-cortex-mcp` on npm because `cortex-mcp` was taken. Track both names in the redeploy script and in the catalog above.

**A confirmation gate in one direction is not symmetry.** Destructive tools require `confirm: true`, but the agent has no way to require `confirm: false` for safety. Defense in depth: also gate the dangerous tools at the agent's `tools.allow` policy.

**Test fixtures that hit a real API will rot.** Each MCP has a fake-server capture pattern for unit tests; the integration-style tests are deliberately not in the repo (see [`mcp-tool-handler-test-pattern`](https://github.com/solomonneas/jellyfin-mcp)). If you add a new MCP, copy that pattern - do not write tests that hit a live service.

**`npm publish` on a working tree with private files in `dist/` will leak.** Always `npm pack --dry-run` before `npm publish` and review the tarball contents. The MCP release publish checklist lives in the parent repo's notes and has bitten every catalog entry at least once.

**ClawHub package names use `clawhub:<name>` install syntax, not `npm i`.** Documentation that confuses the two breaks setup for half the OpenClaw users. Always test the ClawHub install path against a fresh sandbox before publishing.

**The catalog is the README. Drift between this file and the actual published set is a bug.** Pair every new MCP publish with a catalog edit and a `git grep <mcp-name>` to find stale references.

## Templates

- [`../templates/ai-stack/`](../templates/ai-stack/) - model alias and adapter snippets that pair with these MCPs
- [`../templates/skills/SKILL.md`](../templates/skills/SKILL.md) - the skill shape that often wraps a single MCP tool call

## Related

- [`mcp-readme-five-clients.md`](mcp-readme-five-clients.md) - the README shape every MCP repo ships with
- [`repo-redeploy.md`](repo-redeploy.md) - how these stay current on the agent host
- [`opsdeck.md`](opsdeck.md) - the dashboard that surfaces MCP health alongside service health
- [`../ai-stack/skills-development.md`](../ai-stack/skills-development.md) - skill patterns that wrap MCP tools
