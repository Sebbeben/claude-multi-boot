import WebSocket from "ws";
import { watch } from "chokidar";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  SyncMessage,
  MemoryUpdatePayload,
  ClaudeMdUpdatePayload,
  FileChangePayload,
  FileDeltaPayload,
  ChatMessagePayload,
  ActivityPayload,
  PeerInfo,
  PeerListPayload,
  RoomConfig,
  HEARTBEAT_INTERVAL,
  MAX_FILE_SIZE,
} from "../shared/types.js";
import { hashContent, timestamp, log } from "../shared/utils.js";
import { MachineIdentity } from "../shared/machine-identity.js";
import { mergeClaudeMd } from "../shared/conflict-resolver.js";
import { computeDelta, applyDelta, isDeltaSmaller } from "../shared/delta.js";

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
  private disposed = false;
  private knownHashes = new Map<string, string>();
  private baseContents = new Map<string, string>(); // For three-way merge
  private lastSentContents = new Map<string, string>(); // For delta computation
  private offlineQueue: SyncMessage[] = [];
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
        const isReconnect = this.reconnectAttempts > 0;
        this.connected = true;
        this.reconnectAttempts = 0;
        log("info", `${isReconnect ? "Reconnected" : "Connected"}! Joining room ${this.config.roomId}`);

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
            ...(this.config.token ? { token: this.config.token } : {}),
            ...(this.config.autoJoinRoom ? { autoJoinRoom: true } : {}),
          },
        });

        this.startHeartbeat();
        if (!isReconnect) {
          this.startWatching();
        } else {
          this.flushOfflineQueue();
        }
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

  private shouldReceive(msg: SyncMessage): boolean {
    const filter = this.config.syncFilter;
    if (!filter) return true;

    // Check message type filter
    if (filter.messageTypes && filter.messageTypes.length > 0) {
      if (!filter.messageTypes.includes(msg.type)) return false;
    }

    // Check path filters for file-related messages
    if (filter.include || filter.exclude) {
      let relPath: string | null = null;
      if (msg.type === "file-change" || msg.type === "file-delta") {
        relPath = (msg.payload as { relativePath?: string })?.relativePath ?? null;
      } else if (msg.type === "claude-md-update") {
        relPath = "CLAUDE.md";
      }

      if (relPath) {
        if (filter.exclude?.some((pattern) => this.matchGlob(relPath!, pattern))) {
          return false;
        }
        if (filter.include && filter.include.length > 0) {
          if (!filter.include.some((pattern) => this.matchGlob(relPath!, pattern))) {
            return false;
          }
        }
      }
    }

    return true;
  }

  private matchGlob(path: string, pattern: string): boolean {
    // Simple glob matching: * matches anything, ** matches path separators too
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§/g, ".*");
    return new RegExp(`^${regex}$`).test(path);
  }

  private async handleMessage(msg: SyncMessage): Promise<void> {
    if (msg.peerId === this.peerId) return;
    if (!this.shouldReceive(msg)) return;

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
        if (!this.isPathSafe(payload.filePath)) {
          log("warn", `Blocked memory-update path traversal: ${payload.filePath}`);
          break;
        }
        await this.applyFileUpdate(payload.filePath, payload.content, payload.hash);
        this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `synced memory: ${payload.filePath}`);
        break;
      }

      case "claude-md-update": {
        const payload = msg.payload as ClaudeMdUpdatePayload;
        const targetPath = join(this.config.projectPath, "CLAUDE.md");
        if (!this.isPathSafe(targetPath)) break;

        // Use merge strategy instead of blind overwrite
        let localContent = "";
        if (existsSync(targetPath)) {
          localContent = await readFile(targetPath, "utf-8");
        }
        const base = this.baseContents.get(targetPath) ?? null;
        const result = mergeClaudeMd(base, localContent, payload.content);

        if (result.hadConflict) {
          this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync",
            `CLAUDE.md merged with conflicts in: ${result.conflictSections.join(", ")}`);
        } else {
          this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `synced CLAUDE.md`);
        }

        const mergedHash = hashContent(result.content);
        this.knownHashes.set(targetPath, mergedHash);
        this.baseContents.set(targetPath, result.content);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, result.content, "utf-8");
        break;
      }

      case "file-change": {
        const payload = msg.payload as FileChangePayload;
        await this.applyFileChange(payload);
        this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `${payload.action}d ${payload.relativePath}`);
        break;
      }

      case "file-delta": {
        const deltaPayload = msg.payload as FileDeltaPayload;
        const deltaFullPath = join(this.config.projectPath, deltaPayload.relativePath);
        if (!this.isPathSafe(deltaFullPath)) {
          log("warn", `Blocked delta path traversal: ${deltaPayload.relativePath}`);
          break;
        }
        // Apply delta if we have the base version
        const currentHash = this.knownHashes.get(deltaFullPath);
        if (currentHash === deltaPayload.baseHash && existsSync(deltaFullPath)) {
          const oldContent = await readFile(deltaFullPath, "utf-8");
          const newContent = applyDelta(oldContent, deltaPayload.ops);
          const newHash = hashContent(newContent);
          if (newHash === deltaPayload.resultHash) {
            this.knownHashes.set(deltaFullPath, newHash);
            this.lastSentContents.set(deltaFullPath, newContent);
            await writeFile(deltaFullPath, newContent, "utf-8");
            this.emitActivity(msg.peerId, peerLabel, peerIp, "file-sync", `delta synced ${deltaPayload.relativePath}`);
          } else {
            log("warn", `Delta hash mismatch for ${deltaPayload.relativePath}, requesting full sync`);
          }
        } else {
          log("debug", `Cannot apply delta for ${deltaPayload.relativePath}: base hash mismatch`);
        }
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

      case "history": {
        const histPayload = msg.payload as { messages: SyncMessage[]; count: number };
        log("info", `Received ${histPayload.count} history message(s)`);
        for (const histMsg of histPayload.messages) {
          // Replay chat messages as activity events (don't re-apply file changes from history)
          if (histMsg.type === "chat-message") {
            const cp = histMsg.payload as ChatMessagePayload;
            this.emitActivity(histMsg.peerId, cp.machineLabel, cp.machineIp, "chat", cp.text);
          } else if (histMsg.type === "activity") {
            const ap = histMsg.payload as ActivityPayload;
            this.emitActivity(histMsg.peerId, ap.machineLabel, ap.machineIp, "activity", `${ap.action}: ${ap.detail}`);
          } else if (histMsg.type === "session-event") {
            const ep = histMsg.payload as { event: string; data?: { input?: string } };
            const detail = ep.data?.input ?? ep.event;
            this.emitActivity(histMsg.peerId, this.getPeerLabel(histMsg.peerId), this.getPeerIp(histMsg.peerId), "session-event", detail);
          }
        }
        break;
      }

      case "leave": {
        // Server rejection or peer departure
        const leavePayload = msg.payload as { reason?: string };
        if (leavePayload?.reason === "invalid_token") {
          log("error", "Connection rejected: invalid room token");
          this.emitActivity("server", "server", "", "leave", "Connection rejected: invalid token");
          this.disconnect();
        }
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

  private isPathSafe(targetPath: string): boolean {
    const resolved = resolve(targetPath);
    const projectRoot = resolve(this.config.projectPath);
    return resolved.startsWith(projectRoot + "/") || resolved === projectRoot;
  }

  private async applyFileChange(payload: FileChangePayload): Promise<void> {
    const fullPath = join(this.config.projectPath, payload.relativePath);

    if (!this.isPathSafe(fullPath)) {
      log("warn", `Blocked path traversal attempt: ${payload.relativePath}`);
      return;
    }

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
    const watchSet = new Set(this.config.syncPaths);
    watchSet.add("CLAUDE.md"); // Ensure CLAUDE.md is always watched
    const watchPaths = [...watchSet].map((p) =>
      join(this.config.projectPath, p)
    );

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

      if (Buffer.byteLength(content) > MAX_FILE_SIZE) {
        log("warn", `Skipping ${filePath}: exceeds ${MAX_FILE_SIZE / 1024}KB size limit`);
        this.emitActivity(this.peerId, this.machineIdentity.label, this.machineIdentity.ip,
          "activity", `Skipped syncing ${relative(this.config.projectPath, filePath)} (too large)`);
        return;
      }

      const hash = hashContent(content);

      if (this.knownHashes.get(filePath) === hash) return;
      const previousHash = this.knownHashes.get(filePath);
      this.knownHashes.set(filePath, hash);

      const relPath = relative(this.config.projectPath, filePath);

      if (relPath === "CLAUDE.md") {
        this.baseContents.set(filePath, content); // Track for future merges
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
        const lastContent = this.lastSentContents.get(filePath);

        // Try delta if we have a previous version
        if (lastContent && previousHash && action === "update") {
          const ops = computeDelta(lastContent, content);
          if (isDeltaSmaller(ops, content)) {
            this.send({
              type: "file-delta",
              roomId: this.config.roomId,
              peerId: this.peerId,
              timestamp: timestamp(),
              payload: {
                relativePath: relPath,
                baseHash: previousHash,
                resultHash: hash,
                ops,
              } satisfies FileDeltaPayload,
            });
            this.lastSentContents.set(filePath, content);
            return;
          }
        }

        this.send({
          type: "file-change",
          roomId: this.config.roomId,
          peerId: this.peerId,
          timestamp: timestamp(),
          payload: { relativePath: relPath, content, action } satisfies FileChangePayload,
        });
        this.lastSentContents.set(filePath, content);
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
    } else if (!this.disposed && msg.type !== "heartbeat" && msg.type !== "join") {
      // Queue messages while disconnected (skip heartbeats and joins)
      this.offlineQueue.push(msg);
      if (this.offlineQueue.length > 100) {
        this.offlineQueue.shift(); // Drop oldest to prevent unbounded growth
      }
    }
  }

  private flushOfflineQueue(): void {
    if (this.offlineQueue.length === 0) return;
    log("info", `Flushing ${this.offlineQueue.length} queued message(s)`);
    const queue = [...this.offlineQueue];
    this.offlineQueue = [];
    for (const msg of queue) {
      this.send(msg);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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
    if (this.disposed) return;
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
    this.disposed = true;
    this.connected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watcher) this.watcher.close();
    if (this.ws) this.ws.close();
    log("info", "Disconnected");
  }
}
