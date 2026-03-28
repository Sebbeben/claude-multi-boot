#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SyncServer } from "./server/index.js";
import { SyncClient, type ActivityEvent } from "./client/sync-client.js";
import { getMachineIdentity, getLocalIp, formatMachineId, generateMachineContext, MachineIdentity } from "./shared/machine-identity.js";
import { MachineColorMap } from "./shared/colors.js";
import { generateRoomId, log } from "./shared/utils.js";
import { DEFAULT_PORT, RoomConfig, PeerInfo } from "./shared/types.js";

const program = new Command();

program
  .name("claude-swarm")
  .description("Sync Claude Code sessions across multiple machines")
  .version("0.1.0");

// ═══════════════════════════════════════════════════════════════════
//  Shared helpers
// ═══════════════════════════════════════════════════════════════════

function buildConfig(
  roomId: string,
  serverUrl: string,
  projectPath: string,
  identity: MachineIdentity,
): RoomConfig & { machine: MachineIdentity } {
  return {
    roomId,
    serverUrl,
    projectPath,
    syncPaths: [
      "CLAUDE.md",
      ".claude/settings.json",
      ".claude/settings.local.json",
    ],
    machine: identity,
  };
}

async function saveConfig(
  projectPath: string,
  config: RoomConfig & { machine: MachineIdentity },
): Promise<string> {
  const configPath = join(projectPath, ".claude-swarm.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function startSyncUI(
  config: RoomConfig,
  identity: MachineIdentity,
  projectPath: string,
): Promise<void> {
  const colorMap = new MachineColorMap();
  colorMap.getColor(identity.peerId);

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

  await client.connect();
  console.log(chalk.green("  Connected! Watching for changes..."));
  console.log(chalk.dim("  Type a message and press Enter to chat. Ctrl+C to stop.\n"));

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
}

async function updateClaudeContext(
  projectPath: string,
  localIdentity: MachineIdentity,
  peers: PeerInfo[],
): Promise<void> {
  const claudeMdPath = join(projectPath, "CLAUDE.md");
  let content = "";

  if (existsSync(claudeMdPath)) {
    content = await readFile(claudeMdPath, "utf-8");
  }

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
  const marker = "<!-- claude-swarm:start -->";
  const endMarker = "<!-- claude-swarm:end -->";
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

// ═══════════════════════════════════════════════════════════════════
//  Commands
// ═══════════════════════════════════════════════════════════════════

// ── host ───────────────────────────────────────────────────────────
program
  .command("host")
  .description("Start a swarm — runs the relay server and connects as the first machine")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .option("-l, --label <name>", "Label for this machine")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const projectPath = resolve(opts.project);
    const identity = await getMachineIdentity(opts.label);
    const localIp = getLocalIp();
    // Use deterministic room ID based on this machine's IP + port
    // so that "join <ip>" automatically lands in the same room
    const roomId = generateRoomFromAddress(localIp, port);
    const serverUrl = `ws://localhost:${port}`;

    // 1. Start relay server
    const server = new SyncServer();
    server.start(port);

    // 2. Write config
    const config = buildConfig(roomId, serverUrl, projectPath, identity);
    await saveConfig(projectPath, config);

    // 3. Print join instructions
    console.log(chalk.green.bold("\n  claude-swarm host\n"));
    console.log(`  Swarm started! Relay running on port ${chalk.cyan(String(port))}`);
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(roomId)}`);
    console.log();
    console.log(chalk.bold("  Others can join with:"));
    console.log();
    console.log(`    ${chalk.cyan.bold(`claude-swarm join ${localIp}`)}`);
    console.log();
    if (localIp === "127.0.0.1") {
      console.log(chalk.yellow("  Warning: No external network interface detected."));
      console.log(chalk.yellow("  Other machines may need your actual IP or hostname.\n"));
    }

    // 4. Start syncing with activity feed
    try {
      await startSyncUI(config, identity, projectPath);
    } catch (err) {
      console.error(chalk.red(`  Failed to connect to own server: ${err}`));
      server.stop();
      process.exit(1);
    }

    process.on("SIGINT", () => {
      server.stop();
      process.exit(0);
    });
  });

// ── join ───────────────────────────────────────────────────────────
program
  .command("join")
  .description("Join an existing swarm by IP address or hostname")
  .argument("<address>", "IP address or hostname of the host machine")
  .option("-p, --port <port>", "Port the host is running on", String(DEFAULT_PORT))
  .option("-l, --label <name>", "Label for this machine")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (address, opts) => {
    const port = parseInt(opts.port, 10);
    const projectPath = resolve(opts.project);
    const identity = await getMachineIdentity(opts.label);
    const serverUrl = `ws://${address}:${port}`;

    // 1. Connect briefly to discover the room ID
    console.log(chalk.green.bold("\n  claude-swarm join\n"));
    console.log(`  Connecting to ${chalk.cyan(serverUrl)}...`);

    // Generate a room ID or discover one — for now we use a deterministic
    // room based on the server address so all joiners end up in the same room
    const roomId = generateRoomFromAddress(address, port);

    // 2. Write config
    const config = buildConfig(roomId, serverUrl, projectPath, identity);
    await saveConfig(projectPath, config);

    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(roomId)}`);
    console.log();

    // 3. Start syncing with activity feed
    try {
      await startSyncUI(config, identity, projectPath);
    } catch (err) {
      console.error(chalk.red(`  Failed to connect: ${err}`));
      console.error(chalk.dim(`  Is the host running? Check: claude-swarm host on ${address}`));
      process.exit(1);
    }
  });

/**
 * Generate a deterministic room ID from the server address.
 * This way all machines joining the same host automatically end up
 * in the same room without needing to exchange room IDs.
 */
function generateRoomFromAddress(address: string, port: number): string {
  return createHash("sha256")
    .update(`claude-swarm:${address}:${port}`)
    .digest("hex")
    .slice(0, 12);
}

// ── serve ──────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the relay server only (advanced)")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const server = new SyncServer();
    server.start(port);

    console.log(chalk.green.bold("\n  claude-swarm relay server\n"));
    console.log(`  Listening on: ${chalk.cyan(`ws://0.0.0.0:${port}`)}`);
    console.log(`  Share this address with other machines to connect.\n`);

    process.on("SIGINT", () => { server.stop(); process.exit(0); });
  });

// ── init ───────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize sync config manually (advanced)")
  .option("-s, --server <url>", "Relay server URL", `ws://localhost:${DEFAULT_PORT}`)
  .option("-r, --room <id>", "Room ID (generates one if not provided)")
  .option("-l, --label <name>", "Label for this machine")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const roomId = opts.room ?? generateRoomId();
    const identity = await getMachineIdentity(opts.label);
    const config = buildConfig(roomId, opts.server, projectPath, identity);
    const configPath = await saveConfig(projectPath, config);

    console.log(chalk.green.bold("\n  claude-swarm initialized!\n"));
    console.log(`  Config:   ${chalk.dim(configPath)}`);
    console.log(`  Room ID:  ${chalk.cyan(roomId)}`);
    console.log(`  Server:   ${chalk.cyan(opts.server)}`);
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log();
    console.log(chalk.dim("  On another machine, run:"));
    console.log(`  ${chalk.white(`claude-swarm init --server ${opts.server} --room ${roomId}`)}`);
    console.log();
    console.log(chalk.dim("  Then start syncing:"));
    console.log(`  ${chalk.white("claude-swarm sync")}`);
    console.log();
  });

// ── sync ───────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Start syncing with an existing config (advanced)")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const configPath = join(projectPath, ".claude-swarm.json");

    if (!existsSync(configPath)) {
      console.error(chalk.red("No .claude-swarm.json found."));
      console.error(chalk.dim("Use 'claude-swarm host' to start a swarm or 'claude-swarm join <ip>' to join one."));
      process.exit(1);
    }

    const config = JSON.parse(await readFile(configPath, "utf-8")) as RoomConfig & { machine: MachineIdentity };
    const identity = await getMachineIdentity();

    console.log(chalk.green.bold("\n  claude-swarm sync\n"));
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(config.roomId)}`);
    console.log(`  Server:   ${chalk.cyan(config.serverUrl)}`);
    console.log();

    try {
      await startSyncUI(config, identity, projectPath);
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
    const configPath = join(projectPath, ".claude-swarm.json");

    if (!existsSync(configPath)) {
      console.log(chalk.yellow("Not initialized. Run 'claude-swarm host' to start a swarm."));
      process.exit(0);
    }

    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const identity = await getMachineIdentity();
    const statusColorMap = new MachineColorMap();

    console.log(chalk.bold("\n  claude-swarm status\n"));
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

    const distDir = join(projectPath, "node_modules", "claude-swarm", "dist");
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

program.parse();
