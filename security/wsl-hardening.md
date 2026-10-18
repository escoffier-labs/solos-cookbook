# Security Hardening: Windows Host for OpenClaw (Native Node, Optional WSL)

Practical hardening runbook for a Windows 11 machine that takes part in an OpenClaw setup. Covers Windows Firewall, RDP/SSH/SMB lockdown, the native node and its credentials, sleep prevention, and what changes if you also keep WSL2 around.

**Tested on:** Windows 11 Pro (Ryzen 9 desktop, 64GB) running a native OpenClaw node and native Brigade workers, WSL2 Ubuntu 24.04 installed but stopped. Earlier sections were written when the same machine ran the agent inside WSL2.
**Last updated:** 2026-10-17

---

## Why This Guide Changed Shape

The first version of this guide assumed the agent lived inside WSL2: two attack surfaces, Windows and Linux, with port proxies bridging them. That is no longer how I run the machine. The Windows desktop is now a **native execution host**. An OpenClaw node runs as a Windows Scheduled Task and dials out to the gateway on my Linux control host. Brigade workers, Codex, Claude Code, and the other harnesses run as native Windows processes. WSL2 Ubuntu is still installed, capped at 2 GiB of RAM with no swap, and stopped. Nothing needs it for ordinary work.

That changes the hardening list:

- The agent's API keys and workspace are on the **Windows filesystem**, so Windows ACLs and Windows credential storage matter most.
- The node connects **outbound** to the gateway. It does not need an inbound rule for the gateway port, and it does not need port proxies.
- Port proxies, WSL file permissions, and WSL service binding only matter if you still run services in WSL. Those sections are now optional (section 6).

If you do run your agent inside WSL2, keep section 6 and the port-proxy cleanup in section 2 as your main path. The Windows-side firewall rules apply either way.

## Overview of Changes

| Component | What Changed |
|-----------|-------------|
| Windows Firewall | RDP and SSH restricted to the LAN subnet. SMB restricted or disabled |
| OpenSSH server | Key-only, with the administrators-group key file gotcha understood |
| Native node | Runs as a Scheduled Task, outbound only, version kept in step with the gateway |
| Credentials | Machine-bound credential storage instead of plaintext files |
| Port Proxies | None needed natively. Audit them if you run WSL services |
| Sleep Prevention | System unattended sleep timeout disabled |
| WSL (optional) | Capped, stopped unless used, services bound deliberately |

---

## 1. Windows Firewall: RDP, SSH, SMB

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

### SMB: Disable It or Scope It

If you do not use file sharing, disable SMB entirely:

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

> **Note:** My desktop shares media over SMB, so port 445 is listening on it. If you use a NAS or local file shares, do not disable SMB. Restrict it to your LAN subnet like the RDP and SSH rules above, and keep SMB1 off.

### The gateway port needs no inbound rule here

The OpenClaw gateway runs on the Linux control host, and the Windows node dials out to it. If you copied a "gateway LAN-only" rule onto the Windows machine from an older version of this guide, it is opening a port nothing listens on. Remove it unless you run a gateway on this machine.

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

## 2. Port Proxies (Only If You Run WSL Services)

WSL2 uses a NAT network. To reach a WSL service from other devices on your LAN, you add a port proxy with `netsh interface portproxy`. Over time these accumulate as you spin dev servers up and down, leaving stale proxies pointing at nothing. Every port proxy is a potential entry point.

On a native-node machine the list should be empty:

```powershell
netsh interface portproxy show all
```

Expected output on my desktop: nothing at all. If you see entries, audit each one:

1. **Is the WSL service still running?** If not, delete the proxy.
2. **Does it need to listen on 0.0.0.0?** If only you use it, bind to your LAN IP.
3. **Is there a matching, LAN-scoped firewall rule?** A proxy without a firewall rule is still blocked (good). A proxy with a broad firewall rule is open (bad).

Remove a stale one:

```powershell
netsh interface portproxy delete v4tov4 listenport=<port> listenaddress=0.0.0.0
```

Every service you expose from WSL needs BOTH a port proxy AND a firewall rule. Miss either one and it will not work, or it will work but unfiltered. That is the most common mistake in WSL networking.

---

## 3. Windows OpenSSH

The Windows OpenSSH server is how my control host reaches this machine. Keep it key-only and know one gotcha that cost me an evening:

- If the Windows user is in the local **Administrators** group, `sshd` ignores the user's normal `~\.ssh\authorized_keys` and reads `C:\ProgramData\ssh\administrators_authorized_keys` instead, which must be ACL'd to Administrators and SYSTEM only. Promoting a user to admin therefore silently breaks key auth until you move the key.
- The client side matters too. Windows OpenSSH will give up after the server's `MaxAuthTries` if your agent offers several unrelated keys first. Use `IdentitiesOnly yes` and an explicit `IdentityFile` in the client config.
- Unattended Git over an SSH session into this machine can stall even when desktop Git works. Keep GitHub writes on the control host unless you have tested the path unattended.

Verify the service and listeners:

```cmd
sc query sshd | findstr STATE
netstat -an | findstr LISTENING | findstr ":22 "
```

Expected: `STATE : 4 RUNNING` and a listener on port 22.

---

## 4. The Native Node and Its Credentials

### How the node runs

The node is a Windows Scheduled Task that launches `openclaw ... node run`. Two facts to know before you audit it:

- The task can show `Ready` with result `0` while the child process keeps running and stays connected. Do not judge health by the task state alone.
- Local `openclaw node status` can report "stopped" while the node is connected. Verify from the **gateway** with `openclaw nodes status`, then confirm the child process on Windows if you need to.

Never paste raw node status, approval JSON, or service launcher contents into notes or issue reports. They can contain gateway token material.

### Keep the node version in step with the gateway

Build or stage the exact OpenClaw package on the control host, copy the tarball to the node, install it with `npm.cmd install -g <tarball>`, then run `openclaw node install --force` and `openclaw node restart`. Do not install `openclaw@latest` independently. A node can connect while publishing stale or empty capabilities, so after every upgrade check from the gateway and invoke `system.which` for `powershell`, `node`, `npm`, and `git`.

### Credentials on Windows

The Linux-side pattern in [`secret-management.md`](secret-management.md) (service account to a rendered env file in tmpfs) has a Windows counterpart with different storage:

- Use a **read-only service account** for the runtime vault, and keep its token sealed with **DPAPI** (user-bound) rather than in a plaintext file or an environment variable in the registry.
- DPAPI has two incompatible on-disk forms: the text written by `ConvertFrom-SecureString` and raw `ProtectedData` bytes. Mixing them gives a misleading "input string was not in a correct format" error.
- Render or inject only the values a task needs. Do not hand the final application the service-account token.
- Keep the config directory private to your user:

```powershell
icacls "$env:USERPROFILE\.openclaw" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
```

Check the result with `icacls "$env:USERPROFILE\.openclaw"`. It should list only your user (and, if you choose to keep them, SYSTEM and Administrators).

---

## 5. Windows Sleep Prevention

### The Problem

Windows has a hidden "System Unattended Sleep Timeout" that is separate from your normal power settings. Even with sleep disabled in Settings and PowerToys Awake running, the machine can still sleep after this hidden timeout expires. When it does, the node and any workers go offline.

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

> **Note:** PowerToys Awake is NOT sufficient. It does not override the system unattended sleep timeout. Set these power config values directly.

### Verify

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP
```

Look for `UNATTENDSLEEP` set to `0x00000000`.

---

## 6. If You Also Keep WSL2

WSL is optional on this machine and I keep it stopped. If you run services in it, harden it like any Linux host (see [`linux-hardening.md`](linux-hardening.md)) plus the points below.

### Contain it

Cap its resources in `%USERPROFILE%\.wslconfig` so a runaway process cannot eat the host (mine is capped at 2 GiB of RAM with no swap):

```ini
[wsl2]
memory=2GB
swap=0
```

Check whether it is running before you do anything that restarts it, since `wsl --shutdown` kills every distro and any workload in it:

```powershell
wsl -l -v
```

Expected on my desktop: the Ubuntu distro with state `Stopped`.

### File permissions inside WSL

```bash
chmod 700 ~/.openclaw
chmod 600 ~/.openclaw/openclaw.json
chmod -R 700 ~/.openclaw/workspace
```

### Audit inside WSL

```bash
who                         # who is logged in
ls -la ~/.ssh/              # any unexpected keys
ss -tlnp                    # what is listening
ss -tnp | grep ESTABLISHED  # any unexpected outbound connections
crontab -l; ls /etc/cron.d/ # unexpected scheduled jobs
```

All outbound connections should be explainable: your AI provider's API, your messaging platform's API, and the gateway. Anything else warrants investigation.

### Service binding

A WSL service that must be reachable from other devices has to bind to `0.0.0.0` (not `127.0.0.1`), which also makes it reachable from the Windows host. Access control then happens at the Windows Firewall layer, with a matching port proxy (section 2). Keep services that should stay local (databases, Ollama) on `127.0.0.1`.

### DNS sinkholes and Claude Code in WSL

If you run Mullvad, Pi-hole, AdGuard, or another DNS sinkhole, an older Claude Code build hung at startup when telemetry hosts resolved to `0.0.0.0`. Setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to `1` in the `env` block of `~/.claude/settings.json` was the workaround. I found this on a 2026 spring build and have not re-tested it on 2.1.302, so treat it as a fallback if you see a startup hang.

---

## 7. Tool Permissions

The agent's exec and elevation settings are covered in [`agent-security-hardening.md`](agent-security-hardening.md). On a native Windows node, also check which commands the gateway is allowed to run on the node: node commands run as the node's Windows user, so treat that user's file access as the agent's file access. Run the node under a standard (non-administrator) account if your workloads allow it.

---

## Verification

### Windows Side (PowerShell as Admin)

```powershell
Write-Host "=== Firewall Rules ==="
Get-NetFirewallRule -Direction Inbound -Action Allow |
  Where-Object { $_.Enabled -eq 'True' } |
  Format-Table DisplayName -AutoSize

Write-Host "`n=== Port Proxies ==="
netsh interface portproxy show all

Write-Host "`n=== Listeners (22, 445, 3389) ==="
netstat -an | findstr LISTENING | findstr ":22 :445 :3389"

Write-Host "`n=== Sleep Config ==="
powercfg /query SCHEME_CURRENT SUB_SLEEP UNATTENDSLEEP

Write-Host "`n=== SMB Status ==="
Get-SmbServerConfiguration | Select-Object EnableSMB1Protocol, EnableSMB2Protocol

Write-Host "`n=== WSL ==="
wsl -l -v
```

Expected: no broad (`Any` remote address) allow rules for 22, 3389, or 445, an empty port-proxy list, `EnableSMB1Protocol` false, `UNATTENDSLEEP` at `0x00000000`, and WSL either absent or `Stopped`.

### From the gateway

```bash
openclaw nodes status
```

Expected: the Windows node listed as connected. Filter the output and do not paste it anywhere, because raw node status can include token material.

---

## What This Doesn't Cover

- **BitLocker disk encryption** (enable it if you have not)
- **Windows Defender configuration** (review exclusions for any agent working directories)
- **Windows Update policies** (keep auto-updates on for security patches)
- **Network segmentation** (VLANs for isolating a dev machine)
- **Cloudflare Zero Trust / Tailscale** (for secure remote access without port exposure)
- **Backup and disaster recovery** (encrypted backups of the OpenClaw workspace)

See the [Linux hardening guide](linux-hardening.md) for patterns that apply to the Linux side (fail2ban, SSH config, UFW), and [`wazuh-triage.md`](wazuh-triage.md) for putting a Windows agent into your SIEM.

---

## Gotchas

1. **Two surfaces only if you use both.** A native-node Windows machine has one main surface, Windows. A WSL-based setup has two. Audit the ones you actually run, and stop an unused WSL distro rather than leaving it up.

2. **Port proxies accumulate.** On my first audit of the WSL-era setup I found 14 stale proxies from archived projects. Run `netsh interface portproxy show all` monthly, even if you think you have none.

3. **The sleep timeout is invisible.** It does not show up in the normal Windows Settings UI. Use `powercfg` to find and disable it. This is the most common cause of "my agent went offline overnight" on Windows.

4. **Firewall profile matters.** Make sure your network is set to "Private". Public profile rules are more restrictive and can block expected traffic unexpectedly.

5. **Test from another device.** After applying firewall changes, test access from another machine on the network. Verify that allowed services work and everything else is blocked.

6. **Admin group membership breaks SSH keys.** Promoting a Windows user to local Administrators makes `sshd` read the shared administrators key file instead of the user's own, and key auth fails until you move the key there.

7. **A `Ready` Scheduled Task is not a healthy node.** The task can return to `Ready` with exit code 0 while the child runs, and local node status can say "stopped" for a connected node. Check from the gateway.

8. **Windows machines running their own Claude Code need the same cross-machine rules.** If you run a separate Claude Code instance on the Windows desktop, mirror the cross-machine guardrails into `C:\Users\<you>\.claude\CLAUDE.md`. Otherwise the two instances drift on safety rules.

9. **Keep node versions in lockstep with the gateway.** Install the exact tarball built on the control host, then verify capabilities from the gateway. A connected node with stale capabilities is easy to miss.
