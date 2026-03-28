import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLocalIp,
  getMachineIdentity,
  formatMachineId,
  generateMachineContext,
  MachineIdentity,
} from "../src/shared/machine-identity.js";

describe("getLocalIp", () => {
  it("returns a string", () => {
    expect(typeof getLocalIp()).toBe("string");
  });

  it("returns a valid IPv4 address format", () => {
    const ip = getLocalIp();
    // Either a real IP or 127.0.0.1 fallback
    expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});

describe("getMachineIdentity", () => {
  let tempDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-swarm-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a new identity on first call", async () => {
    const identity = await getMachineIdentity();
    expect(identity.peerId).toBeTruthy();
    expect(identity.hostname).toBeTruthy();
    expect(identity.ip).toBeTruthy();
    expect(identity.platform).toBeTruthy();
    expect(identity.arch).toBeTruthy();
    expect(identity.registeredAt).toBeTruthy();
  });

  it("persists identity to disk", async () => {
    const identity = await getMachineIdentity();
    const filePath = join(tempDir, ".claude-swarm", "identity.json");
    const stored = JSON.parse(await readFile(filePath, "utf-8"));
    expect(stored.peerId).toBe(identity.peerId);
  });

  it("returns the same peerId on subsequent calls", async () => {
    const id1 = await getMachineIdentity();
    const id2 = await getMachineIdentity();
    expect(id2.peerId).toBe(id1.peerId);
  });

  it("uses provided label", async () => {
    const identity = await getMachineIdentity("my-laptop");
    expect(identity.label).toBe("my-laptop");
  });

  it("updates label on subsequent call with new label", async () => {
    await getMachineIdentity("old-name");
    const updated = await getMachineIdentity("new-name");
    expect(updated.label).toBe("new-name");
  });

  it("keeps existing label when no label provided on subsequent call", async () => {
    await getMachineIdentity("custom-name");
    const identity = await getMachineIdentity();
    expect(identity.label).toBe("custom-name");
  });

  it("updates IP on each call", async () => {
    const identity = await getMachineIdentity();
    // IP should be a valid format
    expect(identity.ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});

describe("formatMachineId", () => {
  const identity: MachineIdentity = {
    peerId: "test-12345678",
    label: "work-laptop",
    hostname: "work-laptop",
    ip: "192.168.1.10",
    platform: "linux",
    arch: "x64",
    registeredAt: "2026-01-01T00:00:00.000Z",
  };

  it("includes label", () => {
    expect(formatMachineId(identity)).toContain("work-laptop");
  });

  it("includes IP", () => {
    expect(formatMachineId(identity)).toContain("192.168.1.10");
  });

  it("includes platform/arch", () => {
    expect(formatMachineId(identity)).toContain("linux/x64");
  });

  it("matches expected format", () => {
    expect(formatMachineId(identity)).toBe("work-laptop (192.168.1.10, linux/x64)");
  });
});

describe("generateMachineContext", () => {
  const local: MachineIdentity = {
    peerId: "local-123",
    label: "my-machine",
    hostname: "my-machine",
    ip: "192.168.1.1",
    platform: "linux",
    arch: "x64",
    registeredAt: "2026-01-01T00:00:00.000Z",
  };

  const peer: MachineIdentity = {
    peerId: "peer-456",
    label: "other-machine",
    hostname: "other-machine",
    ip: "192.168.1.2",
    platform: "darwin",
    arch: "arm64",
    registeredAt: "2026-01-01T00:00:00.000Z",
  };

  it("includes local machine info", () => {
    const ctx = generateMachineContext(local, []);
    expect(ctx).toContain("my-machine");
    expect(ctx).toContain("192.168.1.1");
  });

  it("shows no peers message when empty", () => {
    const ctx = generateMachineContext(local, []);
    expect(ctx).toContain("No other machines connected yet.");
  });

  it("lists peers when present", () => {
    const ctx = generateMachineContext(local, [peer]);
    expect(ctx).toContain("other-machine");
    expect(ctx).toContain("192.168.1.2");
    expect(ctx).toContain("darwin/arm64");
  });

  it("includes total machine count", () => {
    const ctx = generateMachineContext(local, [peer]);
    expect(ctx).toContain("Total machines in room:** 2");
  });

  it("includes IMPORTANT warning about machine confusion", () => {
    const ctx = generateMachineContext(local, [peer]);
    expect(ctx).toContain("IMPORTANT");
    expect(ctx).toContain("Do NOT confuse");
  });

  it("handles multiple peers", () => {
    const peer2: MachineIdentity = {
      ...peer,
      peerId: "peer-789",
      label: "third-machine",
      ip: "10.0.0.5",
    };
    const ctx = generateMachineContext(local, [peer, peer2]);
    expect(ctx).toContain("other-machine");
    expect(ctx).toContain("third-machine");
    expect(ctx).toContain("Total machines in room:** 3");
  });

  it("contains the claude-swarm header", () => {
    const ctx = generateMachineContext(local, []);
    expect(ctx).toContain("claude-swarm");
  });
});
