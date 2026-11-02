# Remote Access: Tailnet for Me, Cloudflare Tunnels for Cloud Agents

> How I reach an always-on agent host from outside the house: a Tailscale tailnet for operator traffic, Cloudflare Tunnels for the few MCP endpoints that cloud-hosted agents must call. No router port-forwards, one systemd unit per tunnel.

**Tested on:** Ubuntu 24.04.5, Tailscale 1.104.1, cloudflared 2026.10.4, T3 Code CLI 0.1.4-nightly (server), OpenClaw 2026.10.5, Brigade 0.31.0, systemd user services
**Last updated:** 2026-11-02

## What this is

The agent host runs 24/7 and I need to reach it from a laptop, a phone, and a Windows desktop (private operator access), and I also need a handful of cloud-hosted agents to call specific MCP servers on it (public-internet callers I do not control). Those are different trust problems, so I use two different tools.

The tailnet carries everything meant for me: the T3 Code server, SSH, the OpenClaw gateway, and an SSH tunnel to the T3 server on a Windows desktop. Cloudflare Tunnels carry only named MCP endpoints, each one a separate outbound-only tunnel to a loopback port. Nothing is port-forwarded on the router.

## Why this way

| Option | Reachable from | Inbound port on router | Auth you must add | Use it for |
|--------|----------------|------------------------|-------------------|------------|
| Port-forward | Whole internet | Yes | All of it, plus TLS and patching | Nothing in this setup |
| Tailnet (Tailscale) | Devices in my tailnet only | No | Device identity from the tailnet, plus the service's own auth | Operator access: T3 Code, SSH, OpenClaw gateway |
| `tailscale serve` | Tailnet only, HTTPS | No | Same as tailnet | A tailnet-only HTTPS URL in front of a loopback service |
| `tailscale funnel` | Whole internet | No | All of it | Not used here, and I checked it is off |
| Cloudflare Tunnel | Whole internet, via Cloudflare | No (outbound only) | Bearer token or Cloudflare Access on the hostname | Endpoints a cloud agent has to call |

The deciding question is who the caller is. If it is me, or a machine I enrolled, it goes over the tailnet. A cloud agent cannot join my tailnet, so it needs a public hostname, and a tunnel gives it one without opening the host. I keep the tunnel list short and per-service. One tunnel per MCP means a leaked tunnel token exposes one origin, and I can stop one unit without touching the others.

Layout, with every service bound as narrowly as it can be:

| Listener | Bound to | Reached by |
|----------|----------|------------|
| T3 Code server | tailnet address only | Operator devices over the tailnet |
| Loopback shim for the T3 server | loopback | Local adapters that insist on `127.0.0.1` |
| `tailscale serve` HTTPS frontends | tailnet only (HTTPS), proxy to loopback | Operator devices |
| OpenClaw gateway | `0.0.0.0` (`lan` bind), token auth, rate limiting | LAN and the `serve` frontend |
| MCP origins behind tunnels | loopback | `cloudflared` on the same host |
| `cloudflared` metrics | loopback | Local `/ready` checks |

This guide is about reachability. Host firewall, SSH config, and agent-level controls live in [Linux hardening](../security/linux-hardening.md) and [Agent security hardening](../security/agent-security-hardening.md). I do not repeat them here.

## Prerequisites

- An always-on Linux host with systemd user services and lingering enabled
- A Tailscale account with the host enrolled, with MagicDNS and HTTPS certificates enabled if you want `serve` frontends
- A Cloudflare account with a zone you control, for the tunnel hostnames (examples below use `example.com`)
- `cloudflared` installed for your user, and tunnels created in the Cloudflare dashboard, so each one has a connector token
- A private place for token files (mode `0600`, outside any repo). See [Secret management](../security/secret-management.md)
- Comfort with systemd units and `ss`

## Before / After

**Before:** remote access means whatever happens to listen on a reachable address. Operator tools and agent-facing MCP servers share the same exposure, and cloud agents cannot reach MCP servers on a private host at all.

**After:** operator traffic rides the tailnet and I can say which address every service listens on (the `ss` summary in Verification). Cloud agents reach exactly the MCP endpoints I chose, through per-service tunnels that dial out. Nothing is port-forwarded on the router.

## Implementation

### 1. Bind the T3 Code server to the tailnet address

The server listens on the tailnet IPv4 address only, so LAN neighbours and the public internet cannot reach it, while every device in the tailnet can. The address is resolved at start time, so the unit orders itself after `tailscaled`:

```ini
# ~/.config/systemd/user/t3-code.service
[Unit]
Description=T3 Code headless server
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
Type=simple
Environment=T3CODE_NO_BROWSER=1
ExecStart=/bin/bash -lc 'exec "$HOME/.local/bin/t3" serve --no-browser --host "$(/usr/bin/tailscale ip -4)" --port 3773 --base-dir "$HOME/.t3"'
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=process
SendSIGKILL=no

[Install]
WantedBy=default.target
```

`KillMode=process` and `SendSIGKILL=no` are there because I do not want a service restart to kill agent sessions the server spawned. My live unit also loads a service-account env file for credential brokering. That is specific to my setup and omitted above.

### 2. Add a loopback shim for tools that insist on 127.0.0.1

Some local adapters only know how to call `127.0.0.1:<port>`. Instead of rebinding the server, I run a tiny forwarder that listens on loopback and relays to the tailnet address. It shares the port number with the server but binds a different interface, so the two do not collide:

```ini
# ~/.config/systemd/user/t3-code-loopback-proxy.service
[Unit]
Description=Loopback proxy for the T3 server
After=t3-code.service
Requires=t3-code.service
PartOf=t3-code.service

[Service]
Type=simple
ExecStart=/usr/bin/ncat --listen --keep-open 127.0.0.1 3773 --sh-exec "/usr/bin/ncat $(/usr/bin/tailscale ip -4) 3773"
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=yes
MemoryDenyWriteExecute=yes

[Install]
WantedBy=default.target
```

`PartOf=` ties its lifecycle to the server, so restarting `t3-code.service` restarts the shim too.

### 3. Reach a Windows desktop's T3 server through an SSH tunnel

The desktop runs its own T3 server on its own tailnet address. I forward it to a port on the host's tailnet address, so every device in the tailnet can use the host as the single door. The script resolves the host's tailnet address at start, and the unit just runs it:

```bash
#!/usr/bin/env bash
# ~/.local/bin/t3-desktop-tunnel
set -euo pipefail

host_ip="$(tailscale ip -4)"
if [[ -z "$host_ip" ]]; then
  echo "No tailnet IPv4 address." >&2
  exit 1
fi

exec ssh \
  -N \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "${host_ip}:3775:<desktop-tailnet-address>:3773" \
  <desktop-ssh-alias>
```

```ini
# ~/.config/systemd/user/t3-desktop-tunnel.service
[Unit]
Description=T3 Code tunnel to the desktop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/t3-desktop-tunnel
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

`ExitOnForwardFailure=yes` is the important flag. Without it, ssh stays connected with a dead forward and systemd thinks everything is fine.

### 4. Put HTTPS in front of loopback services with `tailscale serve`

For services that only speak plain HTTP on loopback, `tailscale serve` gives a tailnet-only HTTPS URL with a real certificate. I use one distinct HTTPS port per service (the OpenClaw gateway is one of them):

```bash
# Proxy a tailnet-only HTTPS port to a loopback service.
tailscale serve --bg --https=<https-port> http://127.0.0.1:<service-port>

# Read-only review of what is published:
tailscale serve status
tailscale funnel status
```

Do not use `tailscale funnel` for any of this. Funnel publishes to the whole internet and I want the public path to be exactly one thing, the tunnels below.

### 5. Keep the OpenClaw gateway on the `lan` bind

The gateway offers a `tailnet` bind mode, and it sounds like the right choice for a tailnet-only service. It is not. In that mode the gateway listens on the tailnet address only and drops loopback. Every local caller that uses `127.0.0.1` (cron scripts, plugin smoke checks, CLI calls on the host) breaks. I stayed on `lan`, which binds `0.0.0.0`, and compensated with token authentication and rate limiting:

```json
{
  "gateway": {
    "bind": "lan",
    "port": 18789,
    "auth": {
      "mode": "token",
      "rateLimit": {
        "maxAttempts": 10,
        "windowMs": 60000,
        "lockoutMs": 300000,
        "exemptLoopback": true
      }
    }
  }
}
```

Remote devices that should use TLS go through the `tailscale serve` frontend from step 4. The topology of the host itself is in [OpenClaw host topology](openclaw-host-topology.md).

### 6. One Cloudflare Tunnel per MCP endpoint

Each tunnel is a token-based, dashboard-managed tunnel. The unit starts `cloudflared` with a token read from a file. The public hostname (for example `mcp.example.com`) and its ingress rule, pointing at a loopback origin, live in the Cloudflare dashboard, not on disk:

```ini
# ~/.config/systemd/user/cloudflared-<service>.service
[Unit]
Description=Cloudflare Tunnel for <service> MCP
After=network-online.target <service>.service
Wants=network-online.target <service>.service

[Service]
Type=simple
ExecStart=%h/.local/bin/cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<unique-metrics-port> run --token-file %h/.config/<service>/<tunnel-token-file>
Restart=on-failure
RestartSec=5s
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
RestrictSUIDSGID=yes
RestrictRealtime=yes

[Install]
WantedBy=default.target
```

Details that matter:

- `--token-file` keeps the token out of `ps` output and out of the unit file. A token passed as `--token <value>` is visible to every local user in the process list. The file is `0600` and owned by the service user.
- `--metrics 127.0.0.1:<unique-metrics-port>` pins each tunnel's metrics listener to loopback on its own port, which makes `/ready` checks deterministic. I have eight tunnels on one host, so I assign the ports by hand.
- `--no-autoupdate` because I update the binary myself.
- `After=<service>.service` so the origin is up before the tunnel starts accepting traffic.
- The origin MCP server binds `127.0.0.1` only. The tunnel is its only public path.

### 7. Authenticate in front of the origin

A tunnel makes an endpoint reachable. It does not decide who may use it. Two layers are available:

- **Bearer auth at the origin.** The origin MCP server checks a bearer token on every request and refuses without it. One of my MCP origins does this: its unit loads a token env file with `EnvironmentFile=`, and that is separate from the tunnel token. Use a different secret for each. A skeleton env file is in [`templates/security/service.env.example`](../templates/security/service.env.example).
- **Cloudflare Access on the hostname.** An Access application in front of the hostname adds identity or service-token checks before a request reaches the tunnel. I describe it as an option here and have not verified an Access configuration on this host, so I am not documenting its setup.

Whichever you choose, do not leave an MCP tunnel with neither. MCP tools can act, and an unauthenticated tunnel is an unauthenticated tool endpoint on the public internet. See [MCP incident response](../security/mcp-incident-response.md) for what a bad day looks like.

### 8. Planned, not shipped yet

These are Brigade issues I am tracking. None of them is in a release I run, so nothing above depends on them.

- Hub Lite, a deploy-your-own Fleet Hub as a Cloudflare Worker on the free plan: [escoffier-labs/brigade#2008](https://github.com/escoffier-labs/brigade/issues/2008). Status: planned, not shipped yet.
- A no-hub mode with peer-to-peer encrypted agent messaging: [escoffier-labs/brigade#2007](https://github.com/escoffier-labs/brigade/issues/2007). Status: planned, not shipped yet.
- End-to-end encrypted message bodies for fleet messaging: [escoffier-labs/brigade#2005](https://github.com/escoffier-labs/brigade/issues/2005). The issue's own status says some internal pieces are merged but encrypted CLI and MCP messaging is not active. Status: planned, not shipped yet.

Today, my Fleet Hub is reachable only over the overlay network (see [Homelab topology](homelab-topology.md)), which is the same tailnet-for-operators rule as above.

## Verification

Run these on the host. Output is scrubbed: names are placeholders and `100.64.0.10` is an example tailnet address and does not match any real node.

```bash
tailscale version | head -1
# 1.104.1
cloudflared --version
# cloudflared version 2026.10.4 (built 2026-10-26-11:12 UTC)
```

Services that must be up:

```bash
systemctl --user is-active t3-code t3-code-loopback-proxy t3-desktop-tunnel \
  cloudflared-<service>
# active
# active
# active
# active
```

Which interface each listener is on. The T3 server and the desktop forward must show the tailnet address, and the loopback shim must show `127.0.0.1`:

```bash
ss -ltn | grep -E ':(3773|3775)\b'
# LISTEN  0  511   100.64.0.10:3773   0.0.0.0:*
# LISTEN  0  128   127.0.0.1:3773     0.0.0.0:*
# LISTEN  0  128   100.64.0.10:3775   0.0.0.0:*
```

Summarize every listener by interface, to catch something bound wider than intended (I get a count per class and read the odd ones out):

```bash
ss -ltn | awk 'NR>1{print $4}' \
  | sed -E 's/^100\.[0-9.]+/TAILNET/; s/^127\.0\.0\.1/LOOPBACK/; s/^0\.0\.0\.0/ALL/' \
  | cut -d: -f1 | sort | uniq -c
# few listeners on ALL (the gateway is one), many on LOOPBACK, a handful on TAILNET
```

`tailscale serve` frontends and the funnel state. Every entry must say "tailnet only", and there must be no "Funnel on" line:

```bash
tailscale serve status
# https://<node-fqdn>:<https-port> (tailnet only)
# |-- / proxy http://127.0.0.1:<service-port>
#   ... one block per published service ...
tailscale funnel status | grep -ci 'funnel on'
# 0
```

Tunnel health through the loopback metrics endpoint. `readyConnections` is the number of live connections to Cloudflare's edge:

```bash
curl -s -m3 127.0.0.1:<unique-metrics-port>/ready
# {"status":200,"readyConnections":4,"connectorId":"<uuid>"}
```

Token file permissions, without printing contents:

```bash
stat -c '%a %U' ~/.config/<service>/<tunnel-token-file>
# 600 <service-user>
```

The last check is the pattern for an off-network machine. I did not run it against a real hostname for this guide, so treat the expected codes as what a correctly authenticated origin should return, not as captured output:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.example.com/mcp
# expect 401 or 403 without credentials
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" https://mcp.example.com/mcp
# expect the MCP endpoint's normal response
```

## Gotchas

1. **A loopback-only dev server fails in the T3 preview browser.** The T3 server binds the tailnet address, and its browser target resolver rewrites explicit loopback URLs (`localhost:<port>`, `http://127.0.0.1:<port>/`) to that host. A dev server that listens only on `127.0.0.1` then fails to load, while the navigate call still reports success with a plausible URL and title. **Fix:** bind dev servers to `0.0.0.0`, and verify with a script evaluation of `location.href` after navigation, not with the navigate call's return value.
2. **The OpenClaw gateway `tailnet` bind drops loopback.** It listens on the tailnet address only, so every `127.0.0.1` caller on the host (cron scripts, smoke checks, local CLI calls) stops working. **Fix:** keep the `lan` bind, rely on token auth plus rate limiting, and use a `tailscale serve` frontend for remote TLS. Note `exemptLoopback: true` in the rate limiter, so local callers are never locked out by a bad remote client.
3. **An SSH forward can look alive and be dead.** Without `ExitOnForwardFailure`, an `-L` forward that fails to bind leaves the ssh session open with no forward. **Fix:** pass `-o ExitOnForwardFailure=yes` so the process exits and systemd restarts it, and check with `ss`, not with `is-active`.
4. **The tailnet address is looked up at service start.** Units that call `tailscale ip -4` in `ExecStart` have no address to bind if `tailscaled` is not up yet. **Fix:** `After=tailscaled.service` on the T3 unit, `Restart=on-failure` on all of them, and a script guard that exits with a message when the address is empty (step 3).
5. **A tunnel token is a credential, and the process list is readable by local users.** `--token <value>` shows up in `ps`. **Fix:** `--token-file` with mode `0600`, plus `UMask=0077` in the unit so files cloudflared writes are private too. Rotate by replacing the file contents and restarting the unit. Do not paste tokens in chat or commit history.
6. **Tunnel auth and origin auth are different secrets.** The tunnel token authorizes a connector to attach to your Cloudflare account. It says nothing about who may call the MCP. **Fix:** a separate bearer token (or Access policy) for callers, stored in a separate env file.
7. **One tunnel hardened, one not.** My tunnel units are not all equally sandboxed. Some carry `ProtectSystem=strict`, `ProtectHome=read-only`, and `NoNewPrivileges`, and at least one is a bare `ExecStart` plus `Restart`. Nothing breaks, so nothing prompts me to fix it. **Fix:** copy the hardened skeleton from step 6 into every tunnel unit and diff them with `systemctl --user cat`.
8. **Unit comments go stale.** One of my origin units still carries a "proposed future bind" comment after the service went live. The live `ss -ltn` output is the authority over any comment. **Fix:** verify with `ss`, then delete the comment.
9. **Funnel and serve look alike.** `tailscale serve` is tailnet-only and `tailscale funnel` is public, and both are one command. **Fix:** make `tailscale funnel status | grep -ci 'funnel on'` (expected `0`) part of a periodic check.

## Templates

No drop-in files under `templates/` for this guide yet. The unit and script skeletons in the Implementation section are the templates. The placeholders to fill are `<tunnel-token-file>`, `<unique-metrics-port>`, `<service>`, `<desktop-tailnet-address>`, `<desktop-ssh-alias>`, and `mcp.example.com`.

- [`templates/security/service.env.example`](../templates/security/service.env.example) - env file skeleton for an origin's bearer token, with the permission and render-variant notes

## Related

- [`openclaw-host-topology.md`](openclaw-host-topology.md) - what runs on the host and how the gateway is wired
- [`homelab-topology.md`](homelab-topology.md) - the hypervisor side, including the Fleet Hub reachable only over the overlay network
- [`desktop-integration.md`](desktop-integration.md) - the Windows desktop as a peer: SSH, shares, remote app control
- [`../security/linux-hardening.md`](../security/linux-hardening.md) - UFW rules scoped to the tailnet interface, SSH listeners
- [`../security/agent-security-hardening.md`](../security/agent-security-hardening.md) - what an agent should be allowed to call once it reaches you
- [`../security/mcp-incident-response.md`](../security/mcp-incident-response.md) - using MCP servers in an incident
- [`../security/secret-management.md`](../security/secret-management.md) - where token files and env files come from
- [Tailscale Serve](https://tailscale.com/kb/1312/serve) and [Funnel](https://tailscale.com/kb/1223/funnel) documentation
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) documentation
- [Brigade](https://github.com/escoffier-labs/brigade) - Fleet Hub and the planned changes above
