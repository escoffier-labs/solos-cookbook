# Desktop Integration: The Daily Driver as a Peer

Most homelab writeups treat the desktop as a dumb client that connects *to* the server. I run it the other way too. My always-on Linux agent host SSHes *into* the Windows 11 daily driver, mounts its drives, drops files into an inbox folder on it, and remote-controls the apps running on it. The desktop is a peer in the stack, not just a thing I sit at. 🦞

**Tested on:** Ubuntu 24.04 agent host + Windows 11 Pro daily driver (Ryzen 9 3900X, 64GB RAM). OpenSSH Server on Windows, CIFS automount, OBS WebSocket v5.
**Last updated:** 2026-06-04

---

## Why Bother

The desktop has a 12-core CPU, 64GB of RAM, and a GPU that sit idle most of the day. The agent host is always on but headless. Treating the two as peers means:

- The agent can push a finished artifact (a note, a render, a report) straight onto the desktop where I'll see it.
- The agent can read and write the desktop's bulk storage as if it were local.
- The agent can drive GUI apps on the desktop (start a recording, switch a scene) over the network.
- The desktop can act as a worker node for jobs that want its CPU/GPU.

None of this needs a VPN or cloud relay. It's all LAN, key auth, and a couple of well-scoped firewall rules.

Throughout this guide the always-on Linux box is **the agent host**, the Windows box is **the desktop**, and LAN addresses use the `192.0.2.x` range.

## 1. SSH Into Windows

Windows 11 ships OpenSSH Server as an optional feature. Once it's on, the desktop is just another SSH host, the same as any Linux box, except the remote shell is `cmd`/`powershell`, not bash.

Enable it from an elevated PowerShell on the desktop:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# allow inbound 22 on the Private profile only
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow `
  -LocalPort 22 -Profile Private
```

Use key auth, not passwords. Windows OpenSSH reads keys from a per-user file, with a separate file for administrators. For a normal user account, append your public key to:

```
C:\Users\you\.ssh\authorized_keys
```

If the account is in the Administrators group, Windows OpenSSH ignores that file and reads `C:\ProgramData\ssh\administrators_authorized_keys` instead, which must be owned by `Administrators`/`SYSTEM` with no inherited user ACLs. This is the single most common reason "my key works on Linux but not Windows."

Then add an alias on the agent host so the agent never types an IP:

```
# ~/.ssh/config on the agent host
Host desktop
  HostName 192.0.2.61
  User you
  IdentityFile ~/.ssh/desktop_key
  IdentitiesOnly yes
```

Now `ssh desktop powershell -Command "Get-Volume"` runs from the agent host or any agent acting on its behalf.

**Reality check:** silent/unattended installers run over OpenSSH on Windows are flaky, even when the SSH session is admin-elevated. MSI and NSIS installers that expect a desktop session hang or fail with files-in-use errors. Use SSH for scripting, file ops, and service control. For installing GUI software, RDP in or sit at the machine and run an interactive elevated shell.

## 2. Mount the Desktop's Drives on the Agent Host

The desktop shares two drives over SMB (a fast internal volume and a large external one). The agent host mounts both via CIFS automount so they appear under `/mnt/desktop/` and only spin up when something actually touches them.

Stash the SMB credentials in a root-only file, never inline in `/etc/fstab`:

```bash
# /home/you/.smbcreds-desktop  (chmod 600)
username=you
password=REDACTED
```

Then two fstab lines, one per share:

```fstab
//192.0.2.61/D  /mnt/desktop/d  cifs  credentials=/home/you/.smbcreds-desktop,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,nofail,x-systemd.automount,x-systemd.idle-timeout=300  0 0
//192.0.2.61/H  /mnt/desktop/h  cifs  credentials=/home/you/.smbcreds-desktop,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,nofail,x-systemd.automount,x-systemd.idle-timeout=300  0 0
```

What the options buy you:

- **`x-systemd.automount`** mounts on first access, not at boot. If the desktop is off, boot doesn't hang waiting for a share that isn't there.
- **`x-systemd.idle-timeout=300`** unmounts after five idle minutes, so a sleeping desktop doesn't leave a stale CIFS handle wedged.
- **`nofail`** keeps a missing share from blocking the boot sequence.
- **`uid=1000,gid=1000` + `file_mode=0644`** map ownership to your agent-host user so the agent can read without sudo, and nothing on the share is executable from the Linux side.

Force a mount and confirm:

```bash
ls /mnt/desktop/d >/dev/null   # triggers the automount
mount | grep /mnt/desktop      # shows two cifs entries once touched
```

One caution borrowed from the NAS playbook: some of what's on these shares is irreplaceable (photo archives, phone backups that mirror the NAS). Treat the mount as read-mostly. If an agent ever needs to write to the desktop, prefer the drop-folder pattern below over handing it a writable bulk mount it can wander around in. See [`nas-and-backups.md`](nas-and-backups.md) for the same read-only-by-default discipline applied to network storage.

## 3. The SCP Drop-Folder Inbox

Mounts are great for reading. For *delivery*, push, don't pull. I keep a dedicated inbox folder on the desktop, `C:\scp\`, that exists for exactly one purpose: things the agent host wants to hand to me land there.

The agent writes a note locally, then drops it onto the desktop:

```bash
# on the agent host: deliver a generated note to the desktop inbox
scp /tmp/daily-brief.md desktop:'C:/scp/'
```

Why a dedicated folder instead of scattering files into `Documents` or the user profile:

- **It's a contract.** Anything in `C:\scp\` is "the agent put this here for me." No guessing.
- **It's easy to watch.** A scheduled task or a file-watcher on the desktop can pop a toast, move the file into the right place, or open it.
- **It's easy to clean.** Empty the folder and you've lost nothing the agent can't regenerate.
- **It's scoped.** The agent only ever writes to one path. Even if the SMB share were writable, the delivery convention keeps writes contained to the inbox.

This pairs naturally with whatever generates the artifacts. A note-generator script ends with an `scp` to `desktop:C:/scp/`, and the file is waiting on the daily driver by the time I look. The Obsidian vault side of "get notes onto every machine" is covered separately in [`../knowledge/obsidian-sync.md`](../knowledge/obsidian-sync.md); the drop folder is for one-shot deliveries, not continuous sync.

## 4. Remote-Control Desktop Apps: The OBS Example

The most peer-like thing the agent host does is reach across the LAN and drive a GUI app running on the desktop. OBS Studio is the worked example because it exposes a clean WebSocket control surface.

OBS ships a WebSocket server (v5 protocol) that listens on **TCP 4455**. Enable it in OBS under Tools, WebSocket Server Settings: turn the server on, set a password, note the port.

Control it from the agent host with [`obs-cmd`](https://github.com/grigio/obs-cmd) (Rust, v5-native):

```bash
obs-cmd -w 'obsws://192.0.2.61:4455/PASSWORD' scene switch 'Live'
obs-cmd -w 'obsws://192.0.2.61:4455/PASSWORD' recording toggle
```

**Use `obs-cmd`, not `obs-cli`.** The older `obs-cli` speaks the v4 protocol and fails against OBS 28+ with a "Client/server version mismatch" auth error. OBS moved to the v5 WebSocket protocol years ago; the client has to match.

On the desktop, open the port to the LAN only:

```powershell
New-NetFirewallRule -Name 'obs-ws' -DisplayName 'OBS WebSocket' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow `
  -LocalPort 4455 -Profile Private
```

### Wrap It Per Host

Typing the full `obsws://host:port/password` URL every time is error-prone, and once you control OBS on more than one machine it gets worse. I wrapped it in a kubectl-style multi-host CLI: register hosts by alias, dispatch `obs-cmd` against the right one.

```bash
obsctl desktop recording toggle     # instead of obs-cmd -w obsws://.../...
obsctl desktop scene switch Live
```

I published that wrapper as **[obsctl](https://github.com/solomonneas/obsctl)**: a single-file bash CLI that keeps host aliases in `~/.config/obsctl/hosts.env` (generated by `obsctl init`, never committed) and routes each command to the matching host. It started as a hardcoded two-host script on my own box and got generalized so the aliases are entirely user-defined.

The same "drive a desktop peripheral from the agent host" idea extends past OBS. I published **[deckctl](https://github.com/solomonneas/deckctl)** for declaratively configuring a Stream Deck, since the deck is another physical device attached to the daily driver that I want to manage as code rather than click through a vendor GUI.

### The Pre-Seed Gotcha

OBS overwrites its WebSocket `config.json` on first launch. If you try to pre-seed the config (drop in a file with the server enabled and a known password *before* OBS has ever run), OBS clobbers it on startup and your settings vanish.

Config lives at:

- Windows: `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`
- Linux: `~/.config/obs-studio/plugin_config/obs-websocket/config.json`

The order that actually works:

```
install OBS  →  launch once  →  close it  →  edit config.json  →  relaunch
```

The schema you're editing is `server_enabled`, `server_port` (4455), `server_password`, `auth_required`, `first_load`. Edit it only after that first launch has written its defaults.

## 5. The Desktop as a Worker Node

The agent stack can treat the desktop as a compute node, not just a file/app target. The CPU and GPU are real resources; jobs that want them can run there while orchestration stays on the agent host.

The pattern that's held up for me:

- The desktop runs a **node worker** that registers with the agent host's gateway and exposes a narrow, allowlisted command surface (run a command, check whether a binary exists). It is paired to the gateway under a friendly display name.
- The allowlist is deliberately tiny. The worker advertises only the capabilities I want reachable. The fewer commands the remote node accepts, the smaller the blast radius if anything upstream misbehaves.
- The worker runs as a **Windows Scheduled Task** set to start at logon, so it survives reboots without me babysitting it.

Two operational notes worth saving:

- **Pin the worker's binary version.** Pull the node package from the same source as the gateway rather than whatever public release happens to be current. Version drift between the gateway and the desktop worker breaks the command surface in confusing ways. After upgrading the worker, reinstall its scheduled task (`--force`) or it reports needing repair.
- **Kill stale worker processes after an upgrade.** An old worker process can keep the gateway connected while advertising stale capabilities. Stop the leftover process before starting the new one, or you get a node that says it can do things it can't.

Keep the worker's status output off-the-record: it can print the gateway pairing token in its environment. Don't paste raw `status --json` into chat, logs, or notes.

## Verification

From the agent host:

```bash
echo "=== SSH alias reaches the desktop ==="
ssh -o ConnectTimeout=5 desktop "powershell -Command \"hostname\"" \
  && echo "✓ SSH key auth OK" || echo "✗ SSH failed (check administrators_authorized_keys ACL)"

echo ""
echo "=== SMB shares mount on demand ==="
ls /mnt/desktop/d >/dev/null 2>&1 && ls /mnt/desktop/h >/dev/null 2>&1 \
  && echo "✓ both shares mounted" || echo "✗ a share did not automount"
mount | grep -c /mnt/desktop

echo ""
echo "=== Drop folder is writable ==="
echo "ping $(date)" | ssh desktop "powershell -Command \"\$input | Set-Content C:\\scp\\_probe.txt\"" \
  && echo "✓ wrote to C:\\scp\\" || echo "✗ inbox write failed"

echo ""
echo "=== OBS WebSocket answers on the desktop ==="
obs-cmd -w "obsws://192.0.2.61:4455/PASSWORD" info >/dev/null 2>&1 \
  && echo "✓ OBS v5 WebSocket reachable" || echo "✗ OBS unreachable (server off, wrong port, or obs-cli vs obs-cmd)"
```

## Gotchas

1. **Administrator accounts ignore `~/.ssh/authorized_keys` on Windows.** If the desktop account is an admin, the key has to live in `C:\ProgramData\ssh\administrators_authorized_keys` with `Administrators`/`SYSTEM` ownership and no user ACL inheritance. Get this wrong and you'll fight a silent auth failure for an hour.

2. **Silent installs over SSH on Windows are unreliable.** OpenSSH sessions lack a real desktop context. MSI/NSIS installers hang or fail with files-in-use. Script everything else over SSH; install GUI apps interactively (RDP or in person).

3. **`obs-cli` is v4, `obs-cmd` is v5.** OBS 28+ only speaks the v5 WebSocket protocol. The v4 client fails with a version-mismatch auth error that looks like a bad password. Use `obs-cmd`.

4. **OBS clobbers its WebSocket config on first launch.** Pre-seeding `config.json` before OBS has ever run is wasted effort. Launch once, close, then edit.

5. **CIFS automount needs `nofail` and an idle timeout.** Without `nofail`, a powered-off desktop blocks boot. Without `x-systemd.idle-timeout`, a sleeping desktop leaves a stale mount that hangs the next `ls`.

6. **App-locked files break Windows upgrades.** Vendor background processes (RGB/peripheral daemons) hold file locks on apps like OBS and cause installer failures (NSIS exit 6 = files in use). `Stop-Process -Name <daemon> -Force` before upgrading clears it.

7. **Pin the worker-node binary to the gateway's version.** Drift between the desktop worker and the agent-host gateway breaks the remote command surface. Reinstall the scheduled task after every upgrade, and kill stale worker processes so they don't advertise ghost capabilities.

8. **Don't leak the node pairing token.** The worker's status output can include gateway token material in its environment. Keep raw `status --json` out of chat and notes.

## Related

- [`nas-and-backups.md`](nas-and-backups.md) - network storage mounts and the read-only-by-default discipline this guide reuses
- [`openclaw-host-topology.md`](openclaw-host-topology.md) - the agent host the desktop pairs with
- [`../knowledge/obsidian-sync.md`](../knowledge/obsidian-sync.md) - continuous note sync, the counterpart to the one-shot drop folder
- [`../security/wsl-hardening.md`](../security/wsl-hardening.md) - hardening the Windows side when it does more than serve files
