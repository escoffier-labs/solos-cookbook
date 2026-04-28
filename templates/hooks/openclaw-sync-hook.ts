// OpenClaw plugin skeleton: synchronous tool_result_persist substitution hook.
//
// Install layout:
//   ~/.openclaw/workspace/.openclaw/extensions/<plugin-id>/
//   ├── package.json           // "openclaw": { "extensions": ["./index.ts"] }
//   ├── openclaw.plugin.json   // { id, name, description, configSchema }
//   └── index.ts               // this file
//
// CRITICAL: tool_result_persist is STRICTLY SYNCHRONOUS. The runner checks
// isPromiseLike(out) on the handler return and silently drops Promise
// returns with a warning in the gateway log:
//
//   "[hooks] tool_result_persist handler from <pluginId> returned a Promise;
//    this hook is synchronous and the result was ignored."
//
// If you need async work (file I/O, external API call, anything awaited)
// you have three options:
//   1. Pre-load inputs at plugin registration time, cache in module scope.
//   2. Pivot to before_tool_call (async-safe, can rewrite tool params).
//   3. Pivot to before_message_write (also sync, broader event surface).

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type Config = {
  // Add your config fields here. Mirror them in openclaw.plugin.json.
  enabled?: boolean;
};

// Module-scope cache. Pre-load anything you need at registration time so the
// sync handler never has to await.
let RULES: Array<{ pattern: RegExp; replacement: string }> = [];

function loadRulesSync(): typeof RULES {
  // Read files, parse configs, build state — synchronously, at boot.
  // Do NOT do this work inside the hook handler.
  return [
    // { pattern: /<SOME_REGEX>/g, replacement: "<REDACTED>" },
  ];
}

// Optional: capture-in-before, read-in-persist pattern. Useful when the
// substitution logic needs to know which command produced the tool result.
const commandsByToolCallId = new Map<string, string>();

export default function plugin(api: OpenClawPluginApi): void {
  const cfg = (api.config as Config) ?? {};
  if (cfg.enabled === false) {
    api.logger.info("<plugin-id>: disabled by config");
    return;
  }

  // Pre-load all inputs HERE, not inside the hook handler.
  RULES = loadRulesSync();
  api.logger.info(`<plugin-id>: loaded ${RULES.length} rules`);

  // ── Capture: record the command that produced each tool call. ──
  // before_tool_call IS async-safe, but doing only sync work keeps it cheap.
  api.on("before_tool_call", async (event, _ctx) => {
    if (event.toolName !== "exec") return;
    const command = (event.params as { command?: string } | undefined)?.command;
    if (event.toolCallId && command) {
      commandsByToolCallId.set(event.toolCallId, command);
    }
  });

  // ── Substitute: rewrite the persisted toolResult message. SYNC ONLY. ──
  api.on("tool_result_persist", (event, _ctx) => {
    const toolCallId = event.toolCallId;
    const command = toolCallId ? commandsByToolCallId.get(toolCallId) : undefined;
    if (toolCallId) commandsByToolCallId.delete(toolCallId);

    const message = event.message;
    // Anthropic-style content shape: [{ type: "text", text: "..." }]
    const blocks = (message?.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = blocks.find((b) => b.type === "text")?.text;
    if (!text) return; // nothing to substitute

    let rewritten = text;
    for (const rule of RULES) {
      rewritten = rewritten.replace(rule.pattern, rule.replacement);
    }
    if (rewritten === text) return; // no change, leave the message alone

    // Returning { message } substitutes what gets persisted and what the
    // next LLM turn sees. The shape mirrors what the runner expects.
    return {
      message: {
        ...message,
        content: [{ type: "text", text: rewritten }],
      },
    };
    // ⚠️  Do NOT return a Promise. Do NOT mark this handler async.
    //    The runner will silently drop the result and log a warning.
  });
}
