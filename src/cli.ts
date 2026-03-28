#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SyncServer } from "./server/index.js";
import { SyncClient } from "./client/sync-client.js";
import { getMachineIdentity, formatMachineId, generateMachineContext, MachineIdentity } from "./shared/machine-identity.js";
import { generateRoomId, log } from "./shared/utils.js";
import { DEFAULT_PORT, RoomConfig, PeerInfo } from "./shared/types.js";

const program = new Command();

program
  .name("claude-multi-boot")
  .description("Sync Claude Code sessions across multiple machines")
  .version("0.1.0");

// ── serve ──────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the relay server")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const server = new SyncServer();
    server.start(port);

    console.log(chalk.green.bold("\n  claude-multi-boot relay server\n"));
    console.log(`  Listening on: ${chalk.cyan(`ws://0.0.0.0:${port}`)}`);
    console.log(`  Share this address with other machines to connect.\n`);

    process.on("SIGINT", () => { server.stop(); process.exit(0); });
  });

// ── init ───────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize multi-boot sync for a project")
  .option("-s, --server <url>", "Relay server URL", `ws://localhost:${DEFAULT_PORT}`)
  .option("-r, --room <id>", "Room ID (generates one if not provided)")
  .option("-l, --label <name>", "Label for this machine")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const roomId = opts.room ?? generateRoomId();
    const identity = await getMachineIdentity(opts.label);

    const config: RoomConfig & { machine: MachineIdentity } = {
      roomId,
      serverUrl: opts.server,
      projectPath,
      syncPaths: [
        "CLAUDE.md",
        ".claude/settings.json",
        ".claude/settings.local.json",
      ],
      machine: identity,
    };

    const configPath = join(projectPath, ".claude-multi-boot.json");
    await writeFile(configPath, JSON.stringify(config, null, 2));

    console.log(chalk.green.bold("\n  claude-multi-boot initialized!\n"));
    console.log(`  Config:   ${chalk.dim(configPath)}`);
    console.log(`  Room ID:  ${chalk.cyan(roomId)}`);
    console.log(`  Server:   ${chalk.cyan(opts.server)}`);
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log();
    console.log(chalk.dim("  On another machine, run:"));
    console.log(`  ${chalk.white(`claude-multi-boot init --server ${opts.server} --room ${roomId}`)}`);
    console.log();
    console.log(chalk.dim("  Then start syncing:"));
    console.log(`  ${chalk.white("claude-multi-boot sync")}`);
    console.log();
  });

// ── sync ───────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Start syncing this machine with the room")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const configPath = join(projectPath, ".claude-multi-boot.json");

    if (!existsSync(configPath)) {
      console.error(chalk.red("No .claude-multi-boot.json found. Run 'claude-multi-boot init' first."));
      process.exit(1);
    }

    const config = JSON.parse(await readFile(configPath, "utf-8")) as RoomConfig & { machine: MachineIdentity };
    const identity = await getMachineIdentity();

    console.log(chalk.green.bold("\n  claude-multi-boot sync\n"));
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(config.roomId)}`);
    console.log(`  Server:   ${chalk.cyan(config.serverUrl)}`);
    console.log();

    const client = new SyncClient(config, (peers: PeerInfo[]) => {
      updateClaudeContext(projectPath, identity, peers);
    });

    try {
      await client.connect();
      console.log(chalk.green("  Connected! Watching for changes...\n"));
      console.log(chalk.dim("  Press Ctrl+C to stop.\n"));
    } catch (err) {
      console.error(chalk.red(`  Failed to connect: ${err}`));
      console.error(chalk.dim("  Is the relay server running?"));
      process.exit(1);
    }

    process.on("SIGINT", () => {
      client.disconnect();
      process.exit(0);
    });
  });

// ── status ─────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show current sync status")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const configPath = join(projectPath, ".claude-multi-boot.json");

    if (!existsSync(configPath)) {
      console.log(chalk.yellow("Not initialized. Run 'claude-multi-boot init' first."));
      process.exit(0);
    }

    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const identity = await getMachineIdentity();

    console.log(chalk.bold("\n  claude-multi-boot status\n"));
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(config.roomId)}`);
    console.log(`  Server:   ${chalk.cyan(config.serverUrl)}`);
    console.log();
  });

// ── install-hooks ──────────────────────────────────────────────────
program
  .command("install-hooks")
  .description("Install Claude Code hooks for automatic sync")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const settingsDir = join(projectPath, ".claude");
    const settingsPath = join(settingsDir, "settings.local.json");

    await mkdir(settingsDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    }

    const distDir = join(projectPath, "node_modules", "claude-multi-boot", "dist");
    const hooksDir = existsSync(distDir) ? distDir : join(projectPath, "dist");

    const hooks: Record<string, unknown[]> = (settings.hooks as Record<string, unknown[]>) ?? {};

    hooks.SessionStart = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node ${join(hooksDir, "hooks", "session-start.js")}`,
            timeout: 5,
          },
        ],
      },
    ];

    hooks.PostToolUse = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node ${join(hooksDir, "hooks", "post-tool-use.js")}`,
            timeout: 3,
          },
        ],
      },
    ];

    settings.hooks = hooks;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    console.log(chalk.green.bold("\n  Hooks installed!\n"));
    console.log(`  Settings: ${chalk.dim(settingsPath)}`);
    console.log();
    console.log(chalk.dim("  Claude Code will now automatically sync session events."));
    console.log();
  });

// ── Helper: update CLAUDE.md with machine context ──────────────────
async function updateClaudeContext(
  projectPath: string,
  localIdentity: MachineIdentity,
  peers: PeerInfo[]
): Promise<void> {
  const claudeMdPath = join(projectPath, "CLAUDE.md");
  let content = "";

  if (existsSync(claudeMdPath)) {
    content = await readFile(claudeMdPath, "utf-8");
  }

  // Build peer machine identities (we only have PeerInfo, map to partial MachineIdentity)
  const peerMachines: MachineIdentity[] = peers
    .filter((p) => p.id !== localIdentity.peerId)
    .map((p) => ({
      peerId: p.id,
      label: p.hostname,
      hostname: p.hostname,
      ip: "connected",
      platform: "unknown",
      arch: "unknown",
      registeredAt: new Date(p.joinedAt).toISOString(),
    }));

  const contextBlock = generateMachineContext(localIdentity, peerMachines);
  const marker = "<!-- claude-multi-boot:start -->";
  const endMarker = "<!-- claude-multi-boot:end -->";
  const wrappedBlock = `${marker}\n${contextBlock}\n${endMarker}`;

  if (content.includes(marker)) {
    const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}`);
    content = content.replace(regex, wrappedBlock);
  } else {
    content = content ? `${content}\n\n${wrappedBlock}\n` : `${wrappedBlock}\n`;
  }

  await writeFile(claudeMdPath, content);
  log("info", "Updated CLAUDE.md with machine context");
}

program.parse();
