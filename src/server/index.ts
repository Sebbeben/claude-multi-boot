import { WebSocketServer, WebSocket } from "ws";
import {
  SyncMessage,
  PeerInfo,
  HEARTBEAT_INTERVAL,
  PEER_TIMEOUT,
  DEFAULT_PORT,
} from "../shared/types.js";
import { generatePeerId, timestamp, log } from "../shared/utils.js";

interface ConnectedPeer {
  ws: WebSocket;
  info: PeerInfo;
  roomId: string;
}

export class SyncServer {
  private wss: WebSocketServer | null = null;
  private peers = new Map<string, ConnectedPeer>();
  private rooms = new Map<string, Set<string>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  start(port: number = DEFAULT_PORT): void {
    this.wss = new WebSocketServer({ port });

    log("info", `Relay server listening on ws://0.0.0.0:${port}`);

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
      case "join":
        this.handleJoin(ws, msg, currentPeerId);
        return msg.peerId; // Return the real peerId so close handler uses it

      case "heartbeat":
        this.handleHeartbeat(msg.peerId);
        return undefined;

      case "request-sync":
        this.handleRequestSync(msg);
        return undefined;

      default:
        this.broadcast(msg.roomId, msg, msg.peerId);
        return undefined;
    }
  }

  private handleJoin(ws: WebSocket, msg: SyncMessage, tempId: string): void {
    const peerId = msg.peerId;
    const roomId = msg.roomId;

    // Update tempId mapping
    if (this.peers.has(tempId)) {
      this.peers.delete(tempId);
    }

    const joinPayload = msg.payload as {
      hostname?: string;
      label?: string;
      ip?: string;
      platform?: string;
      arch?: string;
    };

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

    // Ask existing peers to send their current state to the new peer
    this.broadcast(roomId, {
      type: "request-sync",
      roomId,
      peerId,
      timestamp: timestamp(),
      payload: { requestedBy: peerId },
    }, peerId);
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
