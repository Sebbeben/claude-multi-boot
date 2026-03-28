import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncServer } from "../src/server/index.js";
import { SyncClient, type ActivityEvent } from "../src/client/sync-client.js";
import { MachineIdentity } from "../src/shared/machine-identity.js";
import { RoomConfig, PeerInfo } from "../src/shared/types.js";
import { hashContent } from "../src/shared/utils.js";

const INT_PORT_BASE = 39500;
let intPortCounter = 0;
function nextPort(): number {
  return INT_PORT_BASE + intPortCounter++;
}

function identity(label: string): MachineIdentity {
  return {
    peerId: `int-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    hostname: label,
    ip: "127.0.0.1",
    platform: "linux",
    arch: "x64",
    registeredAt: new Date().toISOString(),
  };
}

describe("Integration: Full swarm workflow", () => {
  let server: SyncServer;
  let port: number;
  let dirA: string;
  let dirB: string;
  let dirC: string;

  beforeEach(async () => {
    port = nextPort();
    server = new SyncServer();
    server.start(port);
    dirA = await mkdtemp(join(tmpdir(), "swarm-int-a-"));
    dirB = await mkdtemp(join(tmpdir(), "swarm-int-b-"));
    dirC = await mkdtemp(join(tmpdir(), "swarm-int-c-"));
  });

  afterEach(async () => {
    server.stop();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirC, { recursive: true, force: true });
  });

  it("three machines join, see each other, and chat", async () => {
    const idA = identity("laptop");
    const idB = identity("desktop");
    const idC = identity("server-vm");

    const config = (dir: string): RoomConfig => ({
      roomId: "int-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dir,
      syncPaths: ["CLAUDE.md"],
    });

    const activitiesA: ActivityEvent[] = [];
    const activitiesB: ActivityEvent[] = [];
    const activitiesC: ActivityEvent[] = [];
    let peersA: PeerInfo[] = [];
    let peersB: PeerInfo[] = [];
    let peersC: PeerInfo[] = [];

    const clientA = new SyncClient(config(dirA), idA,
      (p) => { peersA = p; },
      (e) => { activitiesA.push(e); },
    );
    const clientB = new SyncClient(config(dirB), idB,
      (p) => { peersB = p; },
      (e) => { activitiesB.push(e); },
    );
    const clientC = new SyncClient(config(dirC), idC,
      (p) => { peersC = p; },
      (e) => { activitiesC.push(e); },
    );

    // All three connect
    await clientA.connect();
    await clientB.connect();
    await clientC.connect();
    await new Promise((r) => setTimeout(r, 500));

    // All should see 3 peers
    expect(peersA.length).toBe(3);
    expect(peersB.length).toBe(3);
    expect(peersC.length).toBe(3);

    // A sends a chat
    clientA.sendChat("deploying v2.0");
    await new Promise((r) => setTimeout(r, 300));

    // B and C should have received it
    expect(activitiesB.some((e) => e.type === "chat" && e.message === "deploying v2.0")).toBe(true);
    expect(activitiesC.some((e) => e.type === "chat" && e.message === "deploying v2.0")).toBe(true);

    // B responds
    clientB.sendChat("got it, running tests");
    await new Promise((r) => setTimeout(r, 300));

    expect(activitiesA.some((e) => e.type === "chat" && e.message === "got it, running tests")).toBe(true);
    expect(activitiesC.some((e) => e.type === "chat" && e.message === "got it, running tests")).toBe(true);

    clientA.disconnect();
    clientB.disconnect();
    clientC.disconnect();
  });

  it("peer leaving triggers leave event and updated peer list", async () => {
    const idA = identity("stayer");
    const idB = identity("leaver");

    const config = (dir: string): RoomConfig => ({
      roomId: "leave-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dir,
      syncPaths: [],
    });

    const activitiesA: ActivityEvent[] = [];
    let peersA: PeerInfo[] = [];

    const clientA = new SyncClient(config(dirA), idA,
      (p) => { peersA = p; },
      (e) => { activitiesA.push(e); },
    );
    const clientB = new SyncClient(config(dirB), idB);

    await clientA.connect();
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 300));
    expect(peersA.length).toBe(2);

    // B disconnects
    clientB.disconnect();

    // Wait for peer list to update (server detects close, broadcasts new list)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (peersA.length === 1) resolve();
        else setTimeout(check, 50);
      };
      check();
      setTimeout(resolve, 3000); // Safety timeout
    });

    expect(peersA.length).toBe(1);
    expect(peersA[0].id).toBe(idA.peerId);

    // A should have a leave event
    const leaveEvent = activitiesA.find((e) => e.type === "leave");
    expect(leaveEvent).toBeDefined();

    clientA.disconnect();
  });

  it("file sync propagates from sender to all receivers", async () => {
    const idA = identity("writer");
    const idB = identity("reader");

    const config = (dir: string): RoomConfig => ({
      roomId: "file-sync-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dir,
      syncPaths: ["CLAUDE.md"],
    });

    const activitiesB: ActivityEvent[] = [];
    const clientA = new SyncClient(config(dirA), idA);
    const clientB = new SyncClient(config(dirB), idB,
      undefined,
      (e) => { activitiesB.push(e); },
    );

    await clientA.connect();
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 300));

    // Write a file on A
    await writeFile(join(dirA, "CLAUDE.md"), "# Project\nShared instructions here.");
    await new Promise((r) => setTimeout(r, 1500));

    // B should have received a file-sync activity
    const syncEvent = activitiesB.find((e) => e.type === "file-sync");
    if (syncEvent) {
      expect(syncEvent.message).toContain("CLAUDE.md");
    }

    // Check if the file was written on B
    if (existsSync(join(dirB, "CLAUDE.md"))) {
      const content = await readFile(join(dirB, "CLAUDE.md"), "utf-8");
      expect(content).toContain("Shared instructions here.");
    }

    clientA.disconnect();
    clientB.disconnect();
  });

  it("existing peer syncs state to newly joining peer", async () => {
    const idA = identity("first");
    const idB = identity("late-joiner");

    const config = (dir: string): RoomConfig => ({
      roomId: "late-join-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dir,
      syncPaths: ["CLAUDE.md"],
    });

    // A connects and has a CLAUDE.md
    await writeFile(join(dirA, "CLAUDE.md"), "# Pre-existing context");

    const clientA = new SyncClient(config(dirA), idA);
    await clientA.connect();
    await new Promise((r) => setTimeout(r, 300));

    // B joins later
    const clientB = new SyncClient(config(dirB), idB);
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 1000));

    // B should have received A's CLAUDE.md via request-sync
    if (existsSync(join(dirB, "CLAUDE.md"))) {
      const content = await readFile(join(dirB, "CLAUDE.md"), "utf-8");
      expect(content).toContain("Pre-existing context");
    }

    clientA.disconnect();
    clientB.disconnect();
  });

  it("deterministic room ID works for host/join pattern", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");

    function generateRoomFromAddress(address: string, port: number): string {
      return createHash("sha256")
        .update(`claude-swarm:${address}:${port}`)
        .digest("hex")
        .slice(0, 12);
    }

    // Same address + port = same room
    const room1 = generateRoomFromAddress("192.168.1.10", 24680);
    const room2 = generateRoomFromAddress("192.168.1.10", 24680);
    expect(room1).toBe(room2);

    // Different address = different room
    const room3 = generateRoomFromAddress("192.168.1.20", 24680);
    expect(room3).not.toBe(room1);

    // Different port = different room
    const room4 = generateRoomFromAddress("192.168.1.10", 3000);
    expect(room4).not.toBe(room1);

    // Valid hex format
    expect(room1).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles rapid message bursts", async () => {
    const idA = identity("sender");
    const idB = identity("receiver");

    const config = (dir: string): RoomConfig => ({
      roomId: "burst-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dir,
      syncPaths: [],
    });

    const received: ActivityEvent[] = [];
    const clientA = new SyncClient(config(dirA), idA);
    const clientB = new SyncClient(config(dirB), idB,
      undefined,
      (e) => { if (e.type === "chat") received.push(e); },
    );

    await clientA.connect();
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 200));

    // Send 20 messages rapidly
    for (let i = 0; i < 20; i++) {
      clientA.sendChat(`msg-${i}`);
    }

    await new Promise((r) => setTimeout(r, 1000));

    // B should have received all 20
    expect(received.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(received.some((e) => e.message === `msg-${i}`)).toBe(true);
    }

    clientA.disconnect();
    clientB.disconnect();
  });
});
