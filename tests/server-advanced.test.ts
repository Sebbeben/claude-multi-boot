import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { SyncServer } from "../src/server/index.js";
import { SyncMessage, PeerListPayload } from "../src/shared/types.js";

const ADV_PORT_BASE = 39600;
let advPortCounter = 0;
function nextPort(): number {
  return ADV_PORT_BASE + advPortCounter++;
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<SyncMessage> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => {
      resolve(JSON.parse(raw.toString()));
    });
  });
}

function createJoinMsg(peerId: string, roomId = "test-room", token?: string): SyncMessage {
  return {
    type: "join",
    roomId,
    peerId,
    timestamp: Date.now(),
    payload: {
      hostname: "test-host",
      label: peerId,
      ip: "1.2.3.4",
      platform: "linux",
      arch: "x64",
      ...(token ? { token } : {}),
    },
  };
}

describe("SyncServer — Token Authentication", () => {
  let server: SyncServer;
  let port: number;

  beforeEach(() => {
    port = nextPort();
  });

  afterEach(() => {
    server?.stop();
  });

  it("accepts clients with valid token", async () => {
    server = new SyncServer({ token: "secret123" });
    server.start(port);

    const ws = await connectClient(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify(createJoinMsg("peer-1", "room-a", "secret123")));
    const msg = await msgPromise;

    expect(msg.type).toBe("peer-list");
    const payload = msg.payload as PeerListPayload;
    expect(payload.peers).toHaveLength(1);

    ws.close();
  });

  it("rejects clients with invalid token", async () => {
    server = new SyncServer({ token: "secret123" });
    server.start(port);

    const ws = await connectClient(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify(createJoinMsg("peer-bad", "room-a", "wrong-token")));
    const msg = await msgPromise;

    expect(msg.type).toBe("leave");
    expect((msg.payload as { reason: string }).reason).toBe("invalid_token");

    // Connection should be closed
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      setTimeout(resolve, 2000);
    });
  });

  it("rejects clients with no token when token is required", async () => {
    server = new SyncServer({ token: "secret123" });
    server.start(port);

    const ws = await connectClient(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify(createJoinMsg("peer-notoken", "room-a")));
    const msg = await msgPromise;

    expect(msg.type).toBe("leave");
    expect((msg.payload as { reason: string }).reason).toBe("invalid_token");

    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      setTimeout(resolve, 2000);
    });
  });

  it("accepts all clients when no token is configured", async () => {
    server = new SyncServer();
    server.start(port);

    const ws = await connectClient(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify(createJoinMsg("peer-free")));
    const msg = await msgPromise;

    expect(msg.type).toBe("peer-list");
    ws.close();
  });
});

describe("SyncServer — Session Replay", () => {
  let server: SyncServer;
  let port: number;

  beforeEach(() => {
    port = nextPort();
    server = new SyncServer({ maxHistory: 50 });
    server.start(port);
  });

  afterEach(() => {
    server.stop();
  });

  it("sends history to newly joining peer", async () => {
    // Peer 1 joins and sends some chat messages
    const ws1 = await connectClient(port);
    ws1.send(JSON.stringify(createJoinMsg("peer-1")));
    await waitForMessage(ws1); // peer-list

    // Send 3 chat messages
    for (let i = 0; i < 3; i++) {
      ws1.send(JSON.stringify({
        type: "chat-message",
        roomId: "test-room",
        peerId: "peer-1",
        timestamp: Date.now(),
        payload: { text: `msg-${i}`, machineLabel: "peer-1", machineIp: "1.2.3.4" },
      }));
    }
    await new Promise((r) => setTimeout(r, 200));

    // Peer 2 joins — should get history
    const ws2 = await connectClient(port);
    const messages: SyncMessage[] = [];
    ws2.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws2.send(JSON.stringify(createJoinMsg("peer-2")));
    await new Promise((r) => setTimeout(r, 500));

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeDefined();
    const histPayload = historyMsg!.payload as { messages: SyncMessage[]; count: number };
    expect(histPayload.count).toBe(3);
    expect(histPayload.messages[0].type).toBe("chat-message");

    ws1.close();
    ws2.close();
  });

  it("limits history to maxHistory entries", async () => {
    const ws1 = await connectClient(port);
    ws1.send(JSON.stringify(createJoinMsg("peer-1")));
    await waitForMessage(ws1);

    // Send 60 messages (maxHistory is 50)
    for (let i = 0; i < 60; i++) {
      ws1.send(JSON.stringify({
        type: "chat-message",
        roomId: "test-room",
        peerId: "peer-1",
        timestamp: Date.now(),
        payload: { text: `msg-${i}`, machineLabel: "peer-1", machineIp: "1.2.3.4" },
      }));
    }
    await new Promise((r) => setTimeout(r, 300));

    const ws2 = await connectClient(port);
    const messages: SyncMessage[] = [];
    ws2.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws2.send(JSON.stringify(createJoinMsg("peer-2")));
    await new Promise((r) => setTimeout(r, 500));

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeDefined();
    const histPayload = historyMsg!.payload as { messages: SyncMessage[]; count: number };
    expect(histPayload.count).toBe(50);

    ws1.close();
    ws2.close();
  });

  it("does not replay heartbeat or peer-list messages", async () => {
    const ws1 = await connectClient(port);
    ws1.send(JSON.stringify(createJoinMsg("peer-1")));
    await waitForMessage(ws1);

    // Send a heartbeat
    ws1.send(JSON.stringify({
      type: "heartbeat",
      roomId: "test-room",
      peerId: "peer-1",
      timestamp: Date.now(),
      payload: null,
    }));

    // Send a chat (this should be in history)
    ws1.send(JSON.stringify({
      type: "chat-message",
      roomId: "test-room",
      peerId: "peer-1",
      timestamp: Date.now(),
      payload: { text: "hello", machineLabel: "peer-1", machineIp: "1.2.3.4" },
    }));

    await new Promise((r) => setTimeout(r, 200));

    const ws2 = await connectClient(port);
    const messages: SyncMessage[] = [];
    ws2.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws2.send(JSON.stringify(createJoinMsg("peer-2")));
    await new Promise((r) => setTimeout(r, 500));

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeDefined();
    const histPayload = historyMsg!.payload as { messages: SyncMessage[]; count: number };
    // Only chat message, not heartbeat
    expect(histPayload.count).toBe(1);
    expect(histPayload.messages[0].type).toBe("chat-message");

    ws1.close();
    ws2.close();
  });

  it("preserves history after room empties", async () => {
    const ws1 = await connectClient(port);
    ws1.send(JSON.stringify(createJoinMsg("peer-1")));
    await waitForMessage(ws1);

    ws1.send(JSON.stringify({
      type: "chat-message",
      roomId: "test-room",
      peerId: "peer-1",
      timestamp: Date.now(),
      payload: { text: "before-empty", machineLabel: "p1", machineIp: "1.1.1.1" },
    }));
    await new Promise((r) => setTimeout(r, 100));

    // Room empties
    ws1.close();
    await new Promise((r) => setTimeout(r, 300));

    // New peer joins the same room
    const ws2 = await connectClient(port);
    const messages: SyncMessage[] = [];
    ws2.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws2.send(JSON.stringify(createJoinMsg("peer-2")));
    await new Promise((r) => setTimeout(r, 500));

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeDefined();
    const histPayload = historyMsg!.payload as { messages: SyncMessage[]; count: number };
    expect(histPayload.count).toBe(1);
    expect((histPayload.messages[0].payload as { text: string }).text).toBe("before-empty");

    ws2.close();
  });
});

describe("SyncServer — Message Size Limit", () => {
  it("enforces maxPayload on incoming messages", async () => {
    const port = nextPort();
    const server = new SyncServer();
    server.start(port);

    const ws = await connectClient(port);
    ws.send(JSON.stringify(createJoinMsg("peer-1")));
    await waitForMessage(ws);

    // Send a very large message (over 2MB)
    const hugePayload = "x".repeat(3 * 1024 * 1024);
    let errorOccurred = false;
    ws.on("error", () => { errorOccurred = true; });
    ws.on("close", () => { errorOccurred = true; });

    ws.send(JSON.stringify({
      type: "chat-message",
      roomId: "test-room",
      peerId: "peer-1",
      timestamp: Date.now(),
      payload: { text: hugePayload, machineLabel: "p1", machineIp: "1.1.1.1" },
    }));

    await new Promise((r) => setTimeout(r, 500));
    expect(errorOccurred).toBe(true);

    server.stop();
  });
});
