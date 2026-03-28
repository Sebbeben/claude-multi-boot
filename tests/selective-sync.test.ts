import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncServer } from "../src/server/index.js";
import { SyncClient, type ActivityEvent } from "../src/client/sync-client.js";
import { MachineIdentity } from "../src/shared/machine-identity.js";
import { RoomConfig, SyncFilter } from "../src/shared/types.js";

const SEL_PORT_BASE = 39700;
let selPortCounter = 0;
function nextPort(): number {
  return SEL_PORT_BASE + selPortCounter++;
}

function identity(label: string): MachineIdentity {
  return {
    peerId: `sel-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    hostname: label,
    ip: "127.0.0.1",
    platform: "linux",
    arch: "x64",
    registeredAt: new Date().toISOString(),
  };
}

describe("Selective Sync Filters", () => {
  let server: SyncServer;
  let port: number;
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    port = nextPort();
    server = new SyncServer();
    server.start(port);
    dirA = await mkdtemp(join(tmpdir(), "sel-a-"));
    dirB = await mkdtemp(join(tmpdir(), "sel-b-"));
  });

  afterEach(async () => {
    server.stop();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("receives all messages when no filter is set", async () => {
    const idA = identity("sender");
    const idB = identity("receiver");

    const configA: RoomConfig = {
      roomId: "sel-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dirA,
      syncPaths: [],
    };
    const configB: RoomConfig = {
      roomId: "sel-room",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dirB,
      syncPaths: [],
    };

    const activitiesB: ActivityEvent[] = [];
    const clientA = new SyncClient(configA, idA);
    const clientB = new SyncClient(configB, idB, undefined, (e) => activitiesB.push(e));

    await clientA.connect();
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 200));

    clientA.sendChat("hello");
    await new Promise((r) => setTimeout(r, 300));

    expect(activitiesB.some((e) => e.type === "chat" && e.message === "hello")).toBe(true);

    clientA.disconnect();
    clientB.disconnect();
  });

  it("filters out excluded message types", async () => {
    const idA = identity("sender");
    const idB = identity("filtered");

    const configA: RoomConfig = {
      roomId: "sel-room-2",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dirA,
      syncPaths: [],
    };
    const filter: SyncFilter = {
      messageTypes: ["peer-list"], // Only receive peer-list, nothing else
    };
    const configB: RoomConfig = {
      roomId: "sel-room-2",
      serverUrl: `ws://localhost:${port}`,
      projectPath: dirB,
      syncPaths: [],
      syncFilter: filter,
    };

    const activitiesB: ActivityEvent[] = [];
    const clientA = new SyncClient(configA, idA);
    const clientB = new SyncClient(configB, idB, undefined, (e) => activitiesB.push(e));

    await clientA.connect();
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 200));

    clientA.sendChat("this should be filtered");
    await new Promise((r) => setTimeout(r, 300));

    // B should NOT receive chat messages (only peer-list allowed)
    const chatEvents = activitiesB.filter((e) => e.type === "chat" && e.message === "this should be filtered");
    expect(chatEvents.length).toBe(0);

    clientA.disconnect();
    clientB.disconnect();
  });
});
