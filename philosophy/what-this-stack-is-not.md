# What This Stack Is Not

> Easier to write a cookbook by listing what is not in it. Every entry below is a thing other people put in their stacks, that I tried, considered, or watched fail, and explicitly do not do here.

## What this is

A list of negative space. The technical guides explain how things are done. This explains what is deliberately absent and why. If your stack does include one of these, that is fine. This is not a value judgment of you. It is a clarification of the design constraints behind the rest of the cookbook so you can decide if the patterns generalize to your case.

## Why this matters

A surprising amount of the cookbook's shape only makes sense if you also know what was rejected. A guide that says "use systemd timers" is not interesting on its own. The same guide gets useful when you know it was chosen *over* k8s CronJobs, Airflow, GitHub Actions, Temporal, n8n-for-everything, and a custom Python scheduler.

The cost of leaving the negative space implicit is that readers cargo-cult the visible part of the pattern without absorbing the constraint that produced it. So here is the list, with reasons.

## Hard nos

The list, with a one-line reason and a paragraph of context. Skip to the ones that apply to your stack.

### No Kubernetes

I am not running Kubernetes. Not k3s, not k0s, not microk8s, not "just to learn it." The agent control plane fits on one control host, and the rest of the owned machines have clear roles (see [`why-one-host.md`](why-one-host.md)). Adding k8s to a single-operator bare-metal fleet is not "kubernetes-lite". It is the worst case for k8s, because you are paying the operational cost without getting any of the benefits.

For the homelab side, where there are a handful of services that benefit from isolation (Adguard, n8n, a small social-automation stack), the answer is LXC containers under Proxmox. They are lighter, they boot in under a second, and they speak SSH like a real machine. When LXC becomes insufficient, I will revisit. It has not become insufficient yet.

### No microservices

The agent is one process. The orchestrator is one daemon. The dashboard sidecar is one Express app on Node. Each is a single repo and a single managed process. Where I have split things, the split is along a real boundary (the dashboard UI talks to the sidecar over HTTP because the UI is a browser bundle and the sidecar is the only thing that holds the API key and reads the workspace, see [`../tools/opsdeck.md`](../tools/opsdeck.md)), not along an imagined boundary ("the auth service should be separate from the user service").

The rule of thumb: split when the split removes a coupling that was actually causing trouble. Do not split because "modular is better." Modular is not better. Coupling is bad, and coupling sometimes correlates with deployment topology, but most of the time it does not.

### No SaaS lock-in

Every paid SaaS in the stack passes one test: I can leave with one weekend of work and lose nothing of value. Examples that pass:

- A subscription LLM API. The agent treats every model as a tool behind a uniform interface. Swapping providers is a config edit.
- A SaaS scheduler. The cron config is JSON files in `~/.openclaw/cron/`. If the scheduler died tomorrow, I would rewrite it as a few hundred lines of Python and lose nothing.
- A SaaS dashboard. The data lives in the workspace as flat files. The dashboard is one view over them.

Examples that would fail and are not in the stack:

- A SaaS database with proprietary query language. If your data is in their dialect, you are stuck.
- A SaaS observability platform that holds your historical metrics. Six months in, switching costs are real.
- A SaaS that needs an export step every time you want to read your own data.

The rule: keep your data, your config, and your logic on disk in formats you can read with `cat`. Pay for compute, pay for delivery, never pay for someone to hold your state.

### No untested fashion

A short list of technical fashions I have deliberately not adopted:

| Fashion | Reason for skipping |
|---------|--------------------|
| Service mesh (Istio, Linkerd) | Solves multi-service trust and routing problems this fleet does not have |
| Event sourcing for the agent's state | The agent's state fits in JSONL files plus a few sqlite databases, so "event sourcing" adds replay cost for no real query benefit |
| GraphQL anywhere | The number of queries this stack issues is small enough that REST + a few specific endpoints is cheaper to write and easier to debug |
| GitOps for the homelab | The homelab has maybe ten services. The cost of building a GitOps pipeline exceeds the cost of editing config files |
| Distributed tracing | Useful for systems with many hops between services. This system has approximately one hop |
| A general-purpose feature flag system | I have one engineer. "Comment out the line" is a feature flag |

The pattern: every fashion was invented to solve a real problem at a scale this stack does not have. Adopting it preemptively pays the cost without gaining the benefit.

### No infrastructure-as-code framework for the control host

The control host's config is in `/etc/`, version-controlled via etckeeper. systemd units live in `~/.config/systemd/user/` and are backed up by restic. The workspace is at `~/.openclaw/workspace/` and is backed up by restic. That is the entire infrastructure-as-code story for the agent brain.

Ansible, Salt, Pulumi, Terraform, Nix - all are valuable when many hosts need the same declared shape. This fleet is not that. The machines are owned, bare metal, and role-specific: the control host, homelab services, daily-driver machines, storage, and family endpoints. The closest the stack gets is a few shell scripts in `~/bin/` that wrap the most-touched config edits, plus a promote script that builds each OpenClaw release in its own worktree, rehearses it, snapshots state, and switches the gateway over with an automatic rollback. That replaced the old `openclaw update` wrapper, and [`../infrastructure/upgrade-hygiene.md`](../infrastructure/upgrade-hygiene.md) has the history.

I used to say that if two or more machines needed the same repeatable baseline, the cookbook should get a Nix or Ansible guide. The machine count did go up (see the expiry list below), and I still have not written one. What the worker machines share is a small set of tools and a roster, and a manifest-driven redeploy ([`../tools/repo-redeploy.md`](../tools/repo-redeploy.md)) plus the fleet's own enrollment cover that without a declarative framework. If a worker ever needs a full OS baseline, that is the day this entry flips.

### No production secrets in any prompt

The agent is allowed to read env vars in scripts it shells out to. The agent is not allowed to see the values of those env vars directly in its prompt. The orchestrator's secret resolution is one-way: it provides a reference, the resolver substitutes at execution time, the prompt never contains the value.

This is not a usability complaint about LLMs. It is a defense-in-depth posture. A leaked transcript should not also be a leaked credential. The cookbook's secret-management guide ([`../security/secret-management.md`](../security/secret-management.md)) is the implementation. This is the reason.

### No always-on remote access

The agent host is not directly exposed to the internet. SSH from outside the LAN comes through a VPN (the homelab runs Twingate inside an LXC). No port 22 on the public IP, no Cloudflare Tunnel terminating at the host. The worker machines reach the fleet hub over a private tailnet, and nothing in the fleet listens on a public address. The dashboard UI binds to `127.0.0.1`, the companion API refuses to start on a non-loopback address without a key, and a reverse proxy with its own authentication is the only way the LAN sees either one.

The cost: a few seconds of overhead when I am traveling. The benefit: the host's attack surface is the VPN's, not the public internet.

### No vibes-based monitoring

A daily report runs at a fixed hour, classifies a known set of services as up/degraded/down, and posts the result to a single chat channel I read. The report tells me what changed since yesterday and what failed in the last 24 hours. That is the whole monitoring story. There is no Grafana wall, no PagerDuty integration, no metrics retention policy.

This works because:

1. The system is small enough that a daily summary captures the interesting state.
2. The failure modes I care about (cron job failed, backup did not run, browser session died) are all enumerable, not statistical.
3. The latency-sensitive consumer is a person reading a chat channel, not a machine triggering an autoscaler.

A bigger or more public-facing system would warrant real metrics. This one does not.

## Soft nos

Less black-and-white. These are things I am skeptical of but might change my mind on with evidence.

### Skeptical of: running 70B+ local models on the agent host

The math is fine. The operational cost is not. A 70B-class model on the agent host competes for RAM with browser automation, the agent process, and a desktop. Better to dedicate a separate machine to that workload and treat it as a service the agent calls, if and when the workload justifies it.

### Skeptical of: containerizing the agent itself

The agent talks to the filesystem extensively, ships its own plugin loader, and benefits from being a normal user process under systemd. A container would add a layer of indirection without much benefit. The peripheral services (n8n, social automation, the dashboard sidecar) are happily containerized. The agent is not.

### Skeptical of: a heavyweight CI/CD pipeline for personal repos

I used to skip CI/CD for personal repos with a shrug. That stance is outdated. Anything that lands on `main` now goes through a pull request with required CI on the head commit and the review bots the repo has configured, and I fix or answer every actionable finding before merge. The agents open and own those PRs, which is the reason the gate has to be mechanical: nobody is reading every diff at the speed they arrive.

What I still do not do: staging environments, blue-green deploys, canary rollouts, and rollback automation for a one-engineer audience. The redeploy script ([`../tools/repo-redeploy.md`](../tools/repo-redeploy.md)) is still the entire deploy step for my own tools, and it only consumes what already passed CI. The line is between a gate that stops a bad change from landing, which I run, and a pipeline that manages how a change reaches users, which I do not need yet. Adding more layers requires evidence the current layer is failing.

### Skeptical of: heavy meta-tooling for prompts

I do not run a prompt service, a template engine, or an A/B testing harness. I tried a small one and retired it: the prompts I actually reuse live in skills and bootstrap files, which are plain markdown under git, and the agent loads them without a lookup step. Prompts are short and stable enough that versioned files cover it. If I were building prompts for a team with many concurrent experiments, I would reach for something heavier.

## When this list expires

A piece of advice is only as good as its context. Re-read this list any time:

- The audience changes from "you and me" to "many users you do not control"
- The host count goes above one. (This one has fired. See below.)
- A workload that you thought you would never have becomes load-bearing
- A tool you skipped because it was "too heavy" now solves a problem you actually have

At that point, the right answer is to revisit each entry. Some will stay no. Some will move to yes with a guide. Either is fine. The cost was in deciding deliberately, not in saying no.

### The host-count trigger has fired

When I first wrote this list the stack had one control host plus passive homelab machines. It now has a fleet hub and several worker machines, joined over a private tailnet, where agents on different machines claim work and report results through the hub. Revisiting the list with that in mind:

- **No Kubernetes** stays a no. A handful of machines with named roles is still not a scheduling problem.
- **No microservices** stays a no. The hub is one service, and each worker runs the same single-process tools.
- **No infrastructure-as-code framework** is closer to flipping than anything else here, as noted in that entry.
- **No always-on remote access** needed a clarification (the tailnet), not a reversal.
- **Distributed tracing** is still skipped. The hub's claims and run ledger answer "which machine is doing what," which was the only question I had.

The topology guide, [`why-one-host.md`](why-one-host.md), still describes where memory and the canonical state live. Only the "one" in "one host" stopped describing where the work runs.

## Templates

This piece is about constraints, not artifacts. The technical guides that operationalize each constraint:

- [`../infrastructure/openclaw-host-topology.md`](../infrastructure/openclaw-host-topology.md) - what the single-host topology actually looks like
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - the three-layer scheduling story chosen over Airflow / Temporal / k8s CronJobs
- [`../security/secret-management.md`](../security/secret-management.md) - the secret model that supports the "no production secrets in prompts" rule

## Related

- [`why-one-host.md`](why-one-host.md) - the affirmative case for the topology constraint
- [`why-dogfood-everything.md`](why-dogfood-everything.md) - the rule that prevents new fashion from entering this list quietly
- [`manifesto-vs-framework.md`](manifesto-vs-framework.md) - why this stack is shipped as a cookbook, not as a tool
