import WebSocket from "ws";
import { watch } from "chokidar";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  SyncMessage,
  MemoryUpdatePayload,
  ClaudeMdUpdatePayload,
  FileChangePayload,
  ChatMessagePayload,
  ActivityPayload,
  PeerInfo,
  PeerListPayload,
  RoomConfig,
  HEARTBEAT_INTERVAL,
} from "../shared/types.js";
import { generatePeerId, hashContent, timestamp, log } from "../shared/utils.js";
import { MachineIdentity } from "../shared/machine-identity.js";

export interface ActivityEvent {
  peerId: string;
  label: string;
  ip: string;
  type: "chat" | "file-sync" | "session-event" | "join" | "leave" | "activity";
  message: string;
  timestamp: number;
}

export class SyncClient {
  private ws: WebSocket | null = null;
  private peerId: string;
  private config: RoomConfig;
  private machineIdentity: MachineIdentity;
  private watcher: ReturnType<typeof watch> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private knownHashes = new Map<string, string>();
  private peers: PeerInfo[] = [];
  private connected = false;
  private onPeerUpdate?: (peers: PeerInfo[]) => void;
  private onActivity?: (event: ActivityEvent) => void;

  constructor(
    config: RoomConfig,
    machineIdentity: MachineIdentity,
    onPeerUpdate?: (peers: PeerInfo[]) => void,
    onActivity?: (event: ActivityEvent) => void,
  ) {
    this.peerId = machineIdentity.peerId;
    this.config = config;
    this.machineIdentity = machineIdentity;
    this.onPeerUpdate = onPeerUpdate;
    this.onActivity = onActivity;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.config.serverUrl;
      log("info", `Connecting to ${url} as ${this.peerId}...`);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        log("info", `Connected! Joining room ${this.config.roomId}`);

        this.send({
          type: "join",
          roomId: this.config.roomId,
          peerId: this.peerId,
          timestamp: timestamp(),
          payload: {
            hostname: this.machineIdentity.hostname,
            label: this.machineIdentity.label,
            ip: this.machineIdentity.ip,
            platform: this.machineIdentity.platform,
            arch: this.machineIdentity.arch,
          },
        });

        this.startHeartbeat();
        this.startWatching();
        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg: SyncMessage = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch (e) {
          log("error", "Invalid message received", e);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        log("warn", "Disconnected from server");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          log("error", "Connection error", err.message);
        }
      });
    });
  }

  private async handleMessage(msg: SyncMessage): Promise<void> {
    if (msg.peerId === this.peerId) return;

    const peerLabel = this.getPeerLabel(msg.peerId);
    const peerIp = this.getPeerIp(msg.peerId);

    switch (msg.type) {
      case "peer-list": {
        const payload = msg.payload as PeerListPayload;
        const oldPeerIds = new Set(this.peers.map((p) => p.id));
        this.peers = payload.peers;
        this.onPeerUpdate?.(this.peers);

        // Emit join/leave activity for new/removed peers
        for (const peer of this.peers) {
          if (peer.id !== this.peerId && !oldPeerIds.has(peer.id)) {
            this.emitActivity(peer.id, peer.label, peer.ip, "join", `joined the room`);
          }
        }
        const newPeerIds = new Set(this.peers.map((p) => p.id));
        for (const oldPeer of oldPeerIds) {
          if (!newPeerIds.has(oldPeer) && oldPeer !== this.peerId) {
            this.emitActivity(oldPeer, oldPeer, "", "leave", `left the room`);
          }
        }
        break;
      }

      case "memory-update": {
        const payload = msg.payload as MemoryUpdatePayload;
        await this.applyFileUpdate(payload.filePath, payload.content, payload.hash);
        this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `synced memory: ${payload.filePath}`);
        break;
      }

      case "claude-md-update": {
        const payload = msg.payload as ClaudeMdUpdatePayload;
        const targetPath = join(this.config.projectPath, "CLAUDE.md");
        await this.applyFileUpdate(targetPath, payload.content, payload.hash);
        this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `synced CLAUDE.md`);
        break;
      }

      case "file-change": {
        const payload = msg.payload as FileChangePayload;
        await this.applyFileChange(payload);
        this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `${payload.action}d ${payload.relativePath}`);
        break;
      }

      case "request-sync": {
        const requestPayload = msg.payload as { requestedBy: string };
        if (requestPayload.requestedBy !== this.peerId) {
          await this.sendCurrentState();
        }
        break;
      }

      case "session-event": {
        const evtPayload = msg.payload as { event: string; data?: { tool?: string; input?: string } };
        const detail = evtPayload.data?.input ?? evtPayload.event;
        this.emitActivity(msg.peerId, peerLabel, peerIp, "session-event", detail);
        break;
      }

      case "chat-message": {
        const chatPayload = msg.payload as ChatMessagePayload;
        this.emitActivity(msg.peerId, chatPayload.machineLabel, chatPayload.machineIp, "chat", chatPayload.text);
        break;
      }

      case "activity": {
        const actPayload = msg.payload as ActivityPayload;
        this.emitActivity(msg.peerId, actPayload.machineLabel, actPayload.machineIp, "activity", `${actPayload.action}: ${actPayload.detail}`);
        break;
      }
    }
  }

  private getPeerLabel(peerId: string): string {
    const peer = this.peers.find((p) => p.id === peerId);
    return peer?.label ?? peer?.hostname ?? peerId;
  }

  private getPeerIp(peerId: string): string {
    const peer = this.peers.find((p) => p.id === peerId);
    return peer?.ip ?? "";
  }

  private emitActivity(
    peerId: string,
    label: string,
    ip: string,
    type: ActivityEvent["type"],
    message: string,
  ): void {
    this.onActivity?.({
      peerId,
      label,
      ip,
      type,
      message,
      timestamp: Date.now(),
    });
  }

  private async applyFileUpdate(filePath: string, content: string, hash: string): Promise<void> {
    if (this.knownHashes.get(filePath) === hash) return;

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    this.knownHashes.set(filePath, hash);
  }

  private async applyFileChange(payload: FileChangePayload): Promise<void> {
    const fullPath = join(this.config.projectPath, payload.relativePath);

    if (payload.action === "delete") {
      const { unlink } = await import("node:fs/promises");
      if (existsSync(fullPath)) {
        await unlink(fullPath);
      }
      this.knownHashes.delete(fullPath);
      return;
    }

    const hash = hashContent(payload.content);
    await this.applyFileUpdate(fullPath, payload.content, hash);
  }

  private startWatching(): void {
    const watchPaths = this.config.syncPaths.map((p) =>
      join(this.config.projectPath, p)
    );

    // Also watch CLAUDE.md
    watchPaths.push(join(this.config.projectPath, "CLAUDE.md"));

    this.watcher = watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });

    this.watcher.on("change", async (filePath) => {
      await this.onLocalFileChange(filePath as string, "update");
    });

    this.watcher.on("add", async (filePath) => {
      await this.onLocalFileChange(filePath as string, "create");
    });

    this.watcher.on("unlink", (filePath) => {
      const relPath = relative(this.config.projectPath, filePath as string);
      this.send({
        type: "file-change",
        roomId: this.config.roomId,
        peerId: this.peerId,
        timestamp: timestamp(),
        payload: { relativePath: relPath, content: "", action: "delete" } satisfies FileChangePayload,
      });
    });

    log("info", `Watching: ${watchPaths.join(", ")}`);
  }

  private async onLocalFileChange(filePath: string, action: "create" | "update"): Promise<void> {
    try {
      const content = await readFile(filePath, "utf-8");
      const hash = hashContent(content);

      if (this.knownHashes.get(filePath) === hash) return;
      this.knownHashes.set(filePath, hash);

      const relPath = relative(this.config.projectPath, filePath);

      if (relPath === "CLAUDE.md") {
        this.send({
          type: "claude-md-update",
          roomId: this.config.roomId,
          peerId: this.peerId,
          timestamp: timestamp(),
          payload: {
            content,
            hash,
            projectPath: this.config.projectPath,
          } satisfies ClaudeMdUpdatePayload,
        });
      } else if (relPath.includes(".claude") || relPath.includes("memory")) {
        this.send({
          type: "memory-update",
          roomId: this.config.roomId,
          peerId: this.peerId,
          timestamp: timestamp(),
          payload: { filePath, content, hash } satisfies MemoryUpdatePayload,
        });
      } else {
        this.send({
          type: "file-change",
          roomId: this.config.roomId,
          peerId: this.peerId,
          timestamp: timestamp(),
          payload: { relativePath: relPath, content, action } satisfies FileChangePayload,
        });
      }
    } catch {
      // File may have been deleted between detection and read
    }
  }

  async sendSessionEvent(event: string, data: Record<string, unknown> = {}): Promise<void> {
    this.send({
      type: "session-event",
      roomId: this.config.roomId,
      peerId: this.peerId,
      timestamp: timestamp(),
      payload: { event, sessionId: this.config.roomId, data },
    });
  }

  sendChat(text: string): void {
    const payload: ChatMessagePayload = {
      text,
      machineLabel: this.machineIdentity.label,
      machineIp: this.machineIdentity.ip,
    };
    this.send({
      type: "chat-message",
      roomId: this.config.roomId,
      peerId: this.peerId,
      timestamp: timestamp(),
      payload,
    });
    // Also emit locally so the sender sees their own message
    this.emitActivity(this.peerId, this.machineIdentity.label, this.machineIdentity.ip, "chat", text);
  }

  sendBroadcastActivity(action: string, detail: string): void {
    const payload: ActivityPayload = {
      action,
      detail,
      machineLabel: this.machineIdentity.label,
      machineIp: this.machineIdentity.ip,
    };
    this.send({
      type: "activity",
      roomId: this.config.roomId,
      peerId: this.peerId,
      timestamp: timestamp(),
      payload,
    });
  }

  getLocalIdentity(): MachineIdentity {
    return this.machineIdentity;
  }

  private async sendCurrentState(): Promise<void> {
    // Send CLAUDE.md if it exists
    const claudeMdPath = join(this.config.projectPath, "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      const content = await readFile(claudeMdPath, "utf-8");
      const hash = hashContent(content);
      this.send({
        type: "claude-md-update",
        roomId: this.config.roomId,
        peerId: this.peerId,
        timestamp: timestamp(),
        payload: { content, hash, projectPath: this.config.projectPath } satisfies ClaudeMdUpdatePayload,
      });
    }

    // Send watched sync paths
    for (const syncPath of this.config.syncPaths) {
      const fullPath = join(this.config.projectPath, syncPath);
      if (existsSync(fullPath)) {
        try {
          const content = await readFile(fullPath, "utf-8");
          const hash = hashContent(content);
          this.send({
            type: "file-change",
            roomId: this.config.roomId,
            peerId: this.peerId,
            timestamp: timestamp(),
            payload: { relativePath: syncPath, content, action: "update" } satisfies FileChangePayload,
          });
          this.knownHashes.set(fullPath, hash);
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  private send(msg: SyncMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: "heartbeat",
        roomId: this.config.roomId,
        peerId: this.peerId,
        timestamp: timestamp(),
        payload: null,
      });
    }, HEARTBEAT_INTERVAL);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log("error", "Max reconnect attempts reached. Giving up.");
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    log("info", `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        log("error", "Reconnect failed");
      }
    }, delay);
  }

  getPeers(): PeerInfo[] {
    return this.peers;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.connected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watcher) this.watcher.close();
    if (this.ws) this.ws.close();
    log("info", "Disconnected");
  }
}
