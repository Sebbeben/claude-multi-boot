import { WebSocketServer, WebSocket } from "ws";
import { createServer as createHttpsServer } from "node:https";
import {
  SyncMessage,
  PeerInfo,
  HEARTBEAT_INTERVAL,
  PEER_TIMEOUT,
  DEFAULT_PORT,
  MAX_MESSAGE_SIZE,
} from "../shared/types.js";
import { generatePeerId, timestamp, log } from "../shared/utils.js";

interface ConnectedPeer {
  ws: WebSocket;
  info: PeerInfo;
  roomId: string;
}

interface HistoryEntry {
  msg: SyncMessage;
  storedAt: number;
}

export interface ServerOptions {
  /** Room token required for joining. If set, clients must include it in join payload. */
  token?: string;
  /** TLS key (PEM). If provided with cert, server runs wss://. */
  tlsKey?: string;
  /** TLS cert (PEM). */
  tlsCert?: string;
  /** Max history entries to keep per room for session replay. Default: 200 */
  maxHistory?: number;
}

export class SyncServer {
  private wss: WebSocketServer | null = null;
  private peers = new Map<string, ConnectedPeer>();
  private rooms = new Map<string, Set<string>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private token?: string;
  private roomHistory = new Map<string, HistoryEntry[]>();
  private maxHistory: number;

  constructor(options?: ServerOptions) {
    this.token = options?.token;
    this.maxHistory = options?.maxHistory ?? 200;
  }

  start(port: number = DEFAULT_PORT, options?: ServerOptions): void {
    const opts = options ?? {};
    if (opts.token) this.token = opts.token;

    const wssOptions: Record<string, unknown> = { maxPayload: MAX_MESSAGE_SIZE };

    if (opts.tlsKey && opts.tlsCert) {
      const httpsServer = createHttpsServer({
        key: opts.tlsKey,
        cert: opts.tlsCert,
      });
      wssOptions.server = httpsServer;
      httpsServer.listen(port);
      log("info", `Relay server listening on wss://0.0.0.0:${port} (TLS)`);
    } else {
      wssOptions.port = port;
      log("info", `Relay server listening on ws://0.0.0.0:${port}`);
    }

    this.wss = new WebSocketServer(wssOptions as ConstructorParameters<typeof WebSocketServer>[0]);

    if (this.token) {
      log("info", `Room token authentication enabled`);
    }

    this.wss.on("connection", (ws) => {
      let currentPeerId = generatePeerId(); // Temp ID until join
      log("info", `New connection (temp: ${currentPeerId})`);

      ws.on("message", (raw) => {
        try {
          const msg: SyncMessage = JSON.parse(raw.toString());
          const newPeerId = this.handleMessage(ws, msg, currentPeerId);
          if (newPeerId) currentPeerId = newPeerId;
        } catch (e) {
          log("error", "Invalid message", e);
        }
      });

      ws.on("close", () => {
        this.removePeer(currentPeerId);
      });

      ws.on("error", (err) => {
        log("error", `WebSocket error for ${currentPeerId}`, err.message);
        this.removePeer(currentPeerId);
      });
    });

    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL);
  }

  private handleMessage(ws: WebSocket, msg: SyncMessage, currentPeerId: string): string | undefined {
    switch (msg.type) {
      case "join": {
        const accepted = this.handleJoin(ws, msg, currentPeerId);
        return accepted ? msg.peerId : undefined;
      }

      case "heartbeat":
        this.handleHeartbeat(msg.peerId);
        return undefined;

      case "request-sync":
        this.handleRequestSync(msg);
        return undefined;

      default:
        // Store in history for replay (skip heartbeats and peer-lists)
        this.addToHistory(msg.roomId, msg);
        this.broadcast(msg.roomId, msg, msg.peerId);
        return undefined;
    }
  }

  private handleJoin(ws: WebSocket, msg: SyncMessage, tempId: string): boolean {
    const peerId = msg.peerId;
    const roomId = msg.roomId;

    const joinPayload = msg.payload as {
      hostname?: string;
      label?: string;
      ip?: string;
      platform?: string;
      arch?: string;
      token?: string;
    };

    // Token validation
    if (this.token && joinPayload.token !== this.token) {
      log("warn", `Peer ${peerId} rejected: invalid token`);
      const rejectMsg: SyncMessage = {
        type: "leave",
        roomId,
        peerId: "server",
        timestamp: timestamp(),
        payload: { reason: "invalid_token" },
      };
      ws.send(JSON.stringify(rejectMsg));
      ws.close(4001, "Invalid token");
      return false;
    }

    // Update tempId mapping
    if (this.peers.has(tempId)) {
      this.peers.delete(tempId);
    }

    const peerInfo: PeerInfo = {
      id: peerId,
      hostname: joinPayload.hostname ?? "unknown",
      label: joinPayload.label ?? joinPayload.hostname ?? "unknown",
      ip: joinPayload.ip ?? "unknown",
      platform: joinPayload.platform ?? "unknown",
      arch: joinPayload.arch ?? "unknown",
      joinedAt: timestamp(),
      lastSeen: timestamp(),
    };

    this.peers.set(peerId, { ws, info: peerInfo, roomId });

    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }
    this.rooms.get(roomId)!.add(peerId);

    log("info", `Peer ${peerId} joined room ${roomId} (${this.rooms.get(roomId)!.size} peers)`);

    // Broadcast updated peer list to room
    this.broadcastPeerList(roomId);

    // Send history to the new peer (session replay)
    this.sendHistory(ws, roomId);

    // Ask existing peers to send their current state to the new peer
    this.broadcast(roomId, {
      type: "request-sync",
      roomId,
      peerId,
      timestamp: timestamp(),
      payload: { requestedBy: peerId },
    }, peerId);

    return true;
  }

  private handleHeartbeat(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.info.lastSeen = timestamp();
    }
  }

  private handleRequestSync(msg: SyncMessage): void {
    // Forward sync request to all other peers in the room
    this.broadcast(msg.roomId, msg, msg.peerId);
  }

  // ── Session Replay ──────────────────────────────────────────────
  private addToHistory(roomId: string, msg: SyncMessage): void {
    if (!roomId) return;
    // Only store replayable message types
    // Only replay lightweight messages — file state is synced via request-sync
    const replayable = ["chat-message", "activity", "session-event"];
    if (!replayable.includes(msg.type)) return;

    if (!this.roomHistory.has(roomId)) {
      this.roomHistory.set(roomId, []);
    }
    const history = this.roomHistory.get(roomId)!;
    history.push({ msg, storedAt: timestamp() });

    // Trim old entries
    while (history.length > this.maxHistory) {
      history.shift();
    }
  }

  private sendHistory(ws: WebSocket, roomId: string): void {
    const history = this.roomHistory.get(roomId);
    if (!history || history.length === 0) return;

    const historyMsg: SyncMessage = {
      type: "history",
      roomId,
      peerId: "server",
      timestamp: timestamp(),
      payload: {
        messages: history.map((h) => h.msg),
        count: history.length,
      },
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(historyMsg));
    }
  }

  // ── Broadcast ───────────────────────────────────────────────────
  private broadcast(roomId: string, msg: SyncMessage, excludePeerId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const data = JSON.stringify(msg);
    for (const peerId of room) {
      if (peerId === excludePeerId) continue;
      const peer = this.peers.get(peerId);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(data);
      }
    }
  }

  private broadcastPeerList(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const peers: PeerInfo[] = [];
    for (const peerId of room) {
      const peer = this.peers.get(peerId);
      if (peer) peers.push(peer.info);
    }

    const msg: SyncMessage = {
      type: "peer-list",
      roomId,
      peerId: "server",
      timestamp: timestamp(),
      payload: { peers },
    };

    const data = JSON.stringify(msg);
    for (const peerId of room) {
      const peer = this.peers.get(peerId);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(data);
      }
    }
  }

  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const roomId = peer.roomId;
    this.peers.delete(peerId);

    const room = this.rooms.get(roomId);
    if (room) {
      room.delete(peerId);
      if (room.size === 0) {
        this.rooms.delete(roomId);
        // Keep history even when room empties — late joiners can still replay
        log("info", `Room ${roomId} closed (empty)`);
      } else {
        this.broadcastPeerList(roomId);
      }
    }

    log("info", `Peer ${peerId} disconnected`);
  }

  private checkHeartbeats(): void {
    const now = timestamp();
    for (const [peerId, peer] of this.peers) {
      if (now - peer.info.lastSeen > PEER_TIMEOUT) {
        log("warn", `Peer ${peerId} timed out`);
        peer.ws.terminate();
        this.removePeer(peerId);
      }
    }

    // Clean up stale history for rooms that have been empty for over 1 hour
    const HISTORY_TTL = 60 * 60 * 1000;
    for (const [roomId, history] of this.roomHistory) {
      if (!this.rooms.has(roomId) && history.length > 0) {
        const lastEntry = history[history.length - 1];
        if (now - lastEntry.storedAt > HISTORY_TTL) {
          this.roomHistory.delete(roomId);
          log("info", `Cleaned up stale history for room ${roomId}`);
        }
      }
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.wss) {
      // Terminate all connected clients so they get close events
      for (const [, peer] of this.peers) {
        peer.ws.terminate();
      }
      this.peers.clear();
      this.rooms.clear();
      this.wss.close();
      log("info", "Server stopped");
    }
  }
}

// Only auto-start when run directly (not when imported by CLI)
const isDirectExecution = process.argv[1]?.endsWith("server/index.js");
if (isDirectExecution) {
  const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const server = new SyncServer();
  server.start(port);

  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
}
