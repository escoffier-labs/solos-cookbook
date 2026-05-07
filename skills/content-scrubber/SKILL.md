---
name: content-scrubber
version: 1.0.0
description: "Deterministic redaction for outbound agent messages. Scrubs private infrastructure details, local endpoints, and operator-specific identifiers before content leaves the system."
tags:
  - redaction
  - privacy
  - safety
  - messaging
  - infrastructure
category: safety
---

# Content Scrubber

Use a deterministic scrubber between your agent and any external delivery surface.

## Goal

Prevent accidental leakage of internal infrastructure details, local endpoints, and operator-specific identifiers.

## What to catch

- RFC 1918 IPv4 addresses
- loopback addresses
- `localhost:<port>` style endpoints
- SSH and SCP targets
- private hostnames and service names
- internal filesystem paths when they reveal environment structure
- operator names, emails, or account identifiers when the destination is public

## Why deterministic rules

Use regex or explicit pattern rules, not an LLM rewrite pass.

Deterministic scrubbing is:
- fast
- auditable
- testable
- consistent under failure

## Placement

Run the scrubber as close to outbound delivery as possible:
- before chat sends
- before webhook delivery
- before external release flows
- before logging content to less-trusted destinations

## Replacement strategy

Replace sensitive values with stable placeholders such as:
- `[redacted-ip]`
- `[redacted-service]`
- `[redacted-target]`
- `[redacted-path]`
- `[redacted-identity]`

## Example

Before:
> SSH into admin@10.0.0.50 and check the service on localhost:8096

After:
> SSH into [redacted-target] and check the service on [redacted-service]

## Minimum config surface

Keep configuration small:
- `enabled`
- `dryRun`
- `allowlist`
- `customPatterns`

## Verification

Test with fixtures that include:
- private IPs
- loopback URLs
- SSH targets
- local paths
- safe public URLs that must remain untouched

## Failure mode to avoid

Do not make the scrubber so aggressive that it destroys legitimate public links, package names, or documentation examples. Precision matters.
