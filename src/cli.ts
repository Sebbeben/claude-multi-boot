#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SyncServer } from "./server/index.js";
import { SyncClient, type ActivityEvent } from "./client/sync-client.js";
import { getMachineIdentity, formatMachineId, generateMachineContext, MachineIdentity } from "./shared/machine-identity.js";
import { MachineColorMap } from "./shared/colors.js";
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
    const colorMap = new MachineColorMap();

    // Register local machine color first (always index 0)
    colorMap.getColor(identity.peerId);

    console.log(chalk.green.bold("\n  claude-multi-boot sync\n"));
    console.log(`  Machine:  ${colorMap.formatMessage(identity.peerId, identity.label, formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(config.roomId)}`);
    console.log(`  Server:   ${chalk.cyan(config.serverUrl)}`);
    console.log();

    // ── Activity feed renderer ──
    function renderActivity(event: ActivityEvent): void {
      const ts = new Date(event.timestamp).toISOString().slice(11, 19);
      const tag = colorMap.formatTag(event.peerId, event.label);
      const color = colorMap.getColor(event.peerId);

      const icons: Record<ActivityEvent["type"], string> = {
        chat: ">",
        "file-sync": "~",
        "session-event": "*",
        join: "+",
        leave: "-",
        activity: "!",
      };
      const icon = icons[event.type] ?? " ";

      const ipSuffix = event.ip ? chalk.dim(` [${event.ip}]`) : "";
      console.log(`  ${chalk.dim(ts)} ${icon} ${tag}${ipSuffix} ${color(event.message)}`);
    }

    // ── Peer list renderer ──
    function renderPeerList(peers: PeerInfo[]): void {
      console.log();
      console.log(chalk.bold("  Connected machines:"));
      for (const peer of peers) {
        const isLocal = peer.id === identity.peerId;
        const tag = colorMap.formatTag(peer.id, peer.label);
        const suffix = isLocal ? chalk.dim(" (you)") : "";
        const ipInfo = chalk.dim(`${peer.ip}, ${peer.platform}/${peer.arch}`);
        console.log(`    ${tag} ${ipInfo}${suffix}`);
      }
      console.log();
    }

    const client = new SyncClient(
      config,
      identity,
      (peers: PeerInfo[]) => {
        // Register colors for all peers
        for (const peer of peers) {
          colorMap.getColor(peer.id);
        }
        renderPeerList(peers);
        updateClaudeContext(projectPath, identity, peers);
      },
      (event: ActivityEvent) => {
        renderActivity(event);
      },
    );

    try {
      await client.connect();
      console.log(chalk.green("  Connected! Watching for changes..."));
      console.log(chalk.dim("  Type a message and press Enter to chat. Ctrl+C to stop.\n"));

      // ── Interactive chat input ──
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          client.sendChat(trimmed);
        }
      });

      process.on("SIGINT", () => {
        rl.close();
        client.disconnect();
        process.exit(0);
      });
    } catch (err) {
      console.error(chalk.red(`  Failed to connect: ${err}`));
      console.error(chalk.dim("  Is the relay server running?"));
      process.exit(1);
    }
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
    const statusColorMap = new MachineColorMap();

    console.log(chalk.bold("\n  claude-multi-boot status\n"));
    console.log(`  Machine:  ${statusColorMap.formatMessage(identity.peerId, identity.label, formatMachineId(identity))}`);
    console.log(`  Color:    ${statusColorMap.getColor(identity.peerId)(statusColorMap.getColorName(identity.peerId))}`);
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

  // Build peer machine identities from PeerInfo (which now carries full identity)
  const peerMachines: MachineIdentity[] = peers
    .filter((p) => p.id !== localIdentity.peerId)
    .map((p) => ({
      peerId: p.id,
      label: p.label ?? p.hostname,
      hostname: p.hostname,
      ip: p.ip ?? "unknown",
      platform: p.platform ?? "unknown",
      arch: p.arch ?? "unknown",
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
