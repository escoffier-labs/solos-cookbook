# Cron templates

Drop-in skeletons for the three scheduling layers covered in [`../../automation/cron-patterns.md`](../../automation/cron-patterns.md).

| File | Layer | Use when |
|------|-------|----------|
| `systemd-timer.service` + `systemd-timer.timer` | systemd | OS plumbing — backups, sync, mounts, log rotation |
| `openclaw-cron-job.json` | OpenClaw cron | Single-shot agent tasks — research, summarize, post |
| `n8n-schedule-trigger.json` | n8n | Multi-step workflows with branches, fan-out, error handling |

## How to use

1. Copy the file you need.
2. Replace every `<ANGLE_BRACKETS>` placeholder.
3. Install per the comments at the top of each file.
4. Verify with the `Verification` commands in the parent guide.

License: MIT (see [`../../LICENSE`](../../LICENSE)).
