# Setup Checklist: Empty Machine to Running Stack

A terse, one-page path from a fresh box to a working agent stack. Work top to
bottom. Each step names the template path to copy from and, where one exists,
the matching free guide at https://escoffierlabs.dev/cookbook.

Fill in every placeholder yourself. The templates ship with no secrets, no real
hostnames, and no private IPs on purpose. Keep it that way in your own copies.

1. Host prep. Provision the box, install your runtime (Node, package manager),
   and create the workspace directory. Decide where agent state lives before
   anything writes to it.
   Guide: https://escoffierlabs.dev/cookbook/infrastructure

2. Bootstrap files. Copy `bootstrap/` into your workspace and edit each file.
   Start with `INSTALL_FOR_AGENTS.md`, then set identity and rules in
   `IDENTITY.md`, `SOUL.md`, `SAFETY_RULES.md`, `USER.md`, `AGENTS.md`,
   `CLAUDE.md`, `TOOLS.md`, and `MEMORY.md`. These define who the agent is and
   what it may do.
   Path: `templates/bootstrap/`
   Guide: https://escoffierlabs.dev/cookbook/ai-stack

3. AI stack wiring. Configure models and routing from `ai-stack/`. Set aliases
   in `model-aliases.openclaw.json`, optional local routing in
   `ollama-local-routing.openclaw.json`, and the ACP wrapper if you route
   through a CLI relay. Run `plugin-health-check.sh` to confirm the stack loads.
   Path: `templates/ai-stack/`
   Guide: https://escoffierlabs.dev/cookbook/ai-stack

4. Hooks. Install lifecycle hooks from `hooks/`. Wire the post-tool-use hook
   (`claude-code-posttooluse.json`), the sync hook (`openclaw-sync-hook.ts`),
   and the `pre-push` guard so nothing leaves the machine unchecked.
   Path: `templates/hooks/`
   Guide: https://escoffierlabs.dev/cookbook/automation

5. Sandbox. Drop in the command guards from `sandbox/` so risky calls are
   gated. Wire `deny-command.sh` and `git-wrapper.sh` into your PATH ahead of
   the real binaries.
   Path: `templates/sandbox/`
   Guide: https://escoffierlabs.dev/cookbook/security

6. Cron and timers. Schedule recurring jobs from `cron/`. Use the systemd timer
   pair (`systemd-timer.service`, `systemd-timer.timer`) or the OpenClaw cron
   job template, depending on your scheduler.
   Path: `templates/cron/`
   Guide: https://escoffierlabs.dev/cookbook/automation

7. Security and scrubbers. Set service env from `security/service.env.example`
   and keep `incident-note.md` handy for the first incident. Install the
   content scrubber from `scrubbers/`: copy `rules.example.tsv` to your real
   rules file and run `scrub-content.sh` at every publish boundary. Add the
   skill in `skills/` and follow `sanitization-checklist.md`.
   Paths: `templates/security/`, `templates/scrubbers/`, `templates/skills/`
   Guide: https://escoffierlabs.dev/cookbook/security

8. n8n and automation. Import `n8n/workflow-skeleton.json`, add the failure
   classifier node, and connect the schedule trigger from
   `cron/n8n-schedule-trigger.json`. This is the last layer, so wire it only
   after the stack underneath it runs clean.
   Path: `templates/n8n/`
   Guide: https://escoffierlabs.dev/cookbook/automation

Done. The machine now boots, the agent loads its bootstrap files, hooks and the
sandbox gate every action, cron drives the recurring work, scrubbers guard the
publish boundary, and n8n runs the automations on top.
