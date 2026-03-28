import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

export function generatePeerId(): string {
  const host = hostname().slice(0, 8);
  const rand = randomBytes(4).toString("hex");
  return `${host}-${rand}`;
}

export function generateRoomId(): string {
  return randomBytes(6).toString("hex");
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function timestamp(): number {
  return Date.now();
}

export function generateToken(): string {
  return randomBytes(16).toString("base64url");
}

export function log(level: "info" | "warn" | "error" | "debug", msg: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = { info: "ℹ", warn: "⚠", error: "✗", debug: "·" }[level];
  const line = `${ts} ${prefix} ${msg}`;
  if (level === "error") {
    console.error(line, data ?? "");
  } else if (level === "debug") {
    if (process.env.DEBUG) console.log(line, data ?? "");
  } else {
    console.log(line, data ?? "");
  }
}
