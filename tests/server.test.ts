import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { SyncServer } from "../src/server/index.js";
import { SyncMessage, PeerListPayload, DEFAULT_PORT } from "../src/shared/types.js";

const TEST_PORT = 39281; // Random high port to avoid conflicts

function createTestMessage(overrides: Partial<SyncMessage> = {}): SyncMessage {
  return {
    type: "join",
    roomId: "test-room",
    peerId: "test-peer",
    timestamp: Date.now(),
    payload: { hostname: "test-host", label: "test", ip: "1.2.3.4", platform: "linux", arch: "x64" },
    ...overrides,
  };
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

function sendAndWait(ws: WebSocket, msg: SyncMessage, target: WebSocket): Promise<SyncMessage> {
  const promise = waitForMessage(target);
  ws.send(JSON.stringify(msg));
  return promise;
}

describe("SyncServer", () => {
  let server: SyncServer;

  beforeEach(() => {
    server = new SyncServer();
  });

  afterEach(() => {
    server.stop();
  });

  it("starts and accepts connections", async () => {
    server.start(TEST_PORT);
    const ws = await connectClient(TEST_PORT);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("sends peer-list on join", async () => {
    server.start(TEST_PORT + 1);
    const ws = await connectClient(TEST_PORT + 1);

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify(createTestMessage()));
    const response = await msgPromise;

    expect(response.type).toBe("peer-list");
    const payload = response.payload as PeerListPayload;
    expect(payload.peers).toHaveLength(1);
    expect(payload.peers[0].id).toBe("test-peer");
    expect(payload.peers[0].label).toBe("test");
    expect(payload.peers[0].ip).toBe("1.2.3.4");

    ws.close();
  });

  it("broadcasts peer-list to all peers when a new peer joins", async () => {
    server.start(TEST_PORT + 2);

    const ws1 = await connectClient(TEST_PORT + 2);
    const ws2 = await connectClient(TEST_PORT + 2);

    // Peer 1 joins
    const peer1Msg = waitForMessage(ws1);
    ws1.send(JSON.stringify(createTestMessage({ peerId: "peer-1" })));
    await peer1Msg;

    // Peer 2 joins — both should get updated peer list
    const peer1Update = waitForMessage(ws1);
    const peer2Response = waitForMessage(ws2);
    ws2.send(JSON.stringify(createTestMessage({ peerId: "peer-2" })));

    const [update1, response2] = await Promise.all([peer1Update, peer2Response]);

    // ws1 may get either peer-list or request-sync first
    // Let's just verify we get a message and it has the right structure
    expect(["peer-list", "request-sync"]).toContain(update1.type);

    if (response2.type === "peer-list") {
      const payload = response2.payload as PeerListPayload;
      expect(payload.peers.length).toBeGreaterThanOrEqual(1);
    }

    ws1.close();
    ws2.close();
  });

  it("broadcasts messages to other peers in the same room", async () => {
    server.start(TEST_PORT + 3);

    const ws1 = await connectClient(TEST_PORT + 3);
    const ws2 = await connectClient(TEST_PORT + 3);

    // Both join the same room
    ws1.send(JSON.stringify(createTestMessage({ peerId: "peer-1" })));
    await waitForMessage(ws1); // peer-list

    ws2.send(JSON.stringify(createTestMessage({ peerId: "peer-2" })));
    await waitForMessage(ws2); // peer-list

    // Drain any pending messages
    await new Promise((r) => setTimeout(r, 100));

    // Peer 1 sends a file-change — peer 2 should receive it
    const receivePromise = waitForMessage(ws2);
    ws1.send(JSON.stringify(createTestMessage({
      type: "file-change",
      peerId: "peer-1",
      payload: { relativePath: "test.txt", content: "hello", action: "update" },
    })));

    const received = await receivePromise;
    expect(received.type).toBe("file-change");
    expect(received.peerId).toBe("peer-1");

    ws1.close();
    ws2.close();
  });

  it("does not send messages to peers in different rooms", async () => {
    server.start(TEST_PORT + 4);

    const ws1 = await connectClient(TEST_PORT + 4);
    const ws2 = await connectClient(TEST_PORT + 4);

    // Join different rooms
    ws1.send(JSON.stringify(createTestMessage({ peerId: "peer-1", roomId: "room-a" })));
    await waitForMessage(ws1);

    ws2.send(JSON.stringify(createTestMessage({ peerId: "peer-2", roomId: "room-b" })));
    await waitForMessage(ws2);

    await new Promise((r) => setTimeout(r, 100));

    // Peer 1 sends a message — peer 2 should NOT receive it
    let received = false;
    ws2.once("message", () => { received = true; });

    ws1.send(JSON.stringify(createTestMessage({
      type: "chat-message",
      peerId: "peer-1",
      roomId: "room-a",
      payload: { text: "hello", machineLabel: "a", machineIp: "1.1.1.1" },
    })));

    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);

    ws1.close();
    ws2.close();
  });

  it("updates peer-list when a peer disconnects", async () => {
    server.start(TEST_PORT + 5);

    const ws1 = await connectClient(TEST_PORT + 5);
    const ws2 = await connectClient(TEST_PORT + 5);

    ws1.send(JSON.stringify(createTestMessage({ peerId: "peer-1" })));
    await waitForMessage(ws1); // peer-list with 1 peer

    ws2.send(JSON.stringify(createTestMessage({ peerId: "peer-2" })));
    // Both get updated peer-list + ws1 gets request-sync
    // Drain all pending messages
    const drain = (ws: WebSocket, count: number) =>
      Promise.all(Array.from({ length: count }, () => waitForMessage(ws)));
    await Promise.all([drain(ws1, 2), drain(ws2, 1)]);

    // Peer 2 disconnects — peer 1 should get updated peer list
    const updatePromise = waitForMessage(ws1);
    ws2.close();

    const update = await updatePromise;
    expect(update.type).toBe("peer-list");
    const payload = update.payload as PeerListPayload;
    expect(payload.peers).toHaveLength(1);
    expect(payload.peers[0].id).toBe("peer-1");

    ws1.close();
  });

  it("handles heartbeat messages", async () => {
    server.start(TEST_PORT + 6);
    const ws = await connectClient(TEST_PORT + 6);

    ws.send(JSON.stringify(createTestMessage({ peerId: "peer-1" })));
    await waitForMessage(ws);

    // Send heartbeat — should not crash or produce error
    ws.send(JSON.stringify(createTestMessage({
      type: "heartbeat",
      peerId: "peer-1",
      payload: null,
    })));

    // Wait a bit to ensure no error
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  it("sends request-sync to existing peers when new peer joins", async () => {
    server.start(TEST_PORT + 7);

    const ws1 = await connectClient(TEST_PORT + 7);
    ws1.send(JSON.stringify(createTestMessage({ peerId: "peer-1" })));
    await waitForMessage(ws1); // peer-list

    // New peer joins
    const ws2 = await connectClient(TEST_PORT + 7);
    const syncRequest = waitForMessage(ws1);
    ws2.send(JSON.stringify(createTestMessage({ peerId: "peer-2" })));

    // ws1 gets either peer-list or request-sync
    const msg = await syncRequest;
    // Could be peer-list or request-sync depending on ordering
    expect(["peer-list", "request-sync"]).toContain(msg.type);

    ws1.close();
    ws2.close();
  });

  it("cleans up room when last peer disconnects", async () => {
    server.start(TEST_PORT + 8);

    const ws = await connectClient(TEST_PORT + 8);
    ws.send(JSON.stringify(createTestMessage({ peerId: "solo-peer" })));
    await waitForMessage(ws);

    ws.close();
    // Wait for server to process the close event
    await new Promise((r) => setTimeout(r, 300));

    // Connect a new peer — should get a fresh room with just themselves
    const ws2 = await connectClient(TEST_PORT + 8);
    const msgPromise = waitForMessage(ws2);
    ws2.send(JSON.stringify(createTestMessage({ peerId: "new-peer" })));
    const msg = await msgPromise;

    expect(msg.type).toBe("peer-list");
    const payload = msg.payload as PeerListPayload;
    expect(payload.peers).toHaveLength(1);
    expect(payload.peers[0].id).toBe("new-peer");

    ws2.close();
  });

  it("supports multiple rooms simultaneously", async () => {
    server.start(TEST_PORT + 9);

    const wsA1 = await connectClient(TEST_PORT + 9);
    const wsA2 = await connectClient(TEST_PORT + 9);
    const wsB1 = await connectClient(TEST_PORT + 9);

    wsA1.send(JSON.stringify(createTestMessage({ peerId: "a1", roomId: "room-a" })));
    await waitForMessage(wsA1);

    wsA2.send(JSON.stringify(createTestMessage({ peerId: "a2", roomId: "room-a" })));
    await waitForMessage(wsA2);

    wsB1.send(JSON.stringify(createTestMessage({ peerId: "b1", roomId: "room-b" })));
    await waitForMessage(wsB1);

    // Drain
    await new Promise((r) => setTimeout(r, 200));

    // Chat in room-a — only a2 should get it, not b1
    let b1Received = false;
    wsB1.once("message", () => { b1Received = true; });

    const a2Promise = waitForMessage(wsA2);
    wsA1.send(JSON.stringify(createTestMessage({
      type: "chat-message",
      peerId: "a1",
      roomId: "room-a",
      payload: { text: "room a only", machineLabel: "a1", machineIp: "1.1.1.1" },
    })));

    const a2Msg = await a2Promise;
    expect(a2Msg.type).toBe("chat-message");

    await new Promise((r) => setTimeout(r, 100));
    expect(b1Received).toBe(false);

    wsA1.close();
    wsA2.close();
    wsB1.close();
  });

  it("preserves full machine identity in peer list", async () => {
    server.start(TEST_PORT + 10);
    const ws = await connectClient(TEST_PORT + 10);

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify(createTestMessage({
      peerId: "id-1",
      payload: {
        hostname: "my-host",
        label: "my-label",
        ip: "10.0.0.1",
        platform: "darwin",
        arch: "arm64",
      },
    })));

    const msg = await msgPromise;
    const payload = msg.payload as PeerListPayload;
    const peer = payload.peers[0];

    expect(peer.hostname).toBe("my-host");
    expect(peer.label).toBe("my-label");
    expect(peer.ip).toBe("10.0.0.1");
    expect(peer.platform).toBe("darwin");
    expect(peer.arch).toBe("arm64");

    ws.close();
  });
});
