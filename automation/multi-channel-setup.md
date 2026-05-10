# Multi-Channel Setup

How OpenClaw handles multiple messaging platforms simultaneously, session isolation between channels, and practical patterns for Discord, Telegram, and Signal.

**Tested on:** OpenClaw 2026.4.x with Discord + Telegram + Signal running concurrently
**Last updated:** 2026-04-19

---

## How Multi-Channel Works

OpenClaw's gateway acts as a message router. When a message arrives from any channel (Discord, Telegram, Signal, WhatsApp, etc.), it goes through the same pipeline:

```
1. Channel plugin normalizes the message into standard format
2. Access control checks (allowlist, sender verification)
3. Session resolution (determines session key from channel + chat context)
4. Routes to the agent runtime
5. Response routes back through the correct channel plugin
```

The key insight: **each channel/chat gets its own session.** Your Telegram DM, Discord #general, and Discord #dev-chat are three completely separate sessions with separate conversation histories and context windows. The only shared state is the workspace files (MEMORY.md, SOUL.md, etc.) that get loaded into every session.

## Session Isolation

### How Session Keys Work

Session keys are derived from the channel context:

| Platform | Session Key Pattern | Example |
|----------|-------------------|---------|
| Telegram DM | `agent:main:telegram:dm:<user_id>` | Your private chat |
| Discord Channel | `agent:main:discord:channel:<channel_id>` | #general |
| Discord Thread | `agent:main:discord:thread:<thread_id>` | Thread in #dev |
| Discord DM | `agent:main:discord:dm:<user_id>` | Bot DM |
| Signal | `agent:main:signal:<chat_id>` | Signal chat |

### What's Isolated

- Conversation history (messages from one channel don't appear in another)
- Context window (token usage is per-session)
- Compaction state (one chatty channel compacting doesn't affect others)

### What's Shared

- Workspace files (MEMORY.md, SOUL.md, AGENTS.md, TOOLS.md, etc.)
- Knowledge cards and daily memory logs
- Agent configuration (model, tools, permissions)
- Cron jobs (fire into their configured session target)

### Practical Impact

If you tell your agent something important in a Telegram DM, your Discord channel session doesn't know about it unless:
1. The agent wrote it to a memory file (knowledge card or daily log)
2. The Discord session searches memory and finds it
3. You repeat it in the Discord channel

This is by design. Channel isolation prevents context bleeding, which is important for group chats where different people are in different channels.

## Session Lifecycle

### Daily Reset

Sessions reset on a configurable schedule (default: daily at 4am local time):

```json
{
  "agents": {
    "defaults": {
      "reset": {
        "mode": "daily",
        "atHour": 4
      }
    }
  }
}
```

Every morning, every session starts fresh. No infinite context buildup. Important information persists through workspace files.

### Mid-Session Compaction

If a session fills its context window before the daily reset, compaction kicks in:

```json
{
  "compaction": {
    "mode": "safeguard",
    "memoryFlush": {
      "enabled": true
    }
  }
}
```

- `safeguard` mode only compacts when approaching context limits
- `memoryFlush` writes a summary to memory files before trimming
- The session continues with compressed history

### Context Pruning

Tool outputs get pruned automatically to prevent context bloat:

```json
{
  "contextPruning": {
    "mode": "cache-ttl",
    "ttl": "5m"
  }
}
```

Large tool results (file reads, API responses) get soft-trimmed after 5 minutes. On hard clear, they become `[tool output pruned]`. This keeps your context window focused on the current conversation, not stale tool outputs from 20 messages ago.

## Channel-Specific Configuration

### Discord

Discord has the richest feature set: channels, threads, reactions, embeds, polls, voice status.

**Session per channel:** Each text channel is its own session. Threads within channels get their own sessions too.

**Group chat behavior:** In Discord channels with multiple users, your agent receives every message. Configure it to be selective about when to respond:

- Respond when directly mentioned (@agent) or asked a question
- React with emoji to acknowledge without cluttering the chat
- Stay silent when humans are having their own conversation
- Avoid responding multiple times to the same message

**Formatting:** Discord supports markdown but NOT markdown tables. Use bullet lists instead. Wrap multiple links in `<>` to suppress embeds.

**Thread spawning:** Sub-agents can be spawned into Discord threads using `sessions_spawn` with `thread: true`, giving them their own isolated conversation space.

### Telegram

Telegram is simpler: DMs and group chats.

**DMs:** The most common setup. One-on-one conversation with your agent. Full context, no noise from other users.

**Group chats:** Similar to Discord channels. Agent receives every message, needs to be selective about responses.

**Formatting:** Telegram supports basic markdown. No tables (use bullet lists). No headers (use **bold** or CAPS for emphasis).

### Signal

Signal provides secure messaging with basic formatting support.

**Privacy:** Signal messages are end-to-end encrypted in transit. OpenClaw processes them on your machine.

**Formatting:** Minimal markdown support. Keep messages simple.

### Running Multiple Channels

Channels are plugins. Register them in `plugins.allow` and `plugins.entries`, then configure per-channel in `channels.*`:

```json
{
  "plugins": {
    "allow": ["telegram", "discord", "signal", "..."],
    "entries": {
      "telegram": { "enabled": true },
      "discord":  { "enabled": true },
      "signal":   { "enabled": true }
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "token": "your-discord-bot-token",
      "allowedGuilds": ["guild-id"]
    },
    "telegram": {
      "enabled": true,
      "token": "your-telegram-bot-token",
      "allowedUsers": ["your-user-id"]
    },
    "signal": {
      "enabled": true
    }
  }
}
```

**Schema break heads-up (2026-04-14):** The `2026.4.14` release removed `ackReaction`, `typingIndicator`, and scalar-streaming options from the telegram channel schema. `openclaw doctor --fix` is a stub for this - migrate with `jq` before restarting the gateway, or the gateway crash-loops on validation.

## ACP Escalation via Discord Thread

Since the [April 2026 claude-cli removal](../ai-stack/claude-cli-to-acp-migration.md), Claude Opus reaches you via ACP, not the main agent slot. The cleanest UX is a dedicated Discord thread routed straight to the ACP session:

```json
{
  "channels": {
    "discord": {
      "routing": {
        "threads": {
          "acp-opus": { "agentId": "acp-claude" }
        }
      }
    }
  }
}
```

Create a Discord thread named `acp-opus`. Any message posted there spins up a fresh ACP session with Claude Code; subsequent messages continue it. The session is fully isolated from your main GPT 5.5 sessions.

**Why a thread and not a channel:** Threads auto-archive after inactivity, which matches ACP's short-lived-session model. Channels stick around and invite people to expect persistence that ACP doesn't offer.

## Cross-Channel Memory Patterns

### The Problem

Important context gets trapped in one channel's session. You discuss a decision in Telegram, but when someone asks about it in Discord, the agent doesn't know.

### The Solution: Write It Down

Train your agent (via AGENTS.md) to proactively write important decisions, facts, and context to memory files. This makes them searchable across all channels:

```markdown
# In AGENTS.md
When something important comes up in any conversation:
1. Write it to a knowledge card if it's a permanent fact
2. Write it to today's daily log if it's a session note
3. Don't rely on conversation history for cross-channel continuity
```

### Memory Sweep Cron

Set up a periodic cron job that reviews recent sessions across all channels and distills important information into knowledge cards:

```json
{
  "name": "memory-sweep",
  "schedule": { "kind": "cron", "expr": "0 */6 * * *", "tz": "America/New_York" },
  "payload": {
    "kind": "agentTurn",
    "message": "Review recent sessions across all channels. Extract any important decisions, facts, or context worth persisting. Create or update knowledge cards as needed.",
    "model": "openai-codex/gpt-5.5"
  },
  "delivery": { "mode": "none" },
  "sessionTarget": "isolated"
}
```

## Local-First Message Archives Beyond OpenClaw

OpenClaw gives you **live transport and session routing**. It is not the same thing as a durable, queryable archive of everything that happened across every chat surface.

If you want that second layer, pair your agent setup with the crawl tools Peter Steinberger and Vincent Koc have been building around the same local-first idea: mirror message history into SQLite, index it well, and keep the archive portable.

### Why This Matters

Channel sessions are great for live work, but they are not enough for archaeology:

- You want to query old conversations with SQL or FTS, not hope platform search works
- You want retention you control, not whatever Discord or Slack decides to surface
- You want a backup that can move across machines
- You want read-only local inspection without granting every machine live bot credentials

### The Crawl Pattern

The pattern is simple and strong:

1. Pull or ingest message history from the platform
2. Normalize it into a local SQLite archive
3. Add FTS indexes and structured metadata for search/querying
4. Optionally publish private Git-backed snapshots so other machines can clone the archive and query it locally

That gives you something OpenClaw itself does not try to be: a local message warehouse.

### Relevant Tools

- **discrawl**: Discord archive crawler. Mirrors guilds, channels, threads, members, and message history into SQLite. Supports private Git-backed snapshot sync, which is the killer feature if you want a read-only searchable archive on multiple machines without distributing Discord bot credentials everywhere.
- **slacrawl**: Slack archive crawler. Same general shape for Slack: local SQLite, FTS, structured querying, and Git-backed archive publishing for portable workspace history.
- **wacrawl**: WhatsApp Desktop archaeology. Copies the local WhatsApp Desktop SQLite state into its own read-only archive so chats are searchable outside the app.
- **imsg**: Local iMessage/SMS access on macOS. Reads Messages.app's local database and exposes chats/history/watch surfaces for automation. Not the same sync model as discrawl/slacrawl, but it belongs in the same toolbox when you want Apple Messages to be queryable and scriptable.

You can think of OpenClaw as the live operator and the crawl tools as the historical record.

### Practical Fit with OpenClaw

A good split looks like this:

- **OpenClaw** handles message routing, session isolation, agent actions, and real-time replies
- **discrawl / slacrawl / wacrawl / imsg** handle durable local archives for later search, audits, memory extraction, and offline analysis
- **Memory files** keep the distilled facts and decisions
- **SQLite archives** keep the raw conversation corpus when you need the receipts

That combination is much better than trying to force one tool to do all four jobs.

### Where Git-Backed Snapshots Help

Git-backed archive sync is especially useful when:

- one machine has the live credentials, but several machines need read-only access
- you want versioned backups of the archive itself
- you want local queryability even while offline
- you want to keep org memory portable and inspectable without relying on a SaaS search box

For a serious multi-channel setup, this is the missing layer between ephemeral chat sessions and distilled long-term memory.

## Access Control

### Per-Channel Allowlists

Restrict who can interact with your agent on each platform:

```json
{
  "channels": {
    "discord": {
      "allowedGuilds": ["your-server-id"],
      "allowedChannels": ["channel-id-1", "channel-id-2"]
    },
    "telegram": {
      "allowedUsers": ["your-user-id", "trusted-friend-id"]
    }
  }
}
```

### Group Chat Safety

In group chats, your agent sees messages from people you may not fully trust. Key rules:

1. **Use your strongest model** for orchestration in group contexts (prompt injection resistance)
2. **Restrict autonomous actions** in group chats (don't let group messages trigger email sends or file modifications)
3. **Don't share private context** in group responses (the agent has access to your files, calendar, etc., but shouldn't leak them)
4. **Be conservative with tool use** in group settings

## The Same Model Everywhere (Mostly)

The main agent model is set at the gateway level, not per channel. Whether messages come from Telegram, Discord, or Signal, the same model handles them. Variations:

- **Sub-agents** get their own model assignment
- **Per-session overrides** via `/model` command
- **Cron jobs** can specify a different model
- **ACP thread routing** sends messages to a different agent entirely (see above)

**Stickiness warning.** One OpenAI 503 on `gpt-5.5` once pinned a cron channel to `gpt-5.3-codex` via the internal `auto` override system for four days. `/reset` does not reliably clear `auto` overrides. Use `/model` to re-pin with `user` source when this happens. The incident is memorable because the cheaper fallback silently handled four days of work at lower quality before anyone noticed.

## Verification

```bash
# Check configured channels
echo "=== Channel Configuration ==="
jq '.channels | to_entries | map({name: .key, enabled: .value.enabled})' ~/.openclaw/openclaw.json

# Check channel plugins are allowed + enabled
echo ""
echo "=== Channel Plugins ==="
jq '.plugins.entries | to_entries | map(select(.key as $k | ["telegram","discord","signal"] | index($k))) | map({plugin: .key, enabled: .value.enabled})' ~/.openclaw/openclaw.json

# Check session reset config
echo ""
echo "=== Reset Configuration ==="
jq '.agents.defaults.reset // {}' ~/.openclaw/openclaw.json

# Check ACP thread routing (if configured)
echo ""
echo "=== Discord Thread Routing ==="
jq '.channels.discord.routing.threads // {}' ~/.openclaw/openclaw.json
```

## Gotchas

1. **Channel sessions are independent.** Telling the agent something in Telegram doesn't make it available in Discord. Use memory files for cross-channel persistence.

2. **Daily reset clears ALL sessions.** Every channel starts fresh at the configured reset hour. Important context from yesterday must be in memory files.

3. **Group chats burn more tokens.** Your agent processes every message in a group chat, even ones it doesn't respond to. A chatty Discord channel can burn through context faster than a quiet DM.

4. **Discord threads are separate sessions.** A thread in #general is NOT the same session as #general itself. Context doesn't flow between them.

5. **Platform formatting differs.** What looks great on Discord (embeds, reactions, threads) doesn't translate to Telegram or Signal. Write your AGENTS.md formatting rules per platform.

6. **Concurrent messages from different channels.** If someone messages you on Telegram and Discord at the same time, both are handled as separate sessions. No conflict, no queue blocking. The gateway routes them independently.

7. **`plugins.allow` is exclusive.** Even bundled channel plugins (`telegram`, `discord`, `signal`) get blocked if they're not in the whitelist. One symptom of the channel being "silently broken" after an upgrade is that `plugins.allow` was regenerated without your channel in it. Check with `jq '.plugins.allow' ~/.openclaw/openclaw.json` before debugging deeper.

8. **`message_sending` hooks scrub ALL outgoing messages.** Including DMs to the owner. No clean way to distinguish DM vs group in the event context. For artifact scrubbing (PII redaction, etc.), a CLI script at the outbound boundary is a cleaner seam than a message hook.
