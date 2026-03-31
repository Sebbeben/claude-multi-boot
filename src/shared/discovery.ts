/**
 * LAN auto-discovery using UDP broadcast.
 *
 * We use a simple UDP broadcast/listen approach instead of mDNS
 * to avoid external dependencies. Machines broadcast their presence
 * on a well-known port and listen for others.
 */

import { createSocket, Socket } from "node:dgram";
import { getLocalIp } from "./machine-identity.js";
import { log } from "./utils.js";

const DISCOVERY_PORT = 24681; // One above default relay port
const BROADCAST_INTERVAL = 2000;
const DISCOVERY_MAGIC = "claude-mesh-v1";

export interface DiscoveredHost {
  address: string;
  port: number;
  roomId: string;
  label: string;
  tokenRequired: boolean;
  discoveredAt: number;
}

export class DiscoveryBroadcaster {
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private payload: string;

  constructor(
    private relayPort: number,
    private roomId: string,
    private label: string,
    private tokenRequired?: boolean,
  ) {
    // Never broadcast the actual token — only whether one is required
    this.payload = JSON.stringify({
      magic: DISCOVERY_MAGIC,
      address: getLocalIp(),
      port: relayPort,
      roomId,
      label,
      tokenRequired: tokenRequired ?? false,
    });
  }

  start(): void {
    this.socket = createSocket({ type: "udp4", reuseAddr: true });
    this.socket.bind(() => {
      this.socket!.setBroadcast(true);
      log("info", `Broadcasting mesh on UDP ${DISCOVERY_PORT}`);
    });

    this.timer = setInterval(() => {
      const buf = Buffer.from(this.payload);
      this.socket?.send(buf, 0, buf.length, DISCOVERY_PORT, "255.255.255.255");
    }, BROADCAST_INTERVAL);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      if (this.socket) this.socket.close();
    } catch {
      // Already closed
    }
    this.socket = null;
  }
}

export class DiscoveryListener {
  private socket: Socket | null = null;
  private discovered = new Map<string, DiscoveredHost>();

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createSocket({ type: "udp4", reuseAddr: true });

      this.socket.on("message", (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.magic !== DISCOVERY_MAGIC) return;

          const key = `${data.address}:${data.port}`;
          this.discovered.set(key, {
            address: data.address,
            port: data.port,
            roomId: data.roomId,
            label: data.label,
            tokenRequired: data.tokenRequired ?? false,
            discoveredAt: Date.now(),
          });
        } catch {
          // Ignore non-JSON packets
        }
      });

      this.socket.on("error", reject);

      this.socket.bind(DISCOVERY_PORT, () => {
        log("info", `Listening for mesh broadcasts on UDP ${DISCOVERY_PORT}`);
        resolve();
      });
    });
  }

  /**
   * Wait for at least one host to be discovered, with timeout.
   */
  async waitForHost(timeoutMs = 10000): Promise<DiscoveredHost | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.discovered.size > 0) {
        // Return the most recently discovered host
        const hosts = [...this.discovered.values()];
        return hosts[hosts.length - 1];
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  getDiscoveredHosts(): DiscoveredHost[] {
    return [...this.discovered.values()];
  }

  stop(): void {
    try {
      if (this.socket) this.socket.close();
    } catch {
      // Already closed
    }
    this.socket = null;
  }
}
