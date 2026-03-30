import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { SyncServer } from "../src/server/index.js";
import { SyncMessage, ExecOutputPayload, ExecExitPayload } from "../src/shared/types.js";

const TEST_PORT = 39480; // Offset from other test suites to avoid collisions

function createJoinMessage(peerId: string, roomId = "test-room"): SyncMessage {
  return {
    type: "join",
    roomId,
    peerId,
    timestamp: Date.now(),
    payload: { hostname: `${peerId}-host`, label: peerId, ip: "1.2.3.4", platform: "linux", arch: "x64" },
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

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<SyncMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: SyncMessage[] = [];
    const timer = setTimeout(() => {
      ws.removeAllListeners("message");
      resolve(messages); // resolve with whatever we got
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
}

describe("Exec", () => {
  let server: SyncServer;

  beforeEach(() => {
    server = new SyncServer();
  });

  afterEach(() => {
    server.stop();
  });

  it("routes exec-request to the target peer", async () => {
    server.start(TEST_PORT);

    const ws1 = await connectClient(TEST_PORT);
    const ws2 = await connectClient(TEST_PORT);

    // Both join the same room
    ws1.send(JSON.stringify(createJoinMessage("requester")));
    await waitForMessage(ws1); // peer-list

    ws2.send(JSON.stringify(createJoinMessage("executor")));
    // Drain join messages (peer-list, request-sync, etc.)
    await new Promise((r) => setTimeout(r, 300));
    // Flush any pending messages
    ws1.removeAllListeners("message");
    ws2.removeAllListeners("message");

    // Send exec-request from ws1 targeting ws2
    const execPromise = waitForMessage(ws2);
    ws1.send(JSON.stringify({
      type: "exec-request",
      roomId: "test-room",
      peerId: "requester",
      timestamp: Date.now(),
      targetPeerId: "executor",
      payload: { execId: "test-exec-1", command: "echo hello" },
    } satisfies SyncMessage));

    const received = await execPromise;
    expect(received.type).toBe("exec-request");
    expect(received.peerId).toBe("requester");
    expect(received.targetPeerId).toBe("executor");
    expect((received.payload as { command: string }).command).toBe("echo hello");

    ws1.close();
    ws2.close();
  });

  it("does not broadcast exec-request to other peers", async () => {
    server.start(TEST_PORT + 1);

    const ws1 = await connectClient(TEST_PORT + 1);
    const ws2 = await connectClient(TEST_PORT + 1);
    const ws3 = await connectClient(TEST_PORT + 1);

    ws1.send(JSON.stringify(createJoinMessage("requester")));
    await waitForMessage(ws1);
    ws2.send(JSON.stringify(createJoinMessage("executor")));
    await waitForMessage(ws2);
    ws3.send(JSON.stringify(createJoinMessage("bystander")));
    await waitForMessage(ws3);

    await new Promise((r) => setTimeout(r, 300));
    ws3.removeAllListeners("message");

    // Track if bystander receives anything
    let bystanderReceived = false;
    ws3.once("message", () => { bystanderReceived = true; });

    // Send exec-request targeting executor only
    ws1.send(JSON.stringify({
      type: "exec-request",
      roomId: "test-room",
      peerId: "requester",
      timestamp: Date.now(),
      targetPeerId: "executor",
      payload: { execId: "test-exec-2", command: "echo hello" },
    } satisfies SyncMessage));

    await new Promise((r) => setTimeout(r, 300));
    expect(bystanderReceived).toBe(false);

    ws1.close();
    ws2.close();
    ws3.close();
  });

  it("blocks cross-room exec-request", async () => {
    server.start(TEST_PORT + 2);

    const ws1 = await connectClient(TEST_PORT + 2);
    const ws2 = await connectClient(TEST_PORT + 2);

    // Join DIFFERENT rooms
    ws1.send(JSON.stringify(createJoinMessage("attacker", "room-a")));
    await waitForMessage(ws1);
    ws2.send(JSON.stringify(createJoinMessage("victim", "room-b")));
    await waitForMessage(ws2);

    await new Promise((r) => setTimeout(r, 200));
    ws2.removeAllListeners("message");

    let victimReceived = false;
    ws2.once("message", () => { victimReceived = true; });

    // Attacker tries to exec on victim in a different room
    ws1.send(JSON.stringify({
      type: "exec-request",
      roomId: "room-a",
      peerId: "attacker",
      timestamp: Date.now(),
      targetPeerId: "victim",
      payload: { execId: "evil-exec", command: "rm -rf /" },
    } satisfies SyncMessage));

    await new Promise((r) => setTimeout(r, 300));
    expect(victimReceived).toBe(false);

    ws1.close();
    ws2.close();
  });

  it("routes exec-output back to requester only", async () => {
    server.start(TEST_PORT + 3);

    const ws1 = await connectClient(TEST_PORT + 3);
    const ws2 = await connectClient(TEST_PORT + 3);
    const ws3 = await connectClient(TEST_PORT + 3);

    ws1.send(JSON.stringify(createJoinMessage("requester")));
    await waitForMessage(ws1);
    ws2.send(JSON.stringify(createJoinMessage("executor")));
    await waitForMessage(ws2);
    ws3.send(JSON.stringify(createJoinMessage("bystander")));
    await waitForMessage(ws3);

    await new Promise((r) => setTimeout(r, 300));
    ws1.removeAllListeners("message");
    ws3.removeAllListeners("message");

    let bystanderReceived = false;
    ws3.once("message", () => { bystanderReceived = true; });

    // Executor sends output back to requester
    const outputPromise = waitForMessage(ws1);
    ws2.send(JSON.stringify({
      type: "exec-output",
      roomId: "test-room",
      peerId: "executor",
      timestamp: Date.now(),
      targetPeerId: "requester",
      payload: { execId: "test-exec-3", stream: "stdout", data: "hello world\n" },
    } satisfies SyncMessage));

    const output = await outputPromise;
    expect(output.type).toBe("exec-output");
    expect((output.payload as ExecOutputPayload).data).toBe("hello world\n");

    await new Promise((r) => setTimeout(r, 200));
    expect(bystanderReceived).toBe(false);

    ws1.close();
    ws2.close();
    ws3.close();
  });

  it("routes exec-exit back to requester", async () => {
    server.start(TEST_PORT + 4);

    const ws1 = await connectClient(TEST_PORT + 4);
    const ws2 = await connectClient(TEST_PORT + 4);

    ws1.send(JSON.stringify(createJoinMessage("requester")));
    await waitForMessage(ws1);
    ws2.send(JSON.stringify(createJoinMessage("executor")));
    await waitForMessage(ws2);

    await new Promise((r) => setTimeout(r, 300));
    ws1.removeAllListeners("message");

    const exitPromise = waitForMessage(ws1);
    ws2.send(JSON.stringify({
      type: "exec-exit",
      roomId: "test-room",
      peerId: "executor",
      timestamp: Date.now(),
      targetPeerId: "requester",
      payload: { execId: "test-exec-4", code: 0 },
    } satisfies SyncMessage));

    const exit = await exitPromise;
    expect(exit.type).toBe("exec-exit");
    expect((exit.payload as ExecExitPayload).code).toBe(0);

    ws1.close();
    ws2.close();
  });

  it("does not store exec messages in history", async () => {
    server.start(TEST_PORT + 5);

    const ws1 = await connectClient(TEST_PORT + 5);
    const ws2 = await connectClient(TEST_PORT + 5);

    ws1.send(JSON.stringify(createJoinMessage("requester")));
    await waitForMessage(ws1);
    ws2.send(JSON.stringify(createJoinMessage("executor")));
    await waitForMessage(ws2);

    await new Promise((r) => setTimeout(r, 200));

    // Send exec messages
    ws1.send(JSON.stringify({
      type: "exec-request",
      roomId: "test-room",
      peerId: "requester",
      timestamp: Date.now(),
      targetPeerId: "executor",
      payload: { execId: "hist-exec", command: "echo secret" },
    } satisfies SyncMessage));

    ws2.send(JSON.stringify({
      type: "exec-output",
      roomId: "test-room",
      peerId: "executor",
      timestamp: Date.now(),
      targetPeerId: "requester",
      payload: { execId: "hist-exec", stream: "stdout", data: "secret output\n" },
    } satisfies SyncMessage));

    await new Promise((r) => setTimeout(r, 200));

    // New peer joins — should NOT receive exec messages in history
    const ws3 = await connectClient(TEST_PORT + 5);
    const messages = await collectMessages(ws3, 3, 1000);

    // Should get peer-list and request-sync but no exec messages
    const execMsgs = messages.filter((m) =>
      m.type === "exec-request" || m.type === "exec-output" || m.type === "exec-exit"
    );
    expect(execMsgs).toHaveLength(0);

    ws1.close();
    ws2.close();
    ws3.close();
  });
});
