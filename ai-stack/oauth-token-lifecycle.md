# OAuth and Token Lifecycle for a Multi-Provider Agent Stack

> A long-lived agent stack runs on subscription OAuth, not API keys, and the recurring pain is not auth setup. It is token lifecycle: rotation, caching, fallback, and the silent failures that look like billing problems but are not.

**Tested on:** OpenClaw 2026.6.2 gateway, OpenAI Codex-style provider OAuth as the main agent, a Claude subscription reached only through an interactive harness lane, systemd user services, `jq`
**Last updated:** 2026-06-10

## What this is

This guide covers how subscription OAuth is wired across a long-running orchestrator that runs multiple model providers, and the failure modes that actually bite once the stack is live for weeks. Each failure mode has a symptom, a cause, and a recovery, because in practice the hard part is telling them apart at 2am when an agent suddenly returns a 401 or a 402.

The reference orchestrator is OpenClaw, but the lessons generalize to any agent runtime that caches provider OAuth state and runs a fallback chain. If your runtime stores refresh tokens in files, shares a provider identity with a desktop app, or falls back between models, every trap below applies.

This is the operator's most recurring ops-pain area, so it gets its own guide instead of being scattered across model and secret docs.

## Why OAuth subscriptions over API keys

The stack runs provider OAuth subscriptions rather than metered API keys on purpose:

- **Flat-rate capacity.** A GPT/Codex-style subscription as the main agent and a Claude subscription for an escalation lane both bill at a predictable monthly rate. Heavy agent loops do not turn into a surprise metered invoice.
- **Access to subscription-only behavior.** Some provider features and quotas only exist on the consumer or pro subscription, not on the pay-per-token API.
- **One identity per provider.** OAuth ties usage to an account you already own, instead of a separate key surface to provision and rotate.

The tradeoff is that OAuth state is mutable and renewable, where an API key is a static string. A static key fails in exactly one way: it is wrong or revoked. OAuth fails in a dozen subtle ways because the token rotates underneath you, gets cached in several places, and sits behind a fallback chain. That mutability is the entire subject of this guide.

For why subscriptions over keys at the model-selection level, see [multi-model orchestration](multi-model-orchestration.md). For where token files live on disk and how to keep them out of public artifacts, see [secret management](../security/secret-management.md).

## Prerequisites

- An agent runtime that authenticates to providers via OAuth and caches token state in local files
- `jq` for reading and rewriting auth config without hand-editing JSON
- A service manager (systemd user services here) that restarts the gateway cleanly
- A clear list of every file that caches the same provider token (see "The auth surface" below)
- Token files kept outside any repo and gitignored

## Why OAuth, not just an API key, for each provider

| Provider lane | Auth shape | Why |
|---|---|---|
| Main agent (GPT/Codex-style) | Subscription OAuth, primary model slot | Flat-rate orchestration capacity, subscription-only quota |
| Escalation (Claude subscription) | First-party harness OAuth, reached through an interactive lane | Subscription auth is not usable as a raw third-party backend, so it runs through the harness |
| Local models | No remote auth, a placeholder local key | No external account, no token lifecycle |

The Claude lane is deliberately not a direct backend. The subscription cannot be driven as a plain third-party OAuth backend anymore, so it is reached through an interactive harness relay. See [Claude Code via tmux relay](claude-code-tmux-relay.md) and the [claude-cli to ACP migration](claude-cli-to-acp-migration.md) for that lane's mechanics.

## The auth surface: where tokens live, and the multi-file reality

The single most important thing to internalize: **one provider token is usually cached in more than one place.** The orchestrator may keep separate auth-profile files per agent role (a main agent, a coder agent, a builder agent) plus a workspace-level copy. They are not symlinked. They drift.

A generic auth-profiles entry has this shape. Real values never go in the repo, only placeholders here:

```json
{
  "profiles": {
    "<provider>:default": {
      "type": "oauth",
      "provider": "<provider>",
      "access_token": "<access-token>",
      "refresh_token": "<refresh-token>",
      "expires_at": "<iso-8601-timestamp>"
    }
  }
}
```

Two things in that shape are load-bearing and both have bitten in production:

1. **`profiles` is an object keyed by provider, not an array.** In recent orchestrator versions, a wrong-shape config (an array, or the right keys at the wrong nesting) parses as zero profiles with no error. A silent empty parse looks exactly like bad credentials. Always validate the shape, not just the values.
2. **`type` matters.** An `oauth` profile and an `api_key` profile can coexist for the same provider, and the runtime may quietly prefer the wrong one. See the api-key fallback trap below.

Enumerate every cache before you touch anything:

```bash
# Find every auth-profiles file the runtime reads. Adjust the search root to your install.
find "$HOME/.openclaw" -name 'auth-profiles.json' -not -path '*/node_modules/*'
```

A typical result is several files: one per agent role under the agents tree, plus a workspace copy. **Write all of them together or some agent runs will fail while others succeed**, which is a maddening intermittent symptom. The token files are credential material and live outside any repo. Confirm they are gitignored:

```bash
git -C "$HOME/your-repo" check-ignore -v path/to/auth-profiles.json 2>/dev/null || echo "not in any repo, good"
```

## Failure modes and recovery

### Rotating refresh token (the recurring one)

**Symptom:** An agent that worked yesterday returns `401 refresh_token_reused` (or an equivalent "token already used" error). It often appears right after you used a desktop CLI app for the same provider.

**Cause:** OAuth refresh tokens are single-use and rotating. Each refresh mints a new refresh token and invalidates the old one. If a desktop CLI app for the same provider refreshes its session, it consumes the shared identity's current refresh token and the orchestrator's stored copy becomes stale. The next time the gateway tries to refresh, the provider rejects the reused token.

**Recovery:**

1. Trigger a fresh refresh from the desktop app (open it, let it refresh, or sign in again).
2. Copy the fresh token from the desktop app's auth file into the orchestrator's auth-profiles. With `jq`, read the value out of the app's auth file and write it into every orchestrator auth-profiles file (see the multi-file trap below for "every").
3. Restart the gateway so it reloads auth state.

```bash
# Shape only. Read fresh token from the desktop app's auth file, write into one profile file.
NEW_REFRESH=$(jq -r '.tokens.refresh_token' "$HOME/.config/<provider-cli>/auth.json")
NEW_ACCESS=$(jq -r '.tokens.access_token'  "$HOME/.config/<provider-cli>/auth.json")

jq --arg r "$NEW_REFRESH" --arg a "$NEW_ACCESS" \
  '.profiles["<provider>:default"].refresh_token = $r
 | .profiles["<provider>:default"].access_token  = $a' \
  auth-profiles.json > auth-profiles.json.tmp && mv auth-profiles.json.tmp auth-profiles.json
```

**Durable fix:** This recurs whenever both clients refresh. The only real fix is to **not run two clients off the same OAuth identity.** Pick one client as the token owner for that provider. If you need the desktop app occasionally, accept that you will re-sync afterward, or give the orchestrator its own provider identity.

### Multi-file token sync

**Symptom:** Some agents work, others fail with `No API key found for provider <X>` even though "you just fixed auth." Failures correlate with which agent role is running.

**Cause:** The token is cached in several auth-profiles files (per-role plus a workspace copy) and you updated only one. The roles whose file you missed still hold the stale token.

**Recovery:** Update every cache in one pass, then restart once.

```bash
# Apply the same token rewrite to every auth-profiles file found.
for f in $(find "$HOME/.openclaw" -name 'auth-profiles.json' -not -path '*/node_modules/*'); do
  jq --arg r "$NEW_REFRESH" --arg a "$NEW_ACCESS" \
    '.profiles["<provider>:default"].refresh_token = $r
   | .profiles["<provider>:default"].access_token  = $a' \
    "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
systemctl --user restart openclaw-gateway
```

**Generalize:** Any time you rotate a provider token, enumerate every place the token is cached first, write them as a set, restart last. Never edit one and "check if it works," because a partial success hides the rest.

### API-key fallback shadowing the subscription

**Symptom:** You are on a flat-rate subscription but keep hitting rate limits as if you were on metered API billing. Usage shows up against an API key you forgot existed.

**Cause:** An `api_key`-type profile exists alongside the `oauth` profile for the same provider. The runtime silently falls back to the api_key profile (often on a transient OAuth hiccup) and then stays on it, burning metered key quota and tripping its rate limits.

**Recovery:** Remove the `api_key` profile for any provider where you use the subscription. Keep only the `oauth` profile.

```bash
# Inspect what profiles exist and their types.
jq '.profiles | map_values(.type)' auth-profiles.json

# Drop an api_key profile for a provider you run on subscription.
jq 'del(.profiles["<provider>:apikey"])' auth-profiles.json > t && mv t auth-profiles.json
```

If you genuinely need an API-key escape hatch, gate it deliberately rather than leaving it as a silent peer profile, because the runtime will use it the moment OAuth stumbles.

### auth-profiles schema (silent empty parse)

**Symptom:** Every run for a provider fails with "no profiles" or "No API key found," and nothing you do to the token values fixes it. The config looks fine to the eye.

**Cause:** The `profiles` container is the wrong shape. Recent orchestrator versions expect an object keyed by provider. An array, or correct keys nested one level off, parses as zero profiles with no validation error. A silent empty parse is indistinguishable from bad credentials if you only look at the token strings.

**Recovery:** Validate the shape, not the values.

```bash
# Should print "object". If it prints "array" or "null", the shape is wrong.
jq -r '.profiles | type' auth-profiles.json

# Should list your provider keys, e.g. "<provider>:default".
jq -r '.profiles | keys[]' auth-profiles.json
```

If `type` is not `object`, rewrite the container shape before you debug anything else. Generalize the lesson: **when an agent reports missing credentials, confirm the auth config parses to a non-empty profile set before assuming the token is wrong.**

### 402 "membership benefits" red herring

**Symptom:** A request returns `402` with a billing-flavored message about membership or benefits. It reads like a payment failure.

**Cause:** This is frequently not a billing problem. It is OAuth rate-limit exhaustion surfacing after the fallback chain runs out of options. The primary hit a subscription limit, the fallbacks were also unavailable or exhausted, and the final error happens to carry a 402 with billing-flavored copy.

**Recovery:** Before touching payment settings, check whether you are simply rate-limited and out of fallbacks.

```bash
# Was the primary rate-limited? Check recent gateway logs for the boot model line and rate-limit hits.
journalctl --user -u openclaw-gateway --since "15 min ago" | grep -iE "rate|429|402|fallback|next=none"
```

If the chain dead-ends at `next=none`, you are exhausted, not unpaid. Wait for the subscription window to reset, or add a working fallback. Do not "fix" billing for a rate-limit symptom.

### Fallback chain ordering

**Symptom:** When the primary hiccups, the agent silently lands on a less-preferred model and quality or behavior quietly degrades, with no obvious error.

**Cause:** Fallbacks are tried in list order. If a less-preferred model is listed first, a single primary failure routes there and stays. The agent keeps working, so nothing alerts you, but you are no longer on the model you think you are.

**Recovery:** Put the preferred fallback first. Keep the chain to providers you actually run, so a fallback hop does not change your billing surface or your behavior expectations.

```bash
jq '.agents.defaults.model' "$HOME/.openclaw/openclaw.json"
```

Order the `fallbacks` array best-first. A fallback hop should be a minor degradation, not a surprise model swap.

## Detection checklist: an agent suddenly 401s or 402s

When an agent that worked yesterday starts failing on auth, run these in order. They separate the traps above fast.

1. **What does the gateway think it is using?** Check the boot model line in logs. `openai/<id>` vs `openai-codex/<id>` (or equivalent) tells you whether a normalize pass or a fallback swapped your provider out from under you.
   ```bash
   journalctl --user -u openclaw-gateway --since "10 min ago" | grep -iE "agent model|fallback|next=none|401|402|429"
   ```
2. **Does the auth config parse to real profiles?** Confirm shape, not just values.
   ```bash
   jq -r '.profiles | type, (keys|join(","))' auth-profiles.json
   ```
3. **Is there an api_key profile shadowing the subscription?**
   ```bash
   jq '.profiles | map_values(.type)' auth-profiles.json
   ```
4. **Are all token caches in sync?** Compare the refresh token across every file. They must match.
   ```bash
   for f in $(find "$HOME/.openclaw" -name 'auth-profiles.json' -not -path '*/node_modules/*'); do
     printf '%s  ' "$f"
     jq -r '.profiles["<provider>:default"].refresh_token // "MISSING" | .[0:8]' "$f"
   done
   ```
   Different prefixes mean a partial update. Re-sync all of them.
5. **Did a desktop app for the same provider refresh recently?** If yes, the orchestrator's refresh token is almost certainly stale (rotating-token trap). Re-sync from the app's auth file.
6. **Is it a 402 with billing copy?** Treat it as rate-limit exhaustion first (red-herring trap). Confirm with the fallback/`next=none` check in step 1 before touching billing.

The mental model: **401 is almost always a token-sync problem, 402 is almost always a rate-limit-plus-exhausted-fallback problem.** Confirm before you act.

## Verification

After any auth change, verify before declaring victory:

```bash
# 1. Every cache parses to a non-empty object with the expected provider key.
for f in $(find "$HOME/.openclaw" -name 'auth-profiles.json' -not -path '*/node_modules/*'); do
  echo "$f"; jq -r '.profiles | type, (keys|join(","))' "$f"
done

# 2. No stray api_key profile for a subscription provider.
jq '.profiles | map_values(.type)' auth-profiles.json

# 3. Fallback chain is best-first and only on providers you run.
jq '.agents.defaults.model' "$HOME/.openclaw/openclaw.json"

# 4. Gateway came up on the provider you expect, not a normalized or fallback substitute.
systemctl --user restart openclaw-gateway
sleep 3
journalctl --user -u openclaw-gateway --since "1 min ago" | grep -i "agent model"

# 5. A live round-trip succeeds, not just a clean boot.
#    Send one trivial prompt through the main agent and confirm a real completion, not a 401/402.
```

Token files should never be tracked by git. Confirm:

```bash
git ls-files | grep -i 'auth-profiles\|auth.json' || echo "clean"
```

Expected result: `clean`.

## Gotchas

1. **A silent empty parse looks exactly like bad credentials.** The wrong `profiles` shape and a revoked token produce nearly identical "no credentials" errors. Always check `jq '.profiles | type'` first. It is the cheapest disambiguation you have.

2. **Two clients, one OAuth identity, is a recurring outage.** The rotating-token trap is not a one-time fix. As long as both a desktop app and the orchestrator refresh the same identity, you will re-sync periodically. Design it out by picking a single token owner per provider.

3. **Partial token updates hide in plain sight.** If you update one auth-profiles file and "it works," you tested the wrong agent role. Always write the whole set, then restart once.

4. **402 is usually a lie about billing.** It maps to rate-limit exhaustion after the fallback chain empties far more often than to an actual payment failure. Check the chain before you check the invoice.

5. **Fallback order is a silent quality knob.** A misordered chain never errors. It just quietly serves a worse model. Audit `fallbacks` order whenever behavior feels off for no logged reason.

6. **Upgrades can rewrite auth and provider config.** Orchestrator upgrades have been observed to normalize provider prefixes and reset plugin or auth config. After any upgrade, re-run the detection checklist before assuming your token rotated.

7. **Never paste a real token into a doc, issue, or transcript.** Show the shape with placeholders, as above. The token files are credentials, live outside the repo, and are gitignored. See [secret management](../security/secret-management.md) for the full discipline.

## Related

- [multi-model orchestration](multi-model-orchestration.md) - why subscriptions over API keys at the model-selection level, and the fallback chain in context
- [secret management](../security/secret-management.md) - where token files live, permissions, and keeping credentials out of public artifacts
- [claude-cli to ACP migration](claude-cli-to-acp-migration.md) - why the Claude subscription lane is not a raw OAuth backend anymore
- [Claude Code via tmux relay](claude-code-tmux-relay.md) - how the Claude subscription is reached through an interactive harness lane instead of stored OAuth state
