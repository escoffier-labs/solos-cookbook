#!/usr/bin/env node
// ACPX spawn wrapper: starts the Claude ACP adapter with Claude Code pinned to one model.
// Point plugins.entries.acpx.config.agents.<id>.command at this file (it must be executable).
// Do not export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN here: Claude Code should
// authenticate from its own login in ~/.claude/, and an env token overrides that login.
import { spawn } from "node:child_process";

const command = process.env.ACP_COMMAND ?? "npx";
const args = (process.env.ACP_ARGS ?? "-y @agentclientprotocol/claude-agent-acp")
  .split(" ")
  .filter(Boolean);

const env = {
  ...process.env,
  // Keep wrapper-specific env additions explicit and public-safe.
  AGENT_WORKSPACE: process.env.AGENT_WORKSPACE ?? process.cwd()
};

// ANTHROPIC_MODEL is the env var Claude Code honors for a primary-model pin.
if (process.env.ACP_MODEL) {
  env.ANTHROPIC_MODEL = process.env.ACP_MODEL;
}

const child = spawn(command, [...args, ...process.argv.slice(2)], {
  stdio: "inherit",
  env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
