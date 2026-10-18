# Browser LLM Stack

> Browser-native model work without pretending every useful workflow has a clean API.

**Tested on:** OpenClaw 2026.10.4, Chrome lanes supervised by systemd user services on Xvfb, Claude Code 2.1.302
**Last updated:** 2026-10-17

## What this is

Some of the best model workflows still live behind a browser session: logged-in research tools, subscription-only UIs, file-upload features, visual review, and draft publishing surfaces. A browser LLM stack gives your agent a controlled Chromium lane for those jobs while keeping API calls as the default path when they are available.

The pattern is simple: run Chromium in a service-owned display, keep one persistent profile per provider or workflow, expose noVNC for human login and inspection, and wrap every fragile profile in a lock. In production I run each lane as its own supervised systemd service with a loopback debugging port, and attach to it from the agent runtime (see [Named persistent lanes as services](#8-run-each-lane-as-a-named-service)).

## Why this way

API-first is still the cleanest default. It gives you structured responses, stable auth, lower operational risk, and fewer moving parts. Use it whenever the API has the feature you need.

The browser lane exists for the cases APIs do not cover well:

- subscription entitlements attached to a web account
- research answers that need visible citations from a logged-in provider
- long-context or multimodal web UI features that are not exposed through API
- upload and visual workflows that require the provider's first-party UI
- draft creation in web apps where auto-publish would be reckless
- manual review of exactly what the model saw before you trust the output

The key design choice is to treat browser automation as an explicit lane, not a hidden fallback. It should have its own health checks, profile policy, locks, artifacts, and failure modes.

## Prerequisites

- Linux host with systemd user services
- Chromium or Chrome installed
- Playwright or equivalent browser automation library
- A virtual display service such as Xvfb
- Optional VNC/noVNC bridge for inspection and re-auth
- Comfort with file permissions, locks, and service logs

Do not start here if you only need ordinary completions, embeddings, code edits, or image generation. Start with provider APIs, ACP escalation, or local models, then add the browser lane for the gaps.

## Before / After

Before:

- One-off browser scripts open whatever profile happens to be available.
- Auth breaks silently when cookies expire.
- Two jobs can collide on the same Chromium profile.
- Screenshots and page state vanish after failure.
- Cron jobs treat UI automation like any other stateless command.

After:

- Each provider or workflow has a named browser lane.
- Persistent profiles are stored outside the repo and treated like credentials.
- `flock` serializes access to each profile.
- Humans can inspect or refresh login state through noVNC.
- Browser skills return structured output plus artifacts.
- Cron jobs know browser work is slow, stateful, and lock-bound.

## Implementation

### 1. Define the lanes

Create lanes around workflow ownership, not around vague provider names. If two jobs can safely share cookies and never run at the same time, they can share a lane. If they have different risk, artifact, or concurrency needs, split them.

Example lane map:

| Lane | Purpose | Notes |
|------|---------|-------|
| `research-primary` | logged-in research UI | returns answer text and source URLs |
| `long-context-review` | large upload or multimodal review | stores uploaded filenames in artifacts |
| `visual-generation-review` | web-only visual workflows | use native image APIs first |
| `draft-publishing` | web editor draft creation | saves drafts only, never publishes |

Keep the real account name, email address, billing tier, and recovery details out of the repo. Public guides should describe the lane shape, not the private account.

### 2. Store profiles outside the repo

Use a private state path with restrictive permissions:

```bash
install -d -m 700 ~/.config/agent-browser/profiles
install -d -m 700 ~/.local/state/agent-browser/locks
install -d -m 700 ~/.local/state/agent-browser/artifacts
```

Recommended layout:

```text
~/.config/agent-browser/
  profiles/
    research-primary/
    long-context-review/
    visual-generation-review/
    draft-publishing/

~/.local/state/agent-browser/
  locks/
    research-primary.lock
    long-context-review.lock
  artifacts/
    research-primary/
    long-context-review/
```

Treat a browser profile like a password vault. It contains live cookies, session tokens, extension state, history, and provider-specific account metadata.

### 3. Run a service-owned display

The browser should not depend on a developer's interactive desktop. A common setup is:

- Xvfb provides a stable virtual display.
- Chromium runs headed inside that display.
- x11vnc exposes the display locally.
- noVNC gives a browser-accessible viewer for re-auth and inspection.

Keep the concrete port and bind address in local config, not in the guide or repo. If you publish a template, use placeholders:

```ini
[Service]
Environment=DISPLAY=<display>
Environment=NOVNC_LISTEN=<bind-address>:<vnc-port>
```

Bind the viewer to loopback or a private control plane unless you have a real access-control layer in front of it. Browser sessions are authenticated control surfaces.

### 4. Lock every persistent profile

Chromium persistent profiles are not safely multi-writer. Playwright's `launchPersistentContext` will fail or corrupt behavior if two jobs try to open the same profile at once.

Wrap every lane command in `flock`:

```bash
lane="research-primary"
lock="${XDG_STATE_HOME:-$HOME/.local/state}/agent-browser/locks/${lane}.lock"
profile="${XDG_CONFIG_HOME:-$HOME/.config}/agent-browser/profiles/${lane}"

mkdir -p "$(dirname "$lock")" "$profile"
flock -w 900 "$lock" \
  node scripts/browser-lane.mjs --lane "$lane" --profile "$profile" "$@"
```

Use one lock per lane. Do not use a global browser lock unless every browser job truly blocks every other browser job.

### 5. Put a skill boundary around the browser

The orchestrator should not know how to click the provider UI. It should call a narrow skill or script that owns:

- profile path selection
- lock acquisition
- browser launch and timeout policy
- login-state detection
- screenshot and trace capture
- provider-specific scraping
- structured output

Good browser skills return JSON shaped like this:

```json
{
  "ok": true,
  "lane": "research-primary",
  "stage": "complete",
  "text": "Short answer or saved draft summary.",
  "sources": ["https://example.com/source"],
  "artifacts": ["~/.local/state/agent-browser/artifacts/research-primary/run-id/page.png"],
  "needsHuman": false,
  "durationMs": 42000
}
```

When auth expires, return a structured pause instead of pretending the model failed:

```json
{
  "ok": false,
  "lane": "research-primary",
  "stage": "auth_required",
  "needsHuman": true,
  "message": "Open the noVNC viewer for this lane and refresh the login."
}
```

### 6. Use native tools first

The browser lane should not become a habit for jobs that have clean tool paths.

Use native APIs or built-in tools for:

- ordinary chat, coding, and summarization
- embeddings and search indexing
- deterministic file processing
- normal image generation
- jobs that need structured outputs with strict schemas

Use browser automation only when the browser session is part of the requirement.

### 7. Make publish flows draft-only

Browser automation can type into real web apps, so it needs a hard publish boundary.

For social posts, articles, newsletters, and CMS work:

- generate the content
- open the editor
- fill a draft
- attach screenshots or source links as artifacts
- stop before the final publish action
- return a `needsHuman` review result

The automation should not click destructive, financial, external-send, or public-publish buttons unless the operator explicitly asked for that specific action in the live session.

### 8. Run each lane as a named service

The flock-and-script pattern above works for batch jobs. For lanes that stay logged in all day and get driven by several tools, I moved to one systemd user service per lane, named `browser-<lane>.service`. Each lane owns four things: a private profile directory, a virtual display, a Chrome remote-debugging (CDP) port, and a noVNC port for human login. Pick generic names that describe the workflow, for example `publishing`, `research-a`, `portal-b`. The lane name should never reveal the account behind it.

Live unit shape (placeholders for the per-lane values):

```ini
[Unit]
Description=<lane> Chrome lane (CDP <cdp-port>, noVNC <novnc-port>) on Xvfb :<display>
Requires=xvfb.service
After=xvfb.service

[Service]
Type=simple
ExecStart=%h/.local/lib/browser-bridge/browser-lane-supervisor.sh <lane> %h/.cache/<lane>/chrome.pid <cdp-port> %h/bin/<lane>-browser-launcher
ExecStartPost=/bin/bash -c 'for i in {1..30}; do curl --fail --silent http://127.0.0.1:<cdp-port>/json/version >/dev/null && exit 0; sleep 1; done; exit 1'
Restart=always
RestartSec=5
TimeoutStartSec=45
KillMode=control-group

[Install]
WantedBy=default.target
```

Four details came from failures:

- **`Type=simple` with a supervisor, not `Type=oneshot`.** A launcher that starts Chrome and exits leaves a `oneshot` unit "active" after Chrome has died. The supervisor script starts Chrome, waits for CDP, then watches the PID and polls `/json/version` every few seconds. Three failed health checks in a row exits non-zero, and `Restart=always` brings the lane back.
- **`ExecStartPost` readiness check.** A lane is not "started" until its CDP endpoint answers. Anything that depends on the lane can wait on that.
- **`KillMode=control-group`.** Chrome spawns many children. Without this, a restart leaves orphans holding the profile lock.
- **Everything on loopback.** The CDP port, the noVNC port, and the x11vnc port all bind to `127.0.0.1` (and `::1`). x11vnc needs `-localhost` explicitly when the websocket proxy is loopback-bound, otherwise the raw VNC port listens on every interface. Process state is not proof: verify with an HTTP 200 from noVNC and a valid CDP response.

I keep a generated registry of lanes (name, unit, profile directory, ports, display, status) so tools discover lanes instead of hardcoding ports. A systemd path unit watches the user unit directory and the launcher scripts, and reruns the generator when a `browser-*.service` file changes. One long-lived lane also gets a daily restart timer scheduled for the quiet hours, because Chrome that has been up for weeks accumulates memory and stale tabs.

### 9. Attach from the agent, with tab discipline

Agents drive a lane by attaching to its CDP port, usually through a per-lane DevTools MCP server, so one MCP entry maps to one lane and one profile. Three rules keep that sane:

- **One driver per lane.** If another agent owns the lane, wait or use a different lane whose purpose matches. Do not pick a lane because its browser happens to be open.
- **Label your tab, close only your tab.** Open a labeled task tab, and on exit close exactly that tab. Never close a pre-existing tab or the last remaining page target, because closing the last page can take the browser with it.
- **Check the endpoint before attaching.** A healthy lane returns JSON from `http://127.0.0.1:<cdp-port>/json/version`. A refused connection means the lane is down, which is a service problem, not an agent problem.

### 10. Recover sessions and fill credentials without exposing either

Persistent profiles still lose their login. Two layers handle it without a human at the keyboard:

- **Session recovery.** [Agent Pantry](https://github.com/escoffier-labs/agentpantry) backs up and restores browser session state for a named profile, with a dry run by default and an explicit apply step. The agent never reads or returns the raw cookie contents. After a successful new login, take a fresh backup of that profile.
- **Credential fill.** For an existing login, a broker tool fills the form from a password manager without returning the secret to the model. Mine is scoped to a single browser-operator agent, bound to an exact item, origin, profile, and target, requires approval for each fill, returns redacted metadata, and never submits the form. Submitting stays a separate, deliberate step.

Keep the lane agent narrow: no shell and no filesystem tools on the browser-operator, and no fallback to the personal desktop session when a lane is unavailable.

### 11. Attaching a second-opinion tool to a signed-in Chrome

Some consultation tools drive a first-party chat UI instead of an API. I run one (Oracle) against my existing signed-in Chrome by attaching over a loopback CDP port instead of launching its own profile. The relevant config is two keys:

```json
{
  "browser": {
    "attachRunning": true,
    "remoteChrome": { "host": "127.0.0.1", "port": <cdp-port> }
  }
}
```

I switched to attach mode because a separately launched profile hit a bot-challenge login loop that the already-trusted browser did not. The tradeoffs are real: the tool controls tabs in the browser you are using, so coordinate use and keep to one driver at a time, and a debugging port on a signed-in browser is as sensitive as the browser itself, so it must stay on loopback. Select the browser engine explicitly when you invoke it, and do not let a failed browser attach silently fall back to a paid API or a different model.

## Verification

For the named-service lanes, list them and confirm each one answers on its debugging port:

```bash
systemctl --user list-units 'browser-*' --no-pager
```

Expected: one `browser-<lane>.service` per lane, `loaded active`, and `running` for supervised lanes. Then probe each lane's CDP endpoint:

```bash
curl -fsS http://127.0.0.1:<cdp-port>/json/version | jq '.Browser'
```

Expected: a Chrome version string. Confirm nothing is listening beyond loopback:

```bash
ss -ltn | grep -E ':(<cdp-port>|<novnc-port>)\b'
```

Expected: every listener shows `127.0.0.1` or `[::1]`, never `0.0.0.0` or `*`.

For the script-based pattern, check that the display service exists and is healthy:

```bash
systemctl --user status agent-browser-display.service
```

Confirm profile and lock paths are private:

```bash
find ~/.config/agent-browser ~/.local/state/agent-browser -maxdepth 2 -type d -printf '%m %p\n'
```

Expected profile directory permissions are `700` or stricter.

Confirm lane locks work:

```bash
lane=research-primary
lock="${XDG_STATE_HOME:-$HOME/.local/state}/agent-browser/locks/${lane}.lock"
flock -n "$lock" true
```

If a job is running, the non-blocking lock check should fail. If nothing is running, it should exit cleanly.

Run a smoke query through the wrapper:

```bash
node scripts/browser-lane.mjs \
  --lane research-primary \
  --mode smoke \
  --query "Return one sentence and one source URL."
```

Expected result:

- JSON output includes `ok`, `lane`, `stage`, and `durationMs`
- screenshots or traces are saved for failures
- source URLs are returned when the provider exposes them
- auth failures return `stage: "auth_required"` and `needsHuman: true`

Run two concurrent jobs against the same lane and verify one waits or exits with a lock timeout. Run two jobs against different lanes and verify they can proceed independently if the machine has enough resources.

## Gotchas

1. **Persistent profiles are credentials.** Do not commit them, back them up casually, or expose them through shared mounts. A copied profile can carry live sessions.

2. **Provider UIs drift.** Browser selectors will break. Prefer accessible labels, visible text, and stable role selectors where possible, then capture screenshots on every failure.

3. **Human login is part of the system.** Auth expiry is not a crash. Return a structured `auth_required` state and route the operator to the viewer.

4. **Shared profiles create fake concurrency.** A shared profile may work for weeks, then fail under one overlapping cron job. Lock by profile, not by script.

5. **noVNC is a control surface.** If someone can reach the viewer, they can interact with authenticated browser sessions. Keep it local, tunneled, or protected.

6. **Uploads leave residue.** Web UIs often keep recent files, drafts, or history. Scrub test data and keep sensitive uploads out of public demos.

7. **Browser answers need source discipline.** Research skills should return source URLs or screenshots, not just model prose from the page.

8. **Cron needs longer patience.** Browser jobs need bigger timeouts, fewer retries, and clear lock behavior. Fast retry loops can stack up behind a single expired login.

9. **A `oneshot` browser unit lies about health.** If the unit stays "active" after Chrome exits, nothing restarts it and everything attached to it fails with connection refused. Use a supervising `Type=simple` service with `Restart=always`.

10. **A debugging port is a login.** Anyone who can reach a lane's CDP port can drive its authenticated session. Keep CDP and noVNC on loopback, and tunnel if you need remote access.

11. **Do not close the last page target.** Closing the final tab in a lane risks ending the browser. Close only the tab you opened.

## Templates

- [`../templates/ai-stack/browser-lane-lock.sh`](../templates/ai-stack/browser-lane-lock.sh) - tiny `flock` wrapper for lane commands
- [`../templates/ai-stack/acp-wrapper.mjs`](../templates/ai-stack/acp-wrapper.mjs) - wrapper shape for subprocess-owned escalation tools
- [`../templates/scrubbers/`](../templates/scrubbers/) - publish-boundary scrubber skeleton and fixtures

## Related

- [`multi-model-orchestration.md`](multi-model-orchestration.md) - where the browser lane fits among APIs, ACP, and local models
- [`skills-development.md`](skills-development.md) - package browser workflows as discoverable skills
- [`session-management.md`](session-management.md) - isolate long-running browser work from chat sessions
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - schedule slow stateful browser jobs safely
- [`../automation/hooks.md`](../automation/hooks.md) - add scrubbers and tool-call boundaries around outbound content
- [`../infrastructure/openclaw-host-topology.md`](../infrastructure/openclaw-host-topology.md) - host-level audit points for browser automation
