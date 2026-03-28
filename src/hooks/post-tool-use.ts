#!/usr/bin/env node

/**
 * Claude Code PostToolUse hook
 *
 * Broadcasts tool use events to other connected machines so they
 * stay aware of what Claude is doing on this machine.
 *
 * Install by adding to .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/claude-swarm/dist/hooks/post-tool-use.js"
 *       }]
 *     }]
 *   }
 * }
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { SyncMessage } from "../shared/types.js";
import { timestamp } from "../shared/utils.js";
import { getMachineIdentity } from "../shared/machine-identity.js";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    const raw = await readFile("/dev/stdin", "utf-8");
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const configPath = join(input.cwd, ".claude-swarm.json");
  if (!existsSync(configPath)) {
    process.exit(0);
  }

  // Only broadcast significant tool uses
  const significantTools = ["Edit", "Write", "Bash", "NotebookEdit"];
  if (!significantTools.includes(input.tool_name)) {
    process.exit(0);
  }

  try {
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const identity = await getMachineIdentity();

    // Quick fire-and-forget WebSocket message
    const ws = new WebSocket(config.serverUrl);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 3000);

      ws.on("open", () => {
        const msg: SyncMessage = {
          type: "session-event",
          roomId: config.roomId,
          peerId: identity.peerId,
          timestamp: timestamp(),
          payload: {
            event: "tool-use",
            sessionId: input.session_id,
            data: {
              tool: input.tool_name,
              input: summarizeToolInput(input.tool_name, input.tool_input),
            },
          },
        };
        ws.send(JSON.stringify(msg));
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch {
    // Silent failure — don't block Claude Code
  }

  process.exit(0);
}

function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
      return `Edited ${input.file_path}`;
    case "Write":
      return `Wrote ${input.file_path}`;
    case "Bash":
      return `Ran: ${String(input.command).slice(0, 100)}`;
    default:
      return `Used ${tool}`;
  }
}

main();
