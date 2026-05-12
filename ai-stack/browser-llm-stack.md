# Browser LLM Stack

> Browser-native model work without pretending every useful workflow has a clean API.

## What this is

Some of the best model workflows still live behind a browser session: logged-in research tools, subscription-only UIs, file-upload features, visual review, and draft publishing surfaces. A browser LLM stack gives your agent a controlled Chromium lane for those jobs while keeping API calls as the default path when they are available.

The pattern is simple: run Chromium in a service-owned display, keep one persistent profile per provider or workflow, expose noVNC for human login and inspection, and wrap every fragile profile in a lock.

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

## Verification

Check that the display service exists and is healthy:

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
