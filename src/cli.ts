#!/usr/bin/env node

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`claude-swarm requires Node.js >= 20.12.0 (current: ${process.version})`);
  process.exit(1);
}

import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SyncServer, type ServerOptions } from "./server/index.js";
import { SyncClient, type ActivityEvent } from "./client/sync-client.js";
import { Dashboard } from "./client/dashboard.js";
import { getMachineIdentity, getLocalIp, formatMachineId, generateMachineContext, MachineIdentity } from "./shared/machine-identity.js";
import { MachineColorMap } from "./shared/colors.js";
import { generateRoomId, generateToken, log } from "./shared/utils.js";
import { DEFAULT_PORT, RoomConfig, PeerInfo, SyncFilter } from "./shared/types.js";
import { DiscoveryBroadcaster, DiscoveryListener } from "./shared/discovery.js";

const program = new Command();

program
  .name("claude-swarm")
  .description("Sync Claude Code sessions across multiple machines")
  .version("0.2.0");

// ═══════════════════════════════════════════════════════════════════
//  Shared helpers
// ═══════════════════════════════════════════════════════════════════

function buildConfig(
  roomId: string,
  serverUrl: string,
  projectPath: string,
  identity: MachineIdentity,
  token?: string,
  syncFilter?: SyncFilter,
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
    token,
    syncFilter,
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
  .option("--token", "Enable token authentication (generates a shared secret)")
  .option("--no-discovery", "Disable LAN auto-discovery broadcast")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const projectPath = resolve(opts.project);
    const identity = await getMachineIdentity(opts.label);
    const localIp = getLocalIp();
    const roomId = generateRoomFromAddress(localIp, port);
    const serverUrl = `ws://localhost:${port}`;

    // Generate token if requested
    const token = opts.token ? generateToken() : undefined;

    // 1. Start relay server
    const serverOpts: ServerOptions = {};
    if (token) serverOpts.token = token;
    const server = new SyncServer(serverOpts);
    server.start(port);

    // 2. Start LAN discovery broadcast
    let broadcaster: DiscoveryBroadcaster | null = null;
    if (opts.discovery !== false) {
      broadcaster = new DiscoveryBroadcaster(port, roomId, identity.label, !!token);
      broadcaster.start();
    }

    // 3. Write config
    const config = buildConfig(roomId, serverUrl, projectPath, identity, token);
    await saveConfig(projectPath, config);

    // 4. Print join instructions
    console.log(chalk.green.bold("\n  claude-swarm host\n"));
    console.log(`  Swarm started! Relay running on port ${chalk.cyan(String(port))}`);
    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(roomId)}`);
    if (token) {
      console.log(`  Token:    ${chalk.magenta(token)}`);
    }
    console.log();
    console.log(chalk.bold("  Others can join with:"));
    console.log();
    if (token) {
      console.log(`    ${chalk.cyan.bold(`claude-swarm join ${localIp} --token ${token}`)}`);
    } else {
      console.log(`    ${chalk.cyan.bold(`claude-swarm join ${localIp}`)}`);
    }
    console.log();
    console.log(chalk.dim("  Or auto-discover on LAN:"));
    console.log(`    ${chalk.cyan.bold("claude-swarm join")}`);
    console.log();
    if (localIp === "127.0.0.1") {
      console.log(chalk.yellow("  Warning: No external network interface detected."));
      console.log(chalk.yellow("  Other machines may need your actual IP or hostname.\n"));
    }

    // 5. Start syncing with activity feed
    try {
      await startSyncUI(config, identity, projectPath);
    } catch (err) {
      console.error(chalk.red(`  Failed to connect to own server: ${err}`));
      if (broadcaster) broadcaster.stop();
      server.stop();
      process.exit(1);
    }

    process.on("SIGINT", () => {
      if (broadcaster) broadcaster.stop();
      server.stop();
      process.exit(0);
    });
  });

// ── join ───────────────────────────────────────────────────────────
program
  .command("join")
  .description("Join an existing swarm by IP address, hostname, or auto-discovery")
  .argument("[address]", "IP address or hostname of the host (omit for auto-discovery)")
  .option("-p, --port <port>", "Port the host is running on", String(DEFAULT_PORT))
  .option("-l, --label <name>", "Label for this machine")
  .option("--project <path>", "Project path", process.cwd())
  .option("--token <token>", "Room token for authentication")
  .option("--include <patterns>", "Comma-separated glob patterns of files to receive")
  .option("--exclude <patterns>", "Comma-separated glob patterns of files to exclude")
  .action(async (address, opts) => {
    const port = parseInt(opts.port, 10);
    const projectPath = resolve(opts.project);
    const identity = await getMachineIdentity(opts.label);

    let resolvedAddress = address;
    let token = opts.token;

    // Auto-discovery if no address provided
    if (!resolvedAddress) {
      console.log(chalk.green.bold("\n  claude-swarm join\n"));
      console.log(chalk.dim("  Searching for swarms on the local network..."));

      const listener = new DiscoveryListener();
      try {
        await listener.start();
        const host = await listener.waitForHost(10000);
        listener.stop();

        if (!host) {
          console.error(chalk.red("  No swarm found on the local network."));
          console.error(chalk.dim("  Try specifying an address: claude-swarm join <ip>"));
          process.exit(1);
        }

        resolvedAddress = host.address;
        if (host.tokenRequired && !token) {
          console.error(chalk.red("  This swarm requires a token. Use: claude-swarm join --token <token>"));
          process.exit(1);
        }
        console.log(`  Found swarm: ${chalk.cyan(host.label)} at ${chalk.cyan(`${host.address}:${host.port}`)}`);
      } catch (err) {
        listener.stop();
        console.error(chalk.red(`  Auto-discovery failed: ${err}`));
        console.error(chalk.dim("  Try specifying an address: claude-swarm join <ip>"));
        process.exit(1);
      }
    }

    const serverUrl = `ws://${resolvedAddress}:${port}`;

    console.log(chalk.green.bold("\n  claude-swarm join\n"));
    console.log(`  Connecting to ${chalk.cyan(serverUrl)}...`);

    const roomId = generateRoomFromAddress(resolvedAddress, port);

    // Build sync filter from CLI options
    let syncFilter: SyncFilter | undefined;
    if (opts.include || opts.exclude) {
      syncFilter = {};
      if (opts.include) syncFilter.include = opts.include.split(",").map((s: string) => s.trim());
      if (opts.exclude) syncFilter.exclude = opts.exclude.split(",").map((s: string) => s.trim());
    }

    // Write config
    const config = buildConfig(roomId, serverUrl, projectPath, identity, token, syncFilter);
    await saveConfig(projectPath, config);

    console.log(`  Machine:  ${chalk.yellow(formatMachineId(identity))}`);
    console.log(`  Room:     ${chalk.cyan(roomId)}`);
    if (syncFilter) {
      if (syncFilter.include) console.log(`  Include:  ${chalk.dim(syncFilter.include.join(", "))}`);
      if (syncFilter.exclude) console.log(`  Exclude:  ${chalk.dim(syncFilter.exclude.join(", "))}`);
    }
    console.log();

    // Start syncing with activity feed
    try {
      await startSyncUI(config, identity, projectPath);
    } catch (err) {
      console.error(chalk.red(`  Failed to connect: ${err}`));
      console.error(chalk.dim(`  Is the host running? Check: claude-swarm host on ${resolvedAddress}`));
      process.exit(1);
    }
  });

/**
 * Generate a deterministic room ID from the server address.
 */
function generateRoomFromAddress(address: string, port: number): string {
  return createHash("sha256")
    .update(`claude-swarm:${address}:${port}`)
    .digest("hex")
    .slice(0, 12);
}

// ── dashboard ─────────────────────────────────────────────────────
program
  .command("dashboard")
  .description("Live status dashboard with peer list, activity feed, and stats")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const configPath = join(projectPath, ".claude-swarm.json");

    if (!existsSync(configPath)) {
      console.error(chalk.red("No .claude-swarm.json found."));
      console.error(chalk.dim("Use 'claude-swarm host' to start a swarm first."));
      process.exit(1);
    }

    const config = JSON.parse(await readFile(configPath, "utf-8")) as RoomConfig & { machine: MachineIdentity };
    const identity = await getMachineIdentity();

    const dashboard = new Dashboard(config, identity);
    await dashboard.start();

    process.on("SIGINT", () => {
      dashboard.stop();
      process.exit(0);
    });
  });

// ── serve ──────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the relay server only (advanced)")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_PORT))
  .option("--token <token>", "Require this token for room access")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const serverOpts: ServerOptions = {};
    if (opts.token) serverOpts.token = opts.token;
    const server = new SyncServer(serverOpts);
    server.start(port);

    console.log(chalk.green.bold("\n  claude-swarm relay server\n"));
    console.log(`  Listening on: ${chalk.cyan(`ws://0.0.0.0:${port}`)}`);
    if (opts.token) console.log(`  Token auth:   ${chalk.magenta("enabled")}`);
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
  .option("--token <token>", "Room token for authentication")
  .action(async (opts) => {
    const projectPath = resolve(opts.project);
    const roomId = opts.room ?? generateRoomId();
    const identity = await getMachineIdentity(opts.label);
    const config = buildConfig(roomId, opts.server, projectPath, identity, opts.token);
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
    if (config.token) console.log(`  Token:    ${chalk.magenta("(set)")}`);
    if (config.syncFilter) {
      if (config.syncFilter.include) console.log(`  Include:  ${chalk.dim(config.syncFilter.include.join(", "))}`);
      if (config.syncFilter.exclude) console.log(`  Exclude:  ${chalk.dim(config.syncFilter.exclude.join(", "))}`);
    }
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
