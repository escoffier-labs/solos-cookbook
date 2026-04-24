# Security Hardening: Linux Host for OpenClaw

Practical hardening runbook for an Ubuntu 24.04 machine running OpenClaw as an always-on AI agent. This covers firewall configuration, SSH lockdown, fail2ban, and service binding to reduce attack surface.

**Tested on:** Ubuntu 24.04 LTS (bare metal, Intel Ultra 250, 64GB DDR5)
**Last updated:** 2026-04-19

---

## Why This Matters

An OpenClaw host is a high-value target. It has API keys for AI providers, access to your messaging platforms, and potentially SSH access to other machines. Default Linux configurations are permissive. This guide reduces the attack surface to what's actually needed.

## Overview of Changes

| Component | What Changed |
|-----------|-------------|
| UFW | Enabled with default deny incoming, explicit allow rules for required services |
| SSH | Bound to LAN only, password auth disabled, root login disabled, max auth tries reduced |
| fail2ban | Installed with aggressive sshd jail (3 attempts, 2-hour ban) |
| xrdp | Bound to LAN IP only (if remote desktop is used) |
| Ollama | Defense-in-depth deny rule (already localhost-bound) |
| OpenClaw Gateway | UFW-restricted to LAN subnet |

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
# SSH - LAN only
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 22 proto tcp

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

# mDNS - LAN only
sudo ufw allow from <LAN_SUBNET_CIDR> to any port 5353 proto udp
```

### Verify

```bash
sudo ufw status verbose
```

Expected output should show `Status: active`, `Default: deny (incoming)`, and your explicit allow/deny rules.

---

## 2. SSH Hardening

### The Problem

Default Ubuntu SSH configuration:
- Listens on `0.0.0.0:22` and `[::]:22` (all interfaces)
- Password authentication enabled
- Root login permitted
- 6 max authentication tries

### The Fix

Create a drop-in config (cleaner than editing the main `sshd_config`, easier to audit and roll back):

```bash
sudo tee /etc/ssh/sshd_config.d/hardening.conf << 'EOF'
# OpenClaw host hardening - 2026-03-11
PasswordAuthentication no
PermitRootLogin no
MaxAuthTries 3
EOF
```

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
EOF

sudo systemctl daemon-reload
sudo systemctl restart ssh.socket
```

> **Note:** The empty `ListenStream=` line is required. It clears the default listen addresses before setting the new one. Without it, your custom address gets *added* to the defaults instead of replacing them.

### Verify

```bash
# Check listening address
ss -tlnp | grep :22

# Should show only your LAN IP, not 0.0.0.0 or [::]
# Expected: <HOST_LAN_IP>:22

# Check config values
sudo sshd -T | grep -E "passwordauthentication|permitrootlogin|maxauthtries"

# Expected:
# passwordauthentication no
# permitrootlogin no
# maxauthtries 3
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

The OpenClaw gateway (default port 18789) binds to `0.0.0.0` by default. Rather than changing the gateway config, we protect it at the firewall level:

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

## Full Verification Script

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
sudo sshd -T 2>/dev/null | grep -E "passwordauthentication|permitrootlogin|maxauthtries"

echo ""
echo "=== UFW Status ==="
sudo ufw status | head -20

echo ""
echo "=== fail2ban Status ==="
sudo fail2ban-client status sshd 2>/dev/null || echo "fail2ban not running"
```

Expected output:

```
SSH: <HOST_LAN_IP>:22 only
xrdp: <HOST_LAN_IP>:3389 only
sshd: PasswordAuthentication no, PermitRootLogin no, MaxAuthTries 3
UFW: active, default deny incoming
fail2ban: sshd jail active, 0 banned
```

---

## What This Doesn't Cover

- **Automatic security updates** (configure `unattended-upgrades`)
- **Kernel hardening** (sysctl parameters, AppArmor profiles)
- **Audit logging** (auditd rules for sensitive file access)
- **Network segmentation** (VLANs, separate management interfaces)
- **Intrusion detection** (host-based IDS like OSSEC/Wazuh)

These are all good next steps depending on your threat model. This guide focuses on the fundamentals that every OpenClaw host should have on day one.

---

## Implementation Notes

1. **Drop-in configs over main configs.** Using `/etc/ssh/sshd_config.d/hardening.conf` instead of editing `/etc/ssh/sshd_config` makes auditing and rollback trivial. You can `ls` the `.d` directory and see exactly what changed and when.

2. **Socket activation is the future.** Ubuntu 24.04's move to `ssh.socket` activation catches a lot of people off guard. The `ListenAddress` directive in `sshd_config` does nothing when the socket unit is active. Always check `systemctl status ssh.socket` first.

3. **Defense-in-depth is cheap.** The Ollama deny rule costs nothing and protects against drift. Apply this pattern to any service that should stay localhost-only.

4. **Test from another machine.** After applying SSH changes, keep your current session open and test a new connection from a different machine. If you lock yourself out, the existing session still works.

5. **OpenClaw upgrades regenerate the systemd unit.** Every minor upgrade across the 2026.4.x line has silently regenerated `~/.config/systemd/user/openclaw-gateway.service` and dropped custom directives — most painfully `EnvironmentFile=`. Without it, secrets from `~/.openclaw/workspace/.env` don't load and the gateway crash-loops. If you maintain a hardening script, run it after every `openclaw update`, or automate the restore. We use a wrapper script (`~/bin/openclaw-update.sh`) that bumps the version drop-in and re-asserts `EnvironmentFile=` after each upgrade.
