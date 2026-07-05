# MCP READMEs: All Five Clients

> Every MCP repo in the catalog ships with the same five-block README. If a setup block is missing, half your potential users walk away. Five clients, one shape, copy-paste tested against each.

## What this is

A README pattern for any MCP server published from this stack. Every README contains:

1. A capabilities summary (tools, confirmation-gated tools).
2. An install block (npm global + from source).
3. A configuration block (env vars, table of options).
4. **Five client setup blocks**, in this exact order: Claude Desktop, Claude Code, OpenClaw, Hermes Agent, Codex CLI.
5. A "Remote service via SSH tunnel" block for any MCP that targets a backend on a different host.
6. Example prompts + their resolved tool calls.

The five-client section is the part this guide is about. The order is not arbitrary; it goes from most-restrictive (Desktop, JSON config only) to most-flexible (Codex CLI, command-line registration).

## Why this way

A MCP without setup instructions for the client the reader uses is, in practice, an unmaintained MCP. Even if every block is "the same idea, different syntax," writing them all out matters:

- **Claude Desktop** users only have a JSON config file. They cannot run a CLI registration.
- **Claude Code** users prefer `claude mcp add` and want `--scope user` so the MCP works from any directory.
- **OpenClaw** users have to know whether to point at the npm binary or a `dist/index.js`, and which `systemctl` line to run after.
- **Hermes Agent** users edit YAML, not JSON, and reload from inside a session.
- **Codex CLI** users use `codex mcp add` and the result lands in `~/.codex/config.toml`.

Skipping any of these blocks means users from that client open an issue asking for setup instructions, and you (or they) end up writing it in the GitHub issue thread instead of the README.

## Prerequisites

- A working MCP server you control
- A binary that can be invoked as `<mcp-name>` (npm-global) or `node dist/index.js` (from-source)
- A documented set of env vars

## Before / After

**Before:** the README has one setup block (usually Claude Desktop) and a paragraph saying "should also work with other MCP clients." Issues land asking "how do I set this up in [their client]?"

**After:** all five blocks present, each copy-pasted into a fresh test environment, each verified to register the MCP and list its tools. Issues land asking about features, not setup.

## Implementation

### Block 1: Claude Desktop

This is the most-restrictive client. JSON config file, no CLI registration.

```markdown
### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

\`\`\`json
{
  "mcpServers": {
    "<mcp-shortname>": {
      "command": "<mcp-binary-name>",
      "env": {
        "<MCP_REQUIRED_VAR>": "value",
        "<MCP_OPTIONAL_VAR>": "value"
      }
    }
  }
}
\`\`\`
```

Linux is not officially supported by Claude Desktop. Do not include a Linux path here; it confuses users on Linux into thinking it is supposed to work.

### Block 2: Claude Code

```markdown
### Claude Code

\`\`\`bash
claude mcp add <mcp-shortname> \
  --env <MCP_REQUIRED_VAR>=value \
  --env <MCP_OPTIONAL_VAR>=value \
  -- <mcp-binary-name>
\`\`\`

Add `--scope user` to make it available from any directory instead of only the current project.
```

The `--` separator before the binary name is the part most people miss. Without it, the env vars get parsed as arguments to `claude mcp add`.

### Block 3: OpenClaw

OpenClaw needs two variants because of how the gateway picks up new servers, and because users equally often run from `dist/` or from a global npm install:

```markdown
### OpenClaw

If you're running from a source checkout instead of the npm-installed binary, point `command`/`args` at the built `dist/index.js`:

\`\`\`bash
openclaw mcp set <mcp-shortname> '{
  "command": "node",
  "args": ["/absolute/path/to/<mcp-repo>/dist/index.js"],
  "env": {
    "<MCP_REQUIRED_VAR>": "value"
  }
}'
\`\`\`

Or, with the global npm install:

\`\`\`bash
openclaw mcp set <mcp-shortname> '{
  "command": "<mcp-binary-name>",
  "env": {
    "<MCP_REQUIRED_VAR>": "value"
  }
}'
\`\`\`

Then restart the OpenClaw gateway so the new server is picked up:

\`\`\`bash
systemctl --user restart openclaw-gateway
openclaw mcp list   # confirm "<mcp-shortname>" is registered
\`\`\`
```

### Block 4: Hermes Agent

```markdown
### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads MCP config from `~/.hermes/config.yaml` under the `mcp_servers` key. Add an entry:

\`\`\`yaml
mcp_servers:
  <mcp-shortname>:
    command: "<mcp-binary-name>"
    env:
      <MCP_REQUIRED_VAR>: "value"
\`\`\`

Or, when running from a source checkout instead of the global npm install:

\`\`\`yaml
mcp_servers:
  <mcp-shortname>:
    command: "node"
    args: ["/absolute/path/to/<mcp-repo>/dist/index.js"]
    env:
      <MCP_REQUIRED_VAR>: "value"
\`\`\`

Then reload MCP from inside a Hermes session:

\`\`\`
/reload-mcp
\`\`\`
```

### Block 5: Codex CLI

```markdown
### Codex CLI

[Codex CLI](https://github.com/openai/codex) registers MCP servers via `codex mcp add`:

\`\`\`bash
codex mcp add <mcp-shortname> \
  --env <MCP_REQUIRED_VAR>=value \
  -- <mcp-binary-name>
\`\`\`

Or, when running from a source checkout:

\`\`\`bash
codex mcp add <mcp-shortname> \
  --env <MCP_REQUIRED_VAR>=value \
  -- node /absolute/path/to/<mcp-repo>/dist/index.js
\`\`\`

Codex writes the entry to `~/.codex/config.toml` under `[mcp_servers.<mcp-shortname>]`. Verify with:

\`\`\`bash
codex mcp list
\`\`\`
```

### Optional: SSH tunnel block

If the MCP targets a backend that often lives on a different host (a media server on a Windows box, a Postiz instance in a container), add a tunnel example after the five client blocks:

```markdown
### Remote service via SSH tunnel

If the service binds to `localhost` on a remote host, forward the port before starting your MCP client:

\`\`\`bash
ssh -N -L 8096:localhost:8096 mediaserver
\`\`\`

Then point `<MCP_URL>` at `http://localhost:8096`. The MCP itself has no SSH logic - it just talks HTTP.
```

## Verification

Two checks. The first is automated, the second is manual.

**Automated:** every README has all five client headers:

```bash
for repo in ~/repos/*-mcp; do
  [ -f "$repo/README.md" ] || continue
  echo "=== $(basename "$repo") ==="
  for client in "Claude Desktop" "Claude Code" "OpenClaw" "Hermes Agent" "Codex CLI"; do
    grep -q "### $client" "$repo/README.md" \
      && echo "  $client: OK" \
      || echo "  $client: MISSING"
  done
done
```

A healthy catalog returns `OK` on all five for every MCP. Anything else is a documentation gap.

**Manual:** copy each setup block into a fresh client and confirm tool listing works:

```bash
# Claude Code
claude mcp add jellyfin --env JELLYFIN_URL=... --env JELLYFIN_API_KEY=... -- jellyfin-mcp
claude mcp list | grep jellyfin

# OpenClaw
openclaw mcp set jellyfin '{...}'
systemctl --user restart openclaw-gateway
openclaw mcp list | grep jellyfin

# Codex CLI
codex mcp add jellyfin --env JELLYFIN_URL=... --env JELLYFIN_API_KEY=... -- jellyfin-mcp
codex mcp list | grep jellyfin

# Claude Desktop and Hermes Agent: edit the config file by hand, restart the client, verify the MCP appears in the tool palette.
```

## Gotchas

**Claude Desktop on Linux is unofficial.** Some users will be running Linux Claude Desktop ports. Do not document a Linux config path; it varies by port. If users ask, point at Claude Code instead.

**`claude mcp add` without `--` parses everything after the env block as more flags.** This is the number one setup mistake. Always show the `--` before the binary name.

**OpenClaw `mcp set` is JSON-as-a-string, single-quoted, no trailing comma.** The shell quoting is fiddly. Show the full single-quoted JSON in the README rather than relying on the user to escape it themselves.

**Hermes Agent's `/reload-mcp` is in-session, not a CLI command.** A new contributor will reach for `hermes reload` or `hermes mcp reload`; those do not exist. Make the in-session reload explicit.

**Codex CLI writes TOML, not JSON.** A user who is comfortable hand-editing Claude Desktop's JSON will look for the equivalent file and find `config.toml`. Mentioning the file path saves them the lookup.

**The "binary name" in the npm-global path is the `bin` field in `package.json`, not the package name.** If you publish `@solomonneas/jellyfin-mcp` and the binary is `jellyfin-mcp`, the README needs to say `command: "jellyfin-mcp"`, not `command: "@solomonneas/jellyfin-mcp"`. Verify with `npm view <pkg> bin`.

**Source-checkout paths need to be absolute.** A relative path works in a shell but not when the MCP is launched by a daemon. Always show `/absolute/path/to/<repo>/dist/index.js`, never `./dist/index.js`.

**Confirmation-gated tools should be noted in the capabilities summary, not buried in the tool list.** Users who see the tools table for the first time should know upfront that `delete_*`, `restart`, and `shutdown` need `confirm: true`.

## Templates

This guide is itself the template. The reference implementation is in [`jellyctrl/README.md`](https://github.com/lidless-labs/jellyctrl/blob/main/README.md). Lift the structure, swap the placeholders.

## Related

- [`mcp-catalog.md`](mcp-catalog.md) - the MCP servers that follow this README pattern
- [`repo-redeploy.md`](repo-redeploy.md) - how source-checkout MCPs stay up to date so the path in the README actually works
- [`../ai-stack/skills-development.md`](../ai-stack/skills-development.md) - skill patterns that wrap a single MCP tool
