# OAuth and Token Lifecycle for a Multi-Provider Agent Stack

> A long-lived agent stack runs on subscription OAuth, not API keys, and the recurring pain is not auth setup. It is token lifecycle: rotation, per-agent state, fallback, and the silent failures that look like billing problems but are not.

**Tested on:** OpenClaw 2026.10.4 gateway, OpenAI OAuth (via the Codex runtime) as the main agent, Claude Code first-party login for the Claude lanes, systemd user services, `jq`
**Last updated:** 2026-10-17

## What this is

This guide covers how subscription OAuth is wired across a long-running orchestrator that runs multiple model providers, and the failure modes that actually bite once the stack has been live for weeks. Each failure mode has a symptom, a cause, and a recovery, because in practice the hard part is telling them apart at 2am when an agent suddenly returns a 401 or a 402.

The reference orchestrator is OpenClaw, but the lessons generalize to any agent runtime that caches provider OAuth state, runs a fallback chain, or shares a provider identity with a desktop app.

This is the operator's most recurring ops-pain area, so it gets its own guide instead of being scattered across model and secret docs.

## Why OAuth subscriptions over API keys

The stack runs provider OAuth subscriptions rather than metered API keys on purpose:

- **Flat-rate capacity.** A GPT-family subscription as the main agent and a Claude subscription for escalation both bill at a predictable monthly rate. Heavy agent loops do not turn into a surprise metered invoice.
- **Access to subscription-only behavior.** Some provider features and quotas only exist on the consumer or pro subscription, not on the pay-per-token API.
- **One identity per provider.** OAuth ties usage to an account you already own, instead of a separate key surface to provision and rotate.

The tradeoff is that OAuth state is mutable and renewable, where an API key is a static string. A static key fails in exactly one way: it is wrong or revoked. OAuth fails in a dozen subtle ways because the token rotates underneath you, is cached in several places, and sits behind a fallback chain. That mutability is the subject of this guide.

For why subscriptions over keys at the model-selection level, see [multi-model orchestration](multi-model-orchestration.md). For where secrets live and how to keep them out of public artifacts, see [secret management](../security/secret-management.md).

## Prerequisites

- An agent runtime that authenticates to providers via OAuth and stores token state locally
- `jq` for reading config
- A service manager (systemd user services here) that restarts the gateway cleanly
- A list of every host and every agent that uses the same provider identity (see "The auth surface" below)
- Auth state kept outside any repo

## How each provider lane authenticates

| Provider lane | Auth shape | Why |
|---|---|---|
| Main agent (GPT family, GPT 6.1 Sol) | Subscription OAuth profile in the orchestrator's auth store, run through the Codex runtime | Flat-rate orchestration capacity, subscription-only quota |
| Claude escalation | Claude Code's own first-party login in `~/.claude/`, reached through the ACP wrapper or the tmux relay | The orchestrator never holds the Claude credential. The first-party client makes the call |
| Local models | No remote auth, a placeholder local key | No external account, no token lifecycle |

The Claude lane is deliberately not a stored-token backend. See [Claude Code via tmux relay](claude-code-tmux-relay.md) and [Running Claude Code in OpenClaw via ACP](acp-claude-code.md) for the mechanics, and [the claude-cli migration](claude-cli-to-acp-migration.md) for what the `claude-cli` runtime looks like on a current OpenClaw. One rule from those guides applies here: `CLAUDE_CODE_OAUTH_TOKEN` in the environment overrides Claude Code's credentials file, so a stale exported token silently defeats a fresh login.

## The auth surface: where tokens live now

Earlier OpenClaw versions kept each provider token in per-agent `auth-profiles.json` files. On OpenClaw 2026.10 the OAuth state is SQLite-backed:

- Each agent has its own auth state store at `~/.openclaw/agents/<agent-id>/agent/openclaw-agent.sqlite`.
- Some provider profiles (API-key providers in my case) live in a shared store under `~/.openclaw/state/`.
- Per-agent **auth order overrides** choose which profile an agent uses for a provider.

Two consequences matter for operations:

1. **Profiles and per-agent selection drift independently.** A profile can be fresh in one store while another agent is still pinned to an older, expired profile. Do not infer health from a profile's expiry metadata alone, and do not assume that fixing the main agent fixed the agents it delegates to.
2. **You inspect and change it through the CLI, not with `jq` and `mv`.** The old pattern of rewriting JSON token files in a loop is risky now: the files may be stale import leftovers, and the gateway reads the SQLite store.

See what exists, per agent:

```bash
openclaw models auth list                      # default agent: store path, profile ids, provider, type
openclaw models auth list --agent <agent-id>   # another agent's store
openclaw models auth order get --agent <agent-id> --provider openai
```

A typical `list` output shows the store path, then one line per profile with its provider and type (`oauth` or `api_key`), an expiry, and a cooldown note if a profile recently failed auth. Several stale profiles for the same provider are normal after repeated re-logins. What matters is which one each agent's order override points at.

Enumerate the agents that use the provider so none are missed:

```bash
jq -r '.agents.entries | keys[]' ~/.openclaw/openclaw.json
```

Auth state is credential material and stays outside any repo. Confirm nothing auth-related is tracked:

```bash
git -C "$HOME/your-repo" ls-files | grep -iE 'auth|sqlite|\.env' || echo "clean"
```

## Failure modes and recovery

### Rotating refresh token (the recurring one)

**Symptom:** An agent that worked yesterday returns `401 refresh_token_reused` (or an equivalent "token already used" error). It often appears right after you used a desktop CLI app for the same provider.

**Cause:** OAuth refresh tokens are single-use and rotating. Each refresh mints a new refresh token and invalidates the old one. If two clients share one session, whichever refreshes second is holding a token the provider already retired.

**Recovery:** Give the orchestrator its own session instead of copying tokens between clients. Run the device-code login for the provider on the affected host, restart, and verify with a live turn (full recipe under "Re-authentication recipe" below).

**Durable fix:** This recurs whenever two clients refresh the same session. Do not copy a refresh token from a desktop app's auth file into the orchestrator's store. That is how two clients end up sharing one. Log the orchestrator in with its own device-code session, and accept that the desktop app and the orchestrator are separate sessions of the same account.

### Account-wide invalidation (security events)

**Symptom:** Several agents fail together with `refresh_token_invalidated`, `token_invalidated`, or `auth refresh request failed: code=-32603`, while the gateway and the chat channels stay healthy. A status page may still say the profile is usable.

**Cause:** An account-level security change at the provider, such as enrolling in an advanced account security program, can sign out active devices and invalidate refresh tokens across all of them. Active sessions are also shorter afterward.

**Recovery:** Treat re-authentication as an expected operating event and keep the recovery path short. Run the re-authentication recipe on every host that uses the account. Keep the stale profiles until the fresh one is verified, then remove them with `openclaw models auth logout <profile-id>`.

### Re-authentication recipe

Do this on each host, with one subscription shared across hosts:

```bash
# 1. Device-code login on this host, saving a stable profile id (interactive: you complete a code in a browser)
openclaw models auth login --provider openai --device-code --profile-id <new-profile-id>

# 2. Confirm the profile exists
openclaw models auth list

# 3. Pin it for EVERY agent that uses the provider, not just the main one
openclaw models auth order set --agent <agent-id> --provider openai <new-profile-id>

# 4. Restart the gateway so it reloads auth state
systemctl --user restart openclaw-gateway

# 5. Prove it with a live turn per agent (a "usable" status alone is not proof)
openclaw agent --agent <agent-id> --message "Reply with OK"
```

`openclaw models auth activate <profile-id>` tests a saved sign-in and uses it for an agent, which is a quicker check when the profile already exists. `openclaw models auth order clear` removes an override and returns the agent to default selection. Flags are as listed in each command's `--help`.

The step people skip is step 3 for delegated agents. Isolated cron sessions normally follow the main agent's auth route, but an agent that has its own auth-order override keeps using it. If you pin only the main agent, chat turns that delegate to another agent can keep failing.

### Multi-store drift

**Symptom:** Some agents work, others fail with `No API key found for provider <X>` or an auth refresh error even though "you just fixed auth." Failures correlate with which agent is running.

**Cause:** The fix landed in one agent's selection or store, and another agent still points at an older profile. Pre-2026.6 installs had the same shape with several `auth-profiles.json` files that were not symlinked and drifted apart.

**Recovery:** Compare the order override for every agent that uses the provider and make them agree on a profile you have verified:

```bash
for a in $(jq -r '.agents.entries | keys[]' ~/.openclaw/openclaw.json); do
  printf '%s: ' "$a"
  openclaw models auth order get --agent "$a" --provider openai 2>/dev/null | grep -i 'order override' || echo "(no override, default order)"
done
```

Any agent listed with a profile that `openclaw models auth list --agent <id>` shows as expired is the one to re-pin. Then restart once and run a live turn per agent.

**Generalize:** Any time you rotate a provider credential, enumerate every place its selection is stored first, change them as a set, restart last. Never fix one and "check if it works," because a partial success hides the rest.

### API-key fallback shadowing the subscription

**Symptom:** You are on a flat-rate subscription but keep hitting rate limits as if you were on metered API billing. Usage shows up against an API key you forgot existed.

**Cause:** An `api_key`-type profile exists alongside the `oauth` profile for the same provider. The runtime can fall back to the api_key profile on a transient OAuth hiccup and then stay on it.

**Recovery:** Check the profile types, and remove an `api_key` profile for any provider where you run on subscription:

```bash
openclaw models auth list | grep -E 'api_key|oauth'
openclaw models auth logout <api-key-profile-id>
```

If you genuinely need an API-key escape hatch, gate it deliberately rather than leaving it as a silent peer profile.

### Legacy `auth-profiles.json` installs (silent empty parse)

If you are still on a version that reads `auth-profiles.json`, the container shape is load-bearing: `profiles` must be an object keyed by provider, not an array. A wrong shape parses as zero profiles with no error, which looks identical to bad credentials.

```bash
# Should print "object". "array" or "null" means the shape is wrong.
jq -r '.profiles | type' auth-profiles.json
```

Generalize the lesson: when an agent reports missing credentials, confirm the auth config parses to a non-empty profile set before assuming the token is wrong. On SQLite-backed versions `openclaw models auth list` answers the same question.

### 402 "membership benefits" red herring

**Symptom:** A request returns `402` with a billing-flavored message about membership or benefits. It reads like a payment failure.

**Cause:** This is frequently not a billing problem. It is OAuth rate-limit exhaustion surfacing after the fallback chain runs out of options. The primary hit a subscription limit, the fallbacks were also unavailable or exhausted, and the final error carries a 402 with billing-flavored copy.

**Recovery:** Before touching payment settings, check whether you are simply rate-limited with nowhere left to fall back.

```bash
journalctl --user -u openclaw-gateway --since "15 min ago" | grep -iE "rate|429|402|fallback|next=none"
openclaw models status | grep -i usage
```

If the chain dead-ends at `next=none`, you are exhausted, not unpaid. Wait for the subscription window to reset, or add a working fallback. Do not "fix" billing for a rate-limit symptom.

### Fallback chain ordering (and an empty chain)

**Symptom:** When the primary hiccups, the agent silently lands on a less-preferred model and quality quietly degrades, with no obvious error. Or, with no fallbacks configured, the turn simply fails.

**Cause:** Fallbacks are tried in list order. A less-preferred model listed first takes over after one primary failure. An empty list has the opposite property: nothing takes over, so a rate limit or an auth failure surfaces directly as the user-visible error.

**Recovery:** Put the preferred fallback first and keep the chain to providers you actually run. My main agent's chain now ends on a different provider (Opus 5.5 through the `claude-cli` runtime), so a dead OpenAI token degrades to a slower answer instead of an outage. For months it was empty, which made auth failures loud but turned one dead token into a full outage. See [model retirement and fallbacks](model-retirement-and-fallbacks.md) for the trade-off.

```bash
jq '.agents.defaults.model' "$HOME/.openclaw/openclaw.json"
```

## Detection checklist: an agent suddenly 401s or 402s

When an agent that worked yesterday starts failing on auth, run these in order.

1. **What does the gateway think it is using?** Check the boot model line.
   ```bash
   journalctl --user -u openclaw-gateway --since "1 hour ago" | grep -iE "agent model|fallback|next=none|401|402|429|token_invalidated|refresh_token"
   ```
   The healthy boot line is `[gateway] agent model: openai/<id> ...`. If a normalize pass or a fallback swapped your provider, this is where it shows.
2. **Does the store hold usable profiles?** Confirm shape and type, not just expiry.
   ```bash
   openclaw models auth list
   ```
3. **Is there an api_key profile shadowing the subscription?** Look for `api_key` entries on a provider you run on OAuth.
4. **Does every agent that uses the provider point at a good profile?** Run the per-agent order loop from "Multi-store drift."
5. **Did a desktop app or another host refresh the same identity recently?** If yes, the stored refresh token is probably retired (rotating-token trap) and you need the re-authentication recipe.
6. **Is it a 402 with billing copy?** Treat it as rate-limit exhaustion first. Confirm with the fallback/`next=none` check in step 1 before touching billing.

The mental model: **401 or an invalidation error is almost always a session or selection problem, 402 is almost always rate-limit plus an exhausted fallback chain.** Confirm before you act.

## Verification

After any auth change, verify before declaring victory:

```bash
# 1. Profiles exist and the provider has at least one oauth profile
openclaw models auth list | grep -E 'openai.*oauth'

# 2. Every agent that uses the provider is pinned to the profile you verified
for a in $(jq -r '.agents.entries | keys[]' ~/.openclaw/openclaw.json); do
  printf '%s: ' "$a"
  openclaw models auth order get --agent "$a" --provider openai 2>/dev/null | grep -i 'order override' || echo "(no override)"
done

# 3. Readiness check (exit 0 ok, 1 missing/expired/unavailable, 2 expiring)
openclaw models status --check; echo "exit=$?"

# 4. Gateway came up on the model you expect, not a substitute
systemctl --user restart openclaw-gateway
sleep 3
journalctl --user -u openclaw-gateway --since "1 min ago" | grep -i "agent model"

# 5. A live round-trip succeeds for each agent, not just a clean boot
openclaw agent --agent <agent-id> --message "Reply with OK"
```

An `exit=2` ("expiring") with a freshly verified profile is not by itself a failure: an access token can be near expiry while the refresh path is healthy. Step 5 is the real test. Old stale profiles reported as expired also keep the exit code nonzero until you remove them with `openclaw models auth logout`.

Auth state should never be tracked by git. Confirm:

```bash
git ls-files | grep -iE 'auth-profiles|auth\.json|\.sqlite' || echo "clean"
```

Expected result: `clean`.

## Gotchas

1. **"Usable" is not proof.** A status page can say a profile is usable while a delegated agent is pinned to a different, expired one. Always finish with a live turn per agent.

2. **Pin every agent, not just main.** Delegated agents carry their own auth-order overrides. Pinning only the main agent leaves the delegates failing.

3. **Two clients, one OAuth session, is a recurring outage.** The rotating-token trap is not a one-time fix. Give the orchestrator its own device-code session rather than copying tokens from a desktop app.

4. **Do not hand-edit the auth store.** On SQLite-backed versions, use `openclaw models auth login`, `order set`, `activate`, and `logout`. Rewriting JSON files in a loop is a leftover from the file-based era and can touch the wrong copy.

5. **Keep stale profiles until the new one is verified.** Then remove them through `models auth logout`, so they stop shadowing or inflating status output.

6. **402 is usually a lie about billing.** It maps to rate-limit exhaustion after the fallback chain empties far more often than to a payment failure. Check the chain before the invoice.

7. **A cross-provider fallback hides auth failures.** The flip side of a populated chain: an expired OpenAI token now degrades quietly to the fallback. Check the model a turn actually used (`openclaw sessions --active 60 --json`) after any auth change, not just whether it answered.

8. **A stale `CLAUDE_CODE_OAUTH_TOKEN` in the environment beats a fresh Claude login.** If the Claude lane returns 401 after a clean `/login`, check the environment of the process that spawns it. See [the auth boundary](acp-claude-code.md#the-auth-boundary).

9. **Upgrades can rewrite auth and provider config.** After any upgrade, re-run the detection checklist before assuming a token rotated.

10. **Never paste a real token into a doc, issue, or transcript.** Show shape with placeholders. Auth state lives outside the repo and out of process arguments. See [secret management](../security/secret-management.md) for the full discipline.

## Related

- [multi-model orchestration](multi-model-orchestration.md) - why subscriptions over API keys at the model-selection level, and the fallback chain in context
- [model retirement and fallbacks](model-retirement-and-fallbacks.md) - what an empty or stale fallback chain costs
- [secret management](../security/secret-management.md) - where credentials live, permissions, and keeping them out of public artifacts
- [claude-cli to ACP migration](claude-cli-to-acp-migration.md) - the `claude-cli` runtime and the ACP lane
- [Running Claude Code in OpenClaw via ACP](acp-claude-code.md) - the Claude credential boundary
- [Claude Code via tmux relay](claude-code-tmux-relay.md) - reaching Claude through a first-party harness, and keeping its token out of argv
