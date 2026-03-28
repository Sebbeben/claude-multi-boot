/**
 * Live terminal dashboard for claude-swarm.
 *
 * Shows connected peers, recent activity, sync status, and connection health
 * in a continuously updating terminal display.
 */

import chalk from "chalk";
import { SyncClient, ActivityEvent } from "./sync-client.js";
import { MachineColorMap } from "../shared/colors.js";
import { PeerInfo, RoomConfig } from "../shared/types.js";
import { MachineIdentity, formatMachineId } from "../shared/machine-identity.js";

const MAX_ACTIVITY_LINES = 20;

export class Dashboard {
  private client: SyncClient;
  private colorMap = new MachineColorMap();
  private activities: ActivityEvent[] = [];
  private peers: PeerInfo[] = [];
  private identity: MachineIdentity;
  private config: RoomConfig;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRender = 0;
  private messageCount = 0;
  private filesSynced = 0;

  constructor(config: RoomConfig, identity: MachineIdentity) {
    this.config = config;
    this.identity = identity;
    this.colorMap.getColor(identity.peerId);

    this.client = new SyncClient(
      config,
      identity,
      (peers) => {
        this.peers = peers;
        for (const p of peers) this.colorMap.getColor(p.id);
        this.render();
      },
      (event) => {
        this.activities.push(event);
        if (this.activities.length > MAX_ACTIVITY_LINES) {
          this.activities.shift();
        }
        if (event.type === "chat") this.messageCount++;
        if (event.type === "file-sync") this.filesSynced++;
        this.render();
      },
    );
  }

  async start(): Promise<void> {
    await this.client.connect();
    this.render();

    // Periodic refresh for uptime / connection status
    this.refreshTimer = setInterval(() => {
      this.render();
    }, 5000);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.client.disconnect();
  }

  private render(): void {
    // Throttle renders to max 4/sec
    const now = Date.now();
    if (now - this.lastRender < 250) return;
    this.lastRender = now;

    const lines: string[] = [];

    // Clear screen and move cursor to top
    lines.push("\x1b[2J\x1b[H");

    // Header
    lines.push(chalk.bold.cyan("  ╔══════════════════════════════════════════════════╗"));
    lines.push(chalk.bold.cyan("  ║") + chalk.bold.white("          claude-swarm dashboard              ") + chalk.bold.cyan("║"));
    lines.push(chalk.bold.cyan("  ╚══════════════════════════════════════════════════╝"));
    lines.push("");

    // Connection info
    const isConn = this.client.isConnected();
    const statusIcon = isConn ? chalk.green("●") : chalk.red("●");
    lines.push(`  ${statusIcon} ${chalk.bold("Status:")}  ${isConn ? chalk.green("Connected") : chalk.red("Disconnected")}`);
    lines.push(`  ${chalk.bold("Room:")}    ${chalk.cyan(this.config.roomId)}`);
    lines.push(`  ${chalk.bold("Server:")}  ${chalk.dim(this.config.serverUrl)}`);
    lines.push(`  ${chalk.bold("Machine:")} ${chalk.yellow(formatMachineId(this.identity))}`);
    lines.push("");

    // Stats
    lines.push(chalk.bold("  ── Stats ──────────────────────────────────────────"));
    lines.push(`  Peers: ${chalk.cyan(String(this.peers.length))}  │  Messages: ${chalk.cyan(String(this.messageCount))}  │  Files synced: ${chalk.cyan(String(this.filesSynced))}`);
    lines.push("");

    // Peers
    lines.push(chalk.bold("  ── Connected Machines ─────────────────────────────"));
    if (this.peers.length === 0) {
      lines.push(chalk.dim("  No peers connected yet."));
    } else {
      for (const peer of this.peers) {
        const isLocal = peer.id === this.identity.peerId;
        const tag = this.colorMap.formatTag(peer.id, peer.label);
        const suffix = isLocal ? chalk.dim(" (you)") : "";
        const ipInfo = chalk.dim(`${peer.ip}, ${peer.platform}/${peer.arch}`);
        lines.push(`    ${tag} ${ipInfo}${suffix}`);
      }
    }
    lines.push("");

    // Activity feed
    lines.push(chalk.bold("  ── Activity Feed ─────────────────────────────────"));
    if (this.activities.length === 0) {
      lines.push(chalk.dim("  No activity yet."));
    } else {
      const recent = this.activities.slice(-MAX_ACTIVITY_LINES);
      for (const event of recent) {
        const ts = new Date(event.timestamp).toISOString().slice(11, 19);
        const tag = this.colorMap.formatTag(event.peerId, event.label);
        const color = this.colorMap.getColor(event.peerId);
        const icons: Record<string, string> = {
          chat: ">", "file-sync": "~", "session-event": "*",
          join: "+", leave: "-", activity: "!",
        };
        const icon = icons[event.type] ?? " ";
        lines.push(`  ${chalk.dim(ts)} ${icon} ${tag} ${color(event.message)}`);
      }
    }
    lines.push("");
    lines.push(chalk.dim("  Press Ctrl+C to exit."));

    process.stdout.write(lines.join("\n") + "\n");
  }
}
