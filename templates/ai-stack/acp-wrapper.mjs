#!/usr/bin/env node
import { spawn } from "node:child_process";

const command = process.env.ACP_COMMAND ?? "claude";
const args = (process.env.ACP_ARGS ?? "mcp serve").split(" ").filter(Boolean);

const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    // Keep wrapper-specific env additions explicit and public-safe.
    AGENT_WORKSPACE: process.env.AGENT_WORKSPACE ?? process.cwd()
  }
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
