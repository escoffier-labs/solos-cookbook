# Security Hardening: Windows + WSL2 Host for OpenClaw

Practical hardening runbook for a Windows machine running OpenClaw inside WSL2. Covers Windows Firewall, RDP/SSH/SMB lockdown, port proxy hygiene, WSL-specific gotchas, and defense-in-depth for a dual-OS setup.

**Tested on:** Windows 11 Pro, WSL2 Ubuntu 24.04, on a Ryzen 9 3900X / 64GB DDR5 desktop and an Intel Core Ultra 9 285 / 64GB DDR5 workstation
**Last updated:** 2026-04-19

---

## Why WSL Needs Its Own Hardening Guide

Running OpenClaw on WSL2 means you have two attack surfaces: Windows and Linux. Most hardening guides cover one or the other. If you only harden WSL and ignore Windows, your RDP is still open to the internet. If you only harden Windows and ignore WSL, your agent's API keys sit in a Linux filesystem with default permissions.

This guide covers both layers.

## Overview of Changes

| Component | What Changed |
|-----------|-------------|
| Windows Firewall | RDP and SSH restricted to LAN subnet, SMB disabled |
| Port Proxies | Stale proxies removed, remaining ones audited |
| WSL Network | Services bound to 0.0.0.0 with firewall controlling access |
| Sleep Prevention | System unattended sleep timeout disabled |
| File Permissions | OpenClaw workspace locked to owner |
| Windows Services | Unnecessary remote access services disabled |

---

## 1. Windows Firewall: RDP and SSH

### The Problem

Default Windows installs often have RDP (3389) and SSH (22) listening on all interfaces. If your machine has a public IP or is on a flat network, anyone can attempt authentication.

### Restrict RDP to LAN Only

Open PowerShell as Administrator:

```powershell
# Remove any existing broad RDP rules
Get-NetFirewallRule -DisplayName "*Remote Desktop*" | Remove-NetFirewallRule

# Create LAN-only RDP rule
New-NetFirewallRule -DisplayName "RDP - LAN Only" `
  -Direction Inbound `
  -LocalPort 3389 `
  -Protocol TCP `
  -Action Allow `
  -RemoteAddress <LAN_SUBNET_CIDR>
```

Replace `<LAN_SUBNET_CIDR>` with your LAN subnet.

### Restrict SSH to LAN Only

```powershell
# Remove existing SSH rules
Get-NetFirewallRule -DisplayName "*SSH*" | Remove-NetFirewallRule

# Create LAN-only SSH rule
New-NetFirewallRule -DisplayName "SSH - LAN Only" `
  -Direction Inbound `
  -LocalPort 22 `
  -Protocol TCP `
  -Action Allow `
  -RemoteAddress <LAN_SUBNET_CIDR>
```

### Disable SMB (If Not Needed)

If you're not using file sharing (using Google Drive, OneDrive, or another cloud sync instead of a NAS), disable SMB entirely:

```powershell
# Disable SMB server
Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force
Set-SmbServerConfiguration -EnableSMB2Protocol $false -Force

# Or block via firewall
New-NetFirewallRule -DisplayName "SMB - Block All" `
  -Direction Inbound `
  -LocalPort 445 `
  -Protocol TCP `
  -Action Block
```

> **Note:** If you use a NAS or local file shares, don't disable SMB. Instead, restrict it to your LAN subnet like the RDP and SSH rules above.

### Verify

```powershell
# List all inbound allow rules
Get-NetFirewallRule -Direction Inbound -Action Allow | 
  Where-Object { $_.Enabled -eq 'True' } |
  Format-Table DisplayName, Profile, Direction -AutoSize

# Check for broad allow rules (should return nothing suspicious)
Get-NetFirewallRule -Direction Inbound -Action Allow |
  Get-NetFirewallAddressFilter |
  Where-Object { $_.RemoteAddress -eq 'Any' }
```

---

## 2. Port Proxy Cleanup

### The Problem

WSL2 uses a NAT network. To access WSL services from other devices on your LAN, you add port proxies via `netsh interface portproxy`. Over time, these accumulate as you spin up and tear down dev servers, leaving stale proxies pointing at nothing.

Every port proxy is a potential entry point. Audit them regularly.

### List All Port Proxies

```powershell
netsh interface portproxy show all
```

### Remove Stale Proxies

For each proxy you no longer need:

```powershell
netsh interface portproxy delete v4tov4 listenport=5189 listenaddress=0.0.0.0
```

### Audit Checklist

For every port proxy, ask:
1. **Is the WSL service still running?** If not, delete the proxy.
2. **Does it need to be on 0.0.0.0?** If only you access it, bind to your LAN IP.
3. **Is there a matching firewall rule?** A proxy without a firewall rule is still blocked (good). A proxy with a broad firewall rule is open (bad).

### Create Firewall Rules for Remaining Proxies

Each legitimate port proxy needs a corresponding firewall rule restricted to your LAN:

```powershell
# Example: OpenClaw gateway on port 18789
New-NetFirewallRule -DisplayName "OpenClaw Gateway - LAN Only" `
  -Direction Inbound `
  -LocalPort 18789 `
  -Protocol TCP `
  -Action Allow `
  -RemoteAddress <LAN_SUBNET_CIDR>

# Example: Dev servers on 5173-5214
New-NetFirewallRule -DisplayName "Dev Servers - LAN Only" `
  -Direction Inbound `
  -LocalPort 5173-5214 `
  -Protocol TCP `
  -Action Allow `
  -RemoteAddress <LAN_SUBNET_CIDR>
```

> **Gotcha:** Every new service you add needs BOTH a port proxy AND a firewall rule. Miss either one and it either won't work (no proxy) or will be accessible but blocked (no firewall rule). This is the most common mistake in WSL networking.

---

## 3. WSL-Side Hardening

### File Permissions

Your OpenClaw workspace contains API keys, memory files, and config. Lock it down:

```bash
chmod 700 ~/.openclaw
chmod 600 ~/.openclaw/openclaw.json
chmod -R 700 ~/.openclaw/workspace
```

### WSL Audit

Check for unauthorized access or unexpected services:

```bash
# Who's logged in?
who

# Any unexpected SSH keys?
ls -la ~/.ssh/

# What's listening?
ss -tlnp

# Any unexpected outbound connections?
ss -tnp | grep ESTABLISHED

# Check for unexpected cron jobs
crontab -l
ls /etc/cron.d/
```

All outbound connections should be explainable: your AI provider's API, your messaging platform's API, and the WSL gateway. Anything else warrants investigation.

### Service Binding

Any service running inside WSL that needs to be accessible from other devices must bind to `0.0.0.0` (not `127.0.0.1`). But this means they're also accessible from the Windows host. Access control happens at the Windows Firewall layer.

For dev servers (Vite, Next.js, etc.):

```bash
# Vite
vite --host

# Next.js
next dev -H 0.0.0.0

# FastAPI/Uvicorn
uvicorn main:app --host 0.0.0.0 --port 5200

# Express
# Set BIND_HOST=0.0.0.0 or app.listen(port, '0.0.0.0')
```

For services that should stay local (Ollama, databases):

```bash
# Ollama default is already 127.0.0.1 - don't change it
# PostgreSQL - bind to 127.0.0.1 in postgresql.conf
# Redis - bind to 127.0.0.1 in redis.conf
```

---

## 4. Windows Sleep Prevention

### The Problem

Windows has a hidden "System Unattended Sleep Timeout" that's separate from your normal power settings. Even with sleep disabled in Settings and PowerToys Awake running, your machine will still sleep after this hidden timeout expires. When it does, your agent goes offline.

### The Fix

PowerShell as Administrator:

```powershell
# Disable unattended sleep timeout (the hidden one)
powercfg /SETACTIVETIMEOUT 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP UNATTENDSLEEP 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP UNATTENDSLEEP 0
powercfg /S SCHEME_CURRENT

# Disable hibernate
powercfg /hibernate off

# Disable regular sleep too
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
```

> **Note:** PowerToys Awake is NOT sufficient. It does not override the system unattended sleep timeout. You must set these power config values directly.

### Verify

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP
```

Look for `UNATTENDSLEEP` set to `0x00000000`.

---

## 5. VPN and DNS Sinkholing Compatibility

### The Problem

If you run Mullvad, Pi-hole, AdGuard, or any DNS sinkholing setup, certain AI tools will break. Claude Code specifically hangs indefinitely trying to reach `statsig.anthropic.com` (telemetry). If your DNS resolver returns `0.0.0.0` for that domain, Claude Code never gets past its startup check.

### The Fix

Add to `~/.claude/settings.json` inside WSL:

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

This disables non-essential telemetry calls, making Claude Code work regardless of your DNS configuration.

---

## 6. OpenClaw Tool Permissions

### Review Your Config

OpenClaw's tool permissions control what your agent can do. The defaults are permissive. Tighten them based on your needs:

```json
{
  "tools": {
    "exec": {
      "security": "allowlist",
      "allowlist": ["git", "npm", "node", "python3", "curl"]
    },
    "elevated": {
      "enabled": false
    }
  }
}
```

Key decisions:
- **exec.security**: `full` lets your agent run anything. `allowlist` restricts to specific commands. Start with `allowlist` and add commands as needed.
- **elevated.enabled**: Controls `sudo` access. Disable unless your agent specifically needs it (rare).

---

## Full Verification Checklist

### Windows Side (PowerShell as Admin)

```powershell
Write-Host "=== Firewall Rules ==="
Get-NetFirewallRule -Direction Inbound -Action Allow |
  Where-Object { $_.Enabled -eq 'True' } |
  Format-Table DisplayName -AutoSize

Write-Host "`n=== Port Proxies ==="
netsh interface portproxy show all

Write-Host "`n=== Sleep Config ==="
powercfg /query SCHEME_CURRENT SUB_SLEEP UNATTENDSLEEP

Write-Host "`n=== SMB Status ==="
Get-SmbServerConfiguration | Select-Object EnableSMB1Protocol, EnableSMB2Protocol
```

### WSL Side

```bash
echo "=== Listening Services ==="
ss -tlnp

echo ""
echo "=== Outbound Connections ==="
ss -tnp | grep ESTABLISHED

echo ""
echo "=== File Permissions ==="
ls -la ~/.openclaw/

echo ""
echo "=== SSH Keys ==="
ls -la ~/.ssh/

echo ""
echo "=== Cron Jobs ==="
crontab -l 2>/dev/null || echo "No crontab"
```

---

## What This Doesn't Cover

- **BitLocker disk encryption** (enable it if you haven't)
- **Windows Defender configuration** (review exclusions for WSL paths)
- **Windows Update policies** (keep auto-updates on for security patches)
- **Network segmentation** (VLANs for isolating your dev machine)
- **Cloudflare Zero Trust / Tailscale** (for secure remote access without port exposure)
- **Backup and disaster recovery** (encrypted backups of your OpenClaw workspace)

See the [Linux hardening guide](linux-hardening.md) for additional patterns that apply to the WSL side (fail2ban, SSH config, UFW inside WSL).

---

## Implementation Notes

1. **Two layers, two audits.** WSL hardening is incomplete without Windows hardening. Audit both. A locked-down WSL instance behind a wide-open Windows Firewall is theater.

2. **Port proxies accumulate.** Make it a habit to run `netsh interface portproxy show all` monthly and remove anything stale. We found 14 stale proxies from archived projects during our first audit.

3. **The sleep timeout is invisible.** It doesn't show up in the normal Windows Settings UI. You have to use `powercfg` to find and disable it. This is the number one cause of "my agent went offline overnight" on Windows setups.

4. **Firewall profile matters.** Make sure your network is set to "Private" in Windows Settings. Public profile rules are more restrictive and can block WSL traffic unexpectedly.

5. **Test from another device.** After applying firewall changes, test access from your phone or another machine on the network. Verify that allowed services work and everything else is blocked.

6. **Windows machines running their own Claude Code need the same cross-machine rules.** If you run a separate Claude Code instance on a Windows desktop, mirror the cross-machine guardrails into `C:\Users\<you>\.claude\CLAUDE.md`. Otherwise the two instances drift on safety rules and the Windows one won't know about the "never push to main" and "always check PR state first" conventions you enforce on your Linux host.
