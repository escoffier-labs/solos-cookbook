# Security Hardening: Linux Host for OpenClaw

Practical hardening runbook for an Ubuntu 24.04 machine running OpenClaw as an always-on AI agent. This covers firewall configuration, SSH lockdown, fail2ban, and service binding to reduce attack surface.

**Tested on:** Ubuntu 24.04.5 LTS (bare metal, kernel 6.17 OEM), OpenSSH from the 24.04 archive, UFW, fail2ban, auditd, Wazuh agent 4.14.x
**Last updated:** 2026-10-17

---

## Why This Matters

An OpenClaw host is a high-value target. It has API keys for AI providers, access to your messaging platforms, and potentially SSH access to other machines. Default Linux configurations are permissive. This guide reduces the attack surface to what's actually needed.

## Overview of Changes

| Component | What Changed |
|-----------|-------------|
| UFW | Enabled with default deny incoming, explicit allow rules for required services |
| SSH | Bound to the LAN address (plus one tailnet listener for peer controllers), password auth disabled, root login disabled |
| fail2ban | Installed with an sshd jail (3 attempts, 2-hour ban) |
| xrdp | Bound to LAN IP only (if remote desktop is used) |
| Ollama | Defense-in-depth deny rule (already localhost-bound) |
| OpenClaw Gateway | UFW-restricted to LAN sources |
| Detection and patching | auditd, unattended-upgrades, and a Wazuh agent (see section 7) |

---

## 1. UFW Firewall

### Install and Enable

```bash
sudo apt install ufw -y
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

### Rule Set

Replace `<LAN_SUBNET_CIDR>` with your LAN subnet. Replace `<HOST_LAN_IP>` with your host's LAN IP.

```bash
# SSH - LAN only (subnet form, simplest)
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 22 proto tcp

# SSH - per-host form (what I run): one rule per trusted client, with a comment
sudo ufw allow from 192.0.2.20 to any port 22 proto tcp comment 'SSH trusted client'
sudo ufw allow from 192.0.2.21 to any port 22 proto tcp comment 'SSH automation host'

# Web traffic (if running any web services publicly)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Dev server ports - LAN only
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 5173:5214 proto tcp

# Ops Deck API - LAN only
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 8005 proto tcp

# OpenClaw Gateway - LAN only
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 18789 proto tcp

# Ollama - deny from everywhere (defense-in-depth, already localhost-bound)
sudo ufw deny 11434

# Tailnet-only listener (see section 2): allowed on the tailnet interface only
sudo ufw allow in on tailscale0 to any port <tailnet-ssh-port> proto tcp comment 'peer-controller sshd, tailnet only'

# mDNS - LAN only
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 5353 proto udp
```

### Verify

```bash
sudo ufw status verbose
```

Expected output should show `Status: active`, `Default: deny (incoming)`, and your explicit allow/deny rules.

The rule set grows. Mine is about 40 rules now, mostly one-per-host allows for SSH, the gateway, remote desktop, device-sync tools, and a few dev-server ports, each with a `comment` naming the reason. Add the comment when you add the rule. A rule list with no reasons cannot be audited six months later.

---

## 2. SSH Hardening

### The Problem

Default Ubuntu SSH configuration:
- Listens on `0.0.0.0:22` and `[::]:22` (all interfaces)
- Password authentication enabled
- Root login permitted
- 6 max authentication tries (the OpenSSH default)

### The Fix

Create a drop-in config (cleaner than editing the main `sshd_config`, easier to audit and roll back):

```bash
sudo tee /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
# Host hardening: key-only, LAN-bound
ListenAddress <HOST_LAN_IP>
PasswordAuthentication no
PermitRootLogin no
MaxAuthTries 6
UseDNS no
EOF
```

`MaxAuthTries` is 6 on my host, which is also the OpenSSH default. The first version of this guide set it to 3. It buys little once password auth is off, because a client that offers several keys from an agent can burn through three attempts before the right key is tried (Windows OpenSSH hit exactly this against a `MaxAuthTries 3` server until I set `IdentitiesOnly yes` on the client). Set it to 3 if your clients are tidy, but check what the server really enforces, not what the drop-in file says:

```bash
sudo -n sshd -T 2>/dev/null | grep -E '^(maxauthtries|passwordauthentication|permitrootlogin|listenaddress)'
```

`sshd -T` without root returns only the public settings and omits `listenaddress` and `maxauthtries`. If you cannot use sudo, read the drop-ins directly:

```bash
grep -hv '^#' /etc/ssh/sshd_config.d/*.conf | grep -v '^$'
```

### A second listener on the tailnet

I run a second listener bound only to the tailnet address on a second, non-default port. A peer-controller tool uses it so peer machines can start controller sessions without going through the LAN. The matching UFW rule is scoped to the `tailscale0` interface (above), so the port is not reachable from the LAN even though sshd would accept it. The listener is key-only like port 22, because both share `sshd_config`.

On Ubuntu 24.04 the listener is defined by the socket unit, not by `ListenAddress` (see the socket-activation gotcha below). If you add a listener like this, check it with `ss -tlnp | grep <tailnet-ssh-port>` and confirm UFW has no rule for it on the LAN interface.

### Ubuntu 24.04 Gotcha: Socket Activation

Ubuntu 24.04 uses systemd socket activation for SSH. This means `ListenAddress` in `sshd_config` is **ignored** when `ssh.socket` is active. You need a socket override:

```bash
sudo mkdir -p /etc/systemd/system/ssh.socket.d
sudo tee /etc/systemd/system/ssh.socket.d/override.conf << 'EOF'
[Socket]
# Clear default ListenStream (0.0.0.0:22 and [::]:22)
ListenStream=
# Bind to LAN IP only
ListenStream=<HOST_LAN_IP>:22
# Second listener on the tailnet address (omit if you have none)
ListenStream=[<tailnet-address>]:<tailnet-ssh-port>
EOF

sudo systemctl daemon-reload
sudo systemctl restart ssh.socket
```

> **Note:** The empty `ListenStream=` line is required. It clears the default listen addresses before setting the new ones. Without it, your custom addresses get *added* to the defaults instead of replacing them. The clear also drops every other listener, including a tailnet one that the generated `ssh.socket.d/addresses.conf` would have added, so the override must list every endpoint you want, not only the LAN address. Check the merged result with `systemctl cat ssh.socket`.

### Verify

```bash
# Check listening addresses (both endpoints if you run a tailnet listener)
ss -tlnp | grep -E ':22\b|:<tailnet-ssh-port>\b'

# Should show only your LAN IP and the tailnet listener, not 0.0.0.0 or [::]
# Expected: <HOST_LAN_IP>:22 and [<tailnet-address>]:<tailnet-ssh-port>

# Check config values
sudo -n sshd -T | grep -E "passwordauthentication|permitrootlogin|maxauthtries"

# Expected:
# passwordauthentication no
# permitrootlogin no
# maxauthtries 6
```

---

## 3. fail2ban

### Install and Configure

```bash
sudo apt install fail2ban -y
```

Create a local jail config (never edit `jail.conf` directly, it gets overwritten on updates):

```bash
sudo tee /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 3
bantime = 7200
findtime = 600
EOF

sudo systemctl enable fail2ban
sudo systemctl restart fail2ban
```

This gives you:
- **3 failed attempts** within a 10-minute window triggers a ban
- **2-hour ban** per offense
- Covers both password and key auth failures

On Ubuntu 24.04 the `sshd` filter reads the journal. A `backend = systemd` line in a `[DEFAULT]` block of `jail.local` keeps it consistent across jails.

### Verify

```bash
sudo fail2ban-client status sshd
```

Expected: `Status for the jail: sshd` with `Currently banned: 0` (on a fresh setup).

---

## 4. xrdp (Remote Desktop)

If you run xrdp for remote desktop access, bind it to your LAN IP instead of all interfaces.

### The Fix

Edit `/etc/xrdp/xrdp.ini`, find the `port=` line (typically line 23):

```ini
# Before
port=3389

# After
port=tcp://<HOST_LAN_IP>:3389
```

> **Note:** xrdp uses `port=tcp://host:port` syntax, not `address=` as some documentation suggests. This is a common gotcha.

```bash
sudo systemctl restart xrdp
```

### Verify

```bash
ss -tlnp | grep :3389

# Should show <HOST_LAN_IP>:3389, not 0.0.0.0:3389
```

---

## 5. OpenClaw Gateway

The OpenClaw gateway (default port 18789) binds to `0.0.0.0` on my host with `bind: "lan"` and token auth. Its `tailnet` bind mode listens on the tailnet address only and drops loopback, which would break local CLI calls and scripts that talk to `127.0.0.1`, so I kept `lan` and protect the port at the firewall level:

```bash
# Already covered by the UFW rules above
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 18789 proto tcp
```

This keeps the gateway accessible from your LAN but blocks external access.

---

## 6. Ollama (Defense-in-Depth)

Ollama binds to `127.0.0.1:11434` by default, which is already correct. The UFW deny rule is defense-in-depth in case the binding ever changes:

```bash
sudo ufw deny 11434
```

This costs nothing and protects against configuration drift.

---

## Verification

Run this after applying all changes to confirm everything is locked down:

```bash
#!/bin/bash
echo "=== SSH Binding ==="
ss -tlnp | grep :22

echo ""
echo "=== xrdp Binding ==="
ss -tlnp | grep :3389

echo ""
echo "=== SSH Config ==="
sudo -n sshd -T 2>/dev/null | grep -E "passwordauthentication|permitrootlogin|maxauthtries"

echo ""
echo "=== UFW Status ==="
sudo ufw status | head -20

echo ""
echo ""
echo "=== fail2ban Status ==="
sudo fail2ban-client status sshd 2>/dev/null || echo "fail2ban not running"

echo ""
echo "=== Patching, audit, detection ==="
systemctl is-active unattended-upgrades auditd wazuh-agent
```

Expected output:

```
SSH: <HOST_LAN_IP>:22 only
xrdp: <HOST_LAN_IP>:3389 only
sshd: PasswordAuthentication no, PermitRootLogin no, MaxAuthTries 6
UFW: active, default deny incoming
fail2ban: sshd jail active, 0 banned
unattended-upgrades, auditd, wazuh-agent: active x3
```

---

## 7. Patching, audit, and detection

Three things the original version of this guide listed as "next steps" are now on the host. Check each one rather than assuming:

| Control | What I run | Check |
|---------|-----------|-------|
| Automatic security updates | `unattended-upgrades` with the default Ubuntu security origins (main, ESM apps, ESM infra) and `APT::Periodic::Unattended-Upgrade "1"` | `cat /etc/apt/apt.conf.d/20auto-upgrades` |
| Audit logging | `auditd` active, with `-w <path> -p wa -k <key>` watch rules under `/etc/audit/rules.d/` | `sudo auditctl -s` and `sudo auditctl -l` |
| Intrusion detection | A Wazuh agent reporting to a central manager | `systemctl is-active wazuh-agent` |

The audit rule set is small: a handful of write-watches on files an agent should not touch quietly. Start with the paths that matter to you (your secrets directory, SSH config, systemd user units) and keep the key names greppable. The agent version rules are in [`wazuh-triage.md`](wazuh-triage.md): the agent must never be newer than the manager, so I hold the `wazuh-agent` package with `apt-mark hold`.

## What This Doesn't Cover

- **Kernel hardening** (sysctl parameters, AppArmor profiles)
- **Network segmentation** (VLANs, separate management interfaces)
- **Disk encryption and boot-chain integrity** (the sealed-credential trade-offs are in [`secret-management.md`](secret-management.md))

These are good next steps depending on your threat model. This guide focuses on the fundamentals that every OpenClaw host should have on day one.

---

## Gotchas

1. **Drop-in configs over main configs.** Using `/etc/ssh/sshd_config.d/hardening.conf` instead of editing `/etc/ssh/sshd_config` makes auditing and rollback trivial. You can `ls` the `.d` directory and see exactly what changed and when.

2. **Socket activation is the future.** Ubuntu 24.04's move to `ssh.socket` activation catches a lot of people off guard. The `ListenAddress` directive in `sshd_config` does nothing when the socket unit is active. Always check `systemctl status ssh.socket` first.

3. **Defense-in-depth is cheap.** The Ollama deny rule costs nothing and protects against drift. Apply this pattern to any service that should stay localhost-only.

4. **Test from another machine.** After applying SSH changes, keep your current session open and test a new connection from a different machine. If you lock yourself out, the existing session still works.

5. **OpenClaw upgrades regenerate the systemd unit.** Upgrades rewrite `~/.config/systemd/user/openclaw-gateway.service` and drop custom directives, most painfully `EnvironmentFile=`. Without it, secrets do not load and the gateway crash-loops. I now promote releases through a script that manages a version drop-in, and the gateway gets its secrets from a rendered tmpfs file (see [`secret-management.md`](secret-management.md)) with the `EnvironmentFile=` line re-asserted in a drop-in rather than the main unit. After any upgrade, check `systemctl --user cat openclaw-gateway.service | grep EnvironmentFile`. The upgrade procedure is in [`../infrastructure/upgrade-hygiene.md`](../infrastructure/upgrade-hygiene.md).

6. **The drop-in file is not the effective config.** I found a stale `MaxAuthTries 3` in this guide while the live server enforced 6. Read the effective values with `sshd -T`, and keep dated backups of drop-ins (`hardening.conf.bak-<date>`) so a change is diffable.

7. **A new listener needs a firewall rule you can name.** The tailnet listener above is safe because its UFW rule is bound to the `tailscale0` interface. A bare `ufw allow <port>/tcp` would have opened it to the LAN too.
