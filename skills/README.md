# Skills

Working area for public skills pulled out of the private OpenClaw setup.

The rule: only ship skills that are already generic or can be sanitized without dragging private paths, browser profiles, tokens, hostnames, or machine-specific assumptions into the repo.

## Best candidates

### Phase 1: ready soon

1. **self-learning-agent**
   - Why: strong fit for the cookbook, shows the memory-card architecture clearly
   - Risk: low
   - Work: replace personal references with generic workspace paths and tighten wording around tool assumptions

2. **last30days**
   - Why: useful research workflow, easy to understand
   - Risk: low
   - Work: make the source mix configurable and trim local references

3. **content-scrubber**
   - Why: genuinely useful and easy to explain
   - Risk: low
   - Work: ship a generic plugin structure with sample config and tests

### Phase 2: sanitize harder

4. **ops-deck-lite**
   - Why: one of the stronger stack patterns here
   - Risk: medium
   - Work: replace hardcoded ports and deployment assumptions with placeholders or defaults

5. **note**
   - Why: useful workflow pattern
   - Risk: medium
   - Work: generalize away from local inbox and sync paths

6. **frontend-design**
   - Why: distinctive and opinionated
   - Risk: medium
   - Work: remove machine-specific assumptions and tighten the output contract

## Keep private for now

These are still too tied to current machine state, auth state, or local subscriptions:

- **research**
- **perplexity**
- **media-cli**
- **media-cli-local**
- **youtube**

## Recommended order

If we want the first public drop to feel coherent, start with:

1. `self-learning-agent`
2. `content-scrubber`
3. `last30days`
4. `ops-deck-lite`

That set says something real about the stack: persistent memory, safer outputs, repeatable research, and better agent ergonomics.

## Next move

Create one folder per selected skill and rewrite each as a public version instead of copying the private one verbatim.
