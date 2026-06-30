# AdGuard Home as a Network DNS Sinkhole

> Block ads, trackers, and malware at the resolver instead of on every device, run a synced standby so a single reboot doesn't take DNS down, and let an AI agent query and tune it through tiered MCP tools where reads are open and anything that can break resolution stays gated. 🦞

**Tested on:** AdGuard Home in an unprivileged LXC container on Proxmox VE 9.2.3, a second AdGuardHome Sync instance keeping a standby aligned, an eero mesh LAN, and the operator's own `adguard-mcp` server (50 tools across three write tiers).
**Last updated:** 2026-06-30

---

## What This Is

A DNS sinkhole is a resolver that answers "no such host" (or a black-hole IP) for domains you don't want anything on the network to reach: ad servers, trackers, telemetry endpoints, known-malware domains. Everything else resolves normally. Because nearly every connection starts with a DNS lookup, blocking at that layer kills the request before the device ever opens a socket.

This guide covers running [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome) as the LAN's sinkhole on a home Proxmox lab: where it sits in the network, how a second synced instance gives you a standby, and how an AI agent reads and safely manages it through the operator's `adguard-mcp` server. It is the DNS-layer companion to the lab map in [`homelab-topology.md`](homelab-topology.md), where the resolver shows up as CT 100 with its sync sidecar at CT 118.

This is not a guide to per-app content filtering, a VPN, or a firewall. It is one specific job: be the resolver the whole network points at, and answer honestly for the domains you trust while answering "gone" for the ones you don't.

## Why DNS-Level Blocking

The case for blocking at the resolver instead of on each device:

- **One place, every device.** A browser extension protects one browser on one machine. A DNS sinkhole protects the phone that has no extension support, the smart TV that ships its own ad SDK, the IoT gadget you can't install anything on, and the guest laptop you've never touched. If it asks your resolver for a name, it's covered.
- **It's cheap.** The resolver does a dictionary lookup against in-memory blocklists. No packet inspection, no TLS interception, no per-connection cost. The DNS container idles at 512MB RAM and adds essentially zero latency to a cache hit.
- **It fails safe in the right direction.** A blocked domain just doesn't resolve. There's no broken-page interstitial to click through, no certificate warning, no MITM. The app gets `NXDOMAIN` or `0.0.0.0` and moves on.
- **It's observable.** Every lookup lands in a query log. You can see exactly what a device is phoning home to, which is its own quiet form of network intelligence.

The honest limits up front, because this matters for how you deploy: DNS blocking only sees what uses your DNS. A device that hardcodes its own resolver, or speaks DNS-over-HTTPS straight to a public endpoint, bypasses the sinkhole entirely. More on that in [Gotchas](#gotchas). The sinkhole is a high-leverage default, not a perimeter.

## Prerequisites

- A Proxmox host (or any LXC/VM host) with room for a tiny always-on guest. The resolver is the smallest service in the lab.
- A LAN where you can set the DNS server clients use, either network-wide or per-device. On an eero mesh that's the eero app's DNS field where it exists, and per-device DNS where it doesn't (see [Gotchas](#gotchas)).
- A stable IP for the resolver. DNS is the one service you do *not* want moving on a DHCP lease, so hand it a static address.
- Optional but recommended: a second small guest for the sync standby.
- For agent management: the [`adguard-mcp`](https://github.com/solomonneas/adguard-mcp) server wired into your agent harness, pointed at the resolver's admin API.

## Topology: Where It Sits

The sinkhole sits between every client on the LAN and the upstream resolvers out on the internet. Clients are configured to use it as their DNS server; it consults its blocklists, and for anything not blocked it forwards the query upstream and caches the answer.

```
LAN clients (phones, laptops, TVs, IoT, other guests)
        │  DNS queries (UDP/TCP 53)
        ▼
┌─────────────────────────────┐
│  The DNS container (CT 100) │   AdGuard Home
│  - blocklists in memory     │   answers NXDOMAIN / 0.0.0.0 for blocked names
│  - per-client rules         │   forwards everything else upstream
│  - query log + stats        │
└──────────────┬──────────────┘
               │  forwards non-blocked queries
               ▼
        Upstream resolvers (DoH/DoT to a public provider)
               ▲
               │  config push, one direction
┌──────────────┴──────────────┐
│  The sync standby (CT 118)  │   AdGuardHome Sync
│  keeps a second AGH aligned │   so a reboot/maintenance of CT 100
│  with the primary's config  │   doesn't mean no resolver at all
└─────────────────────────────┘
```

### The HA Pair

DNS is the one service whose outage looks like "the entire internet is broken." On a single-node lab the resolver is a guest on the same host it serves, which is a known circular dependency (covered in [`homelab-topology.md`](homelab-topology.md)). The mitigation for the common case, you reboot the DNS container or it crashes, is a second AdGuard Home instance kept config-aligned by [AdGuardHome Sync](https://github.com/bakito/adguardhome-sync).

The shape:

- **The DNS container** is the primary. It's where you make changes: subscribe to a blocklist, add a rule, register a client. It carries the live query log and stats.
- **The sync standby** runs a second AdGuard Home plus the AdGuardHome Sync daemon. Sync reads the primary's config and pushes it to the replica so the two stay aligned. Then you point clients at *both* as primary and secondary DNS, so if one box is down, resolution rolls to the other with the same blocklists and rules already in place.

This is not failover in the clustered sense, there's no shared state or automatic promotion. It's "two resolvers that agree, listed as primary and secondary, so a reboot is a blip and not an outage." For a home lab that's the right amount of HA. Sync runs in one direction, primary to replica, so you always edit the primary and let the daemon carry the change. Edit the replica directly and the next sync run overwrites it (see [Gotchas](#gotchas)).

## Setup Outline

The full AdGuard Home install docs are upstream; this is the shape that matters for a sinkhole.

### 1. The DNS container

Create a small unprivileged LXC (512MB RAM, a couple GB disk is plenty), give it a **static IP**, and install AdGuard Home inside it. Run its setup wizard, set an admin username and password, and bind the DNS listener to port 53 and the admin UI to its own port. Confirm the container is listening on 53 before you point anything at it.

### 2. Upstreams

Configure upstream resolvers so non-blocked queries leave the lab encrypted. Use DNS-over-HTTPS or DNS-over-TLS to a public provider rather than plain port 53 upstream, so your own queries aren't readable on the wire to your ISP. Set a bootstrap resolver (a plain IP) so AGH can resolve the DoH/DoT hostname itself at startup. Parallel upstream queries trade a little extra outbound traffic for lower tail latency, which is usually worth it at home.

You can read the live upstream config back with the agent at any time via `adguard_get_dns_config`.

### 3. Blocklists

Subscribe to a few well-maintained blocklists. AGH ships with a sensible default list; the common additions are a general ad/tracker list and a malware-domains list. Don't over-subscribe: ten overlapping lists mostly add load and false positives, not coverage. Start with two or three, watch the query log for a week, and add user rules for the specific things that slip through.

Blocklists are just URLs to hosts-format or AdGuard-syntax files. A user rule for a single domain looks like:

```
||ads.example.com^
```

and an allow (unblock) rule that punches a hole for one domain a blocklist over-blocked looks like:

```
@@||telemetry.example.org^
```

Both can be managed by the agent (`adguard_add_user_rule` / `adguard_add_filter_list`), so you rarely have to open the UI for routine tuning.

### 4. Point the LAN at it

Set the resolver as the network's DNS server where your gear allows it, and per-device elsewhere. List the primary and the standby as the two DNS servers so resolution survives one box being down. On an eero mesh this is the practical sticking point, covered next.

## Agent Management via adguard-mcp

The operator runs their own MCP server, [`adguard-mcp`](https://github.com/solomonneas/adguard-mcp), which exposes AdGuard Home (and AdGuardHome Sync) to an AI agent as structured tools. It is **50 tools split into three write tiers**, and the tiering is the whole safety story:

- **Reads (22):** open, no confirmation. Status, stats, query log, filter lists, user rules, clients, blocked-services catalog, host checks, DNS config, SafeSearch settings, DNS rewrites and access lists, query-log and stats config, DHCP and TLS status, and the three Sync read tools.
- **Safe writes (22):** require an explicit `confirm: true`. Add or remove a user rule, subscribe or unsubscribe a blocklist, toggle or refresh lists, add or update a client, set blocked services (global and per-client), toggle SafeSearch/SafeBrowsing, add/update/delete and toggle DNS rewrites, set the access list, update query-log and stats config, validate TLS config, test an upstream resolver, and trigger a sync run.
- **Destructive (6):** require `confirm: true` **and** `destructive: true`. Wholesale replace the user-rules block, toggle global protection (off = all blocking stops), delete a client, clear the query log, reset stats, clear sync logs.

The model literally cannot disable protection or overwrite the rules block from a single hallucinated call, because the destructive tier needs two explicit boolean flags the agent has to mean to set. Credentials live only in memory after env-load and are redacted from logs and errors.

### Representative read calls (always open)

Ask the agent "is DNS healthy and what's getting blocked," and it reaches for reads:

```jsonc
// Is the resolver up and is protection on?
adguard_status {}

// What's the blocked/allowed split and who are the top talkers?
adguard_stats {}

// Show me the last lookups, filtered
adguard_query_log { "search": "example.com", "limit": 50 }

// What WOULD AGH do with this hostname right now?
adguard_check_host { "name": "ads.example.com" }
// -> filtered: true, rule: "||ads.example.com^", matched list, CNAME chain

// Are the two boxes actually in sync?
adguard_sync_status {}
adguard_sync_health {}
```

`adguard_check_host` is the one I lean on most: it answers "why is this domain blocked (or not)" by showing the exact rule and list that matched, without you tailing a log.

### Representative safe-write calls (gated on confirm)

Routine tuning. Each needs `confirm: true`, so an agent can't make a change as a side effect of thinking out loud:

```jsonc
// Block a newly-spotted tracker
adguard_add_user_rule { "rule": "||tracker.example.net^", "confirm": true }

// A blocklist over-blocked something you need; punch a hole
adguard_add_user_rule { "rule": "@@||telemetry.example.org^", "confirm": true }

// Subscribe a new malware list
adguard_add_filter_list {
  "url": "https://example.com/lists/malware.txt",
  "name": "malware-domains",
  "confirm": true
}

// Force lists to refresh now instead of waiting for the schedule
adguard_refresh_filter_lists { "confirm": true }

// Push current config to the standby immediately
adguard_sync_run { "confirm": true }
```

### What stays gated (destructive, needs two flags)

These are the ones that can break resolution or lose data, so they need both flags and should stay a human-in-the-loop decision:

```jsonc
// Turn ALL blocking off. This is how you make the whole network
// go unfiltered. Two flags, on purpose.
adguard_toggle_protection { "enabled": false, "confirm": true, "destructive": true }

// Replace the entire user-rules block wholesale (not append)
adguard_replace_user_rules { "rules": ["||ads.example.com^"], "confirm": true, "destructive": true }

// Wipe the query log
adguard_clear_query_log { "confirm": true, "destructive": true }
```

The practical rule: let the agent run reads freely, let it do safe writes with a clear instruction and the `confirm` flag, and keep the destructive tier as something you approve explicitly. `adguard_toggle_protection { enabled: false }` is the single most dangerous call in the set, because it silently turns the sinkhole into a pass-through resolver, and the tiering is built so a model can't reach it casually.

### Addressing the two boxes

Each AdGuard Home instance is a named MCP instance, derived from its env-var middle segment (`ADGUARD_PRIMARY_URL`, `ADGUARD_STANDBY_URL`, and so on). Every tool takes an optional `instance: "<name>"` to target a specific box, defaulting to `ADGUARD_DEFAULT_INSTANCE`. The Sync server is configured under its own `ADGUARDHOME_SYNC_*` prefix so it never collides with an AGH instance name. So "check the standby's status" is just `adguard_status { "instance": "standby" }`, and the Sync tools talk to the daemon, not to either resolver.

## Verification

DNS is easy to verify because you can ask it a question and read the answer directly. Point your query tool at the sinkhole's IP (use `192.0.2.10` as the placeholder for the resolver here).

```bash
# A domain that should resolve normally: expect a real IP / NOERROR
dig @192.0.2.10 example.com +short

# A domain on a blocklist: expect NXDOMAIN or 0.0.0.0 depending on
# AGH's blocking mode. "no answer" / 0.0.0.0 means the sinkhole bit.
dig @192.0.2.10 ads.example.com

# Same check with nslookup if dig isn't around
nslookup ads.example.com 192.0.2.10

# Confirm the standby answers identically, so failover is real
dig @192.0.2.11 ads.example.com
```

Then confirm from the control plane, ideally through the agent so you're exercising the same path you'll manage by:

```jsonc
// Protection on, server up
adguard_status {}

// The blocked lookup you just made should be in the log, flagged blocked
adguard_query_log { "search": "ads.example.com", "limit": 10 }

// The two boxes agree
adguard_sync_status {}
```

Expected: the good domain returns an address, the bad domain returns NXDOMAIN or `0.0.0.0`, the *standby* returns the same for the bad domain, the query log shows the blocked lookup with its matching rule, and sync status reports the replica aligned with the primary. If the standby resolves a domain the primary blocks, sync has drifted, fix that before you trust failover.

## Gotchas

1. **eero mesh has limited per-client DNS control.** An eero mesh lets you set a network-wide DNS, but it does not give you the per-client DHCP-option DNS targeting a managed switch or router would. So the sinkhole goes in as the **network** DNS where eero allows it, and **per-device** everywhere the device lets you set a custom resolver. This is the honest reality of a consumer mesh: you get most clients via the network setting and you hand-set the stubborn ones. Don't expect a clean "every client, enforced by DHCP" story without managed gear.

2. **The sync standby drifts if you edit the replica.** AdGuardHome Sync runs one direction, primary to replica. Always make changes on the primary and let sync carry them. If you edit the standby's blocklists or rules directly, the next sync run silently overwrites your change and you'll chase a "why did my rule disappear" ghost. Treat the standby as read-only and drive everything through the primary (or through `adguard_*` against the primary instance).

3. **DoH/DoT clients bypass the sinkhole entirely.** A device that speaks DNS-over-HTTPS or DNS-over-TLS straight to a public endpoint never asks your resolver, so your blocklists never see the query. Modern browsers ship DoH that can default on, and some apps hardcode their own resolver. Mitigations: turn off the browser's built-in secure DNS so it uses the system resolver, and where your network gear allows it, block outbound port 853 (DoT) and known public DoH IPs so devices fall back to your resolver. You won't catch every bypass on consumer gear. The sinkhole is a strong default, not an enforced perimeter, and a determined device or a hostile app can route around it.

4. **DNS lives inside the lab, so the host going down takes DNS with it.** The resolver is a guest on the same hypervisor it serves. If the node is down, LAN DNS is down. The standby helps only if it's on different hardware; on a single node both AGH instances share the host's fate. For a single-node home lab that's an accepted circular dependency (see [`homelab-topology.md`](homelab-topology.md)), but know it before you debug an "internet is broken" panic that's really "the hypervisor rebooted."

5. **`adguard_toggle_protection { enabled: false }` is the silent kill switch.** It doesn't error, it doesn't warn, it just turns the whole sinkhole into a pass-through resolver and every blocked domain starts resolving. That's exactly why it's in the destructive tier behind two flags. If blocking ever "just stops working" network-wide, check protection state first (`adguard_status`) before you go spelunking through blocklists.

6. **Over-subscribing blocklists hurts more than it helps.** Ten overlapping lists add load and false positives, not meaningful coverage. Two or three good lists plus a handful of targeted user rules beats a wall of redundant subscriptions. When something legitimate breaks, the fix is usually one `@@||domain^` allow rule, not unsubscribing a whole list and going dark on everything else it covered.

7. **Give the resolver a static IP.** DNS is the one service you never want moving on a lease renewal, because every client points at it by address. A DHCP lease change on the resolver is a network-wide outage. Hand it a static address and list both primary and standby on your clients.

8. **Per-client rules and stats die with the client entry.** `adguard_delete_client` is destructive for a reason: removing a named client loses its per-client blocked-services config and its stats. If you're just reorganizing, update the client (`adguard_update_client`) rather than delete-and-recreate.

## Related

- [`homelab-topology.md`](homelab-topology.md) - the lab map: the DNS container (CT 100) and its sync sidecar (CT 118), the single-node circular dependency, and where everything else lives
- [`service-isolation.md`](service-isolation.md) - why the sync daemon is split into its own sidecar container so its failures can't take DNS resolution down with it
- [`../security/wazuh-triage.md`](../security/wazuh-triage.md) - the SIEM that caught a DNS container crash-looping silently for 32 days behind a quiet alert channel
- [`../security/incident-runbook.md`](../security/incident-runbook.md) - response sequence when query-log anomalies turn out to be a real device phoning somewhere it shouldn't
