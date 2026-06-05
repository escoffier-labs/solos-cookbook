# Publishing

Reserved for docs about sanitizing and validating artifacts before they leave the host.

## Guides

- [x] [`publish-time-scrubbing.md`](publish-time-scrubbing.md) - deterministic scrubbing, scanner gates, media checks, and review logs at the outbound boundary

Two guides that were planned here, `artifact-scrubbers.md` and `release-boundary-checks.md`, got absorbed into `publish-time-scrubbing.md` instead of becoming standalone pages. The scrubber recipes live in its Implementation sections and the preflight gates in its scanner and pre-push sections. One guide that covers the whole boundary beats three that overlap.

> Per-guide format lives in [`../automation/cron-patterns.md`](../automation/cron-patterns.md).
