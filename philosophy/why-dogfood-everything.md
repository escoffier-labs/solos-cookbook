# Why Dogfood Everything

> Ship it. Use it. Break it. Fix it. Write it down. The loop is short on purpose. Anything in this cookbook that did not survive that loop is not in this cookbook.

## What this is

A position piece on a working rule the rest of the cookbook obeys: every tool, pattern, and recipe in here has been deployed against my own actual workload and broken at least once. That is the gate for inclusion. There are no "future-proof" patterns, no "best-practice" ideas borrowed from blog posts, no "this would probably work" suggestions. If it has not run in service on this machine, it is not here.

## Why this way

Three things drive the rule:

### 1. Most "best practices" decay on contact with reality

The lifecycle of a technical idea on the internet:

1. Someone solves a real problem with a real constraint.
2. They write a blog post.
3. Other people read the post.
4. They cargo-cult the answer into a different problem with different constraints.
5. The answer is now folklore. The constraints are gone.

The pattern repeats indefinitely. Half of "best practice" is one engineer's specific tradeoff, generalized past where it was true. The only defense is to run a thing yourself against a real workload before you write about it. Dogfooding is the cheapest filter.

### 2. Real workloads expose real failure modes that synthetic tests do not

The agent stack in this cookbook has been broken by:

- A daemon upgrade that silently rewrote a systemd unit file
- A cron job that called a deleted endpoint and wiped a database
- An OAuth token that rotated on one client and invalidated the other
- A scrubber that ate its own blog post about scrubbing
- A doctor command that "normalized" config and broke every agent run

None of those show up in a unit test, an integration test, or a "best practice" article. They show up at 11 pm on a Sunday when a real publish queue stalls. The fix is in the cookbook because it had to be. The reason for the fix is in the Gotchas section because the fix alone is not useful without the cause.

### 3. The cookbook is for me first, others second

The primary reader of every guide is me, six months later, after I have forgotten which knob I turned. The secondary reader is any engineer who runs a similar stack. Writing for the primary reader keeps the writing honest: a guide that does not survive my own future self reading it is a bad guide. Marketing tone, hype, and "you will love this" prose all fail that test, and they are absent from the cookbook on purpose.

## The loop

```
Ship → Use → Break → Fix → Write → (back to Use)
```

Each step is small. The loop only stays useful if it stays short.

### Ship

Build the minimum thing that solves the problem you have right now. Not the abstraction you would build "if you had time," not the generalization you would do "for the team," not the framework you would write "to avoid this problem in the future." The smallest thing that solves this problem this week.

Examples from this cookbook:

- The scrubber started as `sed -i` with two patterns.
- The repo-redeploy script started as a one-line cron entry.
- The OpenClaw cron jobs started as ad-hoc curl calls in a terminal tab.

Each became its current shape only after being used. They were never designed in advance.

### Use

Run the thing in service. Not a synthetic test, not a tutorial run-through. Actually use it for the workload it was built for, every day, for at least a week. Use is the only thing that produces real signal. Reading does not produce signal, planning does not produce signal, design reviews do not produce signal.

This step is where most projects stop. People build a tool, mark it "done," and never use it themselves. The tool atrophies because it was never load-bearing.

### Break

The tool will break. Every tool breaks. The interesting question is *how* it breaks and what that tells you about its shape. Some breakage you expected and have a recovery story for. Some breakage you did not expect and now have to think about.

The cookbook's Gotchas sections are entirely written from this step. Every one of them is a breakage that surprised me. There are no theoretical gotchas.

### Fix

Two rules:

1. **Fix the proximate cause now**, so the system works again.
2. **Fix the deeper cause next**, so the failure does not recur.

The two are not the same fix. The proximate fix might be "restart the gateway." The deeper fix is "wire the env file back into the systemd unit so the next upgrade does not strip it." Without the second fix, you will live the same incident again.

Skipping rule 2 is the most common antipattern. People restart the service, the alarm clears, and they move on. Three weeks later, the same alarm fires. That is the universe asking you to do step 2.

### Write

Write it down. Three places, depending on what it is:

| Where | What goes there |
|-------|----------------|
| Code comments | The kind that warn the next reader away from a subtle thing |
| Memory cards | Durable knowledge that future-you needs to recall |
| Cookbook | A pattern other engineers can lift |

A breakage that has happened twice but is not written down anywhere is a guarantee it will happen a third time. The cookbook itself is the long-form version of this rule.

The writing is the cheap part. Most engineers I know are bad at this not because writing is hard, but because they treat it as a chore that happens after the work. Writing *is* the work. You did not understand a fix until you can explain it to someone else.

## What dogfooding is not

It is not "use my own product in beta and call that production." Real dogfooding has stakes:

- Your actual writing depends on the scrubber.
- Your actual social posts depend on the pipeline.
- Your actual cron jobs deliver to real channels you actually read.
- Your actual backups are the ones you rely on after a disk failure, not a separate "test" set.

If the system you are dogfooding has no real stakes, you are not dogfooding. You are running a parallel sandbox. The bugs you find in a sandbox are sandbox bugs. The bugs you find in production are production bugs. Only the second kind matters.

This is also not "ship to users who pay so we can call it dogfooded." Other people running your code is great; it is not a substitute. Your incentive structures are different from your users', and the bugs they will report are filtered by their willingness to file an issue. You will not file an issue against yourself. You will fix the bug.

## When dogfooding stops working

A short list. If you are in one of these, the rule needs a different shape:

- **The workload is something you will never personally do.** A CRM for sales teams cannot be dogfooded by a backend engineer. Find users. Listen to them. Pay attention to the gap between what they say and what they do.
- **The cost of breakage to you exceeds the cost of learning the lesson.** If breaking your bank account would ruin your week, do not dogfood your bank account. Some systems should be conservative on purpose. The agent stack is not one of them; my bank account is.
- **You are the only user, and you are also wrong.** Sometimes the system is built around a habit that is itself a bad habit. Dogfooding will not surface that; outside review will. This is the rare case where "best practice" reading is genuinely useful: not to copy the pattern, but to notice the gap.

## How this rule shows up in the cookbook

A few markers that this rule is being applied:

- Every guide has a Gotchas section. If nothing broke, the guide is not finished.
- Every guide has a Verification section with commands that ran on a real host. Output is not described from theory.
- The Templates section points at files in this repo that I lifted from the live stack, scrubbed, and shipped.
- The Related section links to other live components that depend on the one you are reading.
- The README's recommended-provider section says "this is the happy path because I run this." Not "this is the best path" or "this is what we recommend."

When you read a guide here, the implicit promise is: this ran. It broke. I fixed it. The writeup is what I wish someone had handed me before the breakage.

## Templates

This piece is about the writing discipline, not a runnable artifact. Pair with:

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) - the per-guide format that enforces this rule
- [`../automation/cron-patterns.md`](../automation/cron-patterns.md) - reference guide showing what "wrote down what broke" looks like in practice

## Related

- [`why-one-host.md`](why-one-host.md) - related stance on operational simplicity that makes dogfooding affordable
- [`what-this-stack-is-not.md`](what-this-stack-is-not.md) - explicit list of patterns this rule pushes against
- [`manifesto-vs-framework.md`](manifesto-vs-framework.md) - why this body of work is cookbook-shaped, not framework-shaped
