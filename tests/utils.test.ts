import { describe, it, expect } from "vitest";
import { generatePeerId, generateRoomId, hashContent, timestamp } from "../src/shared/utils.js";

describe("generatePeerId", () => {
  it("returns a string", () => {
    expect(typeof generatePeerId()).toBe("string");
  });

  it("contains a hyphen separating hostname and random part", () => {
    const id = generatePeerId();
    expect(id).toMatch(/.+-.+/);
  });

  it("generates unique IDs on each call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePeerId()));
    expect(ids.size).toBe(100);
  });

  it("hostname part is at most 8 characters", () => {
    const id = generatePeerId();
    const hostPart = id.split("-")[0];
    expect(hostPart.length).toBeLessThanOrEqual(8);
  });

  it("random part is 8 hex characters", () => {
    const id = generatePeerId();
    const parts = id.split("-");
    const randomPart = parts[parts.length - 1];
    expect(randomPart).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("generateRoomId", () => {
  it("returns a 12-character hex string", () => {
    const id = generateRoomId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("generates unique room IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRoomId()));
    expect(ids.size).toBe(100);
  });
});

describe("hashContent", () => {
  it("returns a 16-character hex string", () => {
    const hash = hashContent("hello world");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns the same hash for the same content", () => {
    expect(hashContent("test")).toBe(hashContent("test"));
  });

  it("returns different hashes for different content", () => {
    expect(hashContent("abc")).not.toBe(hashContent("def"));
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles unicode content", () => {
    const hash = hashContent("こんにちは世界 🌍");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles very large content", () => {
    const large = "x".repeat(1_000_000);
    const hash = hashContent(large);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("timestamp", () => {
  it("returns a number", () => {
    expect(typeof timestamp()).toBe("number");
  });

  it("returns approximately current time", () => {
    const now = Date.now();
    const ts = timestamp();
    expect(Math.abs(ts - now)).toBeLessThan(100);
  });

  it("is monotonically increasing", () => {
    const t1 = timestamp();
    const t2 = timestamp();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});
