import { hostname, networkInterfaces, platform, arch } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generatePeerId } from "./utils.js";

export interface MachineIdentity {
  peerId: string;
  label: string;
  hostname: string;
  ip: string;
  platform: string;
  arch: string;
  registeredAt: string;
}

/**
 * Get the primary non-internal IPv4 address of this machine.
 */
export function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Load or create a persistent machine identity.
 * Stored in ~/.claude-multi-boot/identity.json so it survives across sessions.
 */
export async function getMachineIdentity(label?: string): Promise<MachineIdentity> {
  const configDir = join(
    process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    ".claude-multi-boot"
  );
  const identityPath = join(configDir, "identity.json");

  if (existsSync(identityPath)) {
    const existing: MachineIdentity = JSON.parse(await readFile(identityPath, "utf-8"));
    // Update dynamic fields
    existing.ip = getLocalIp();
    if (label) existing.label = label;
    await writeFile(identityPath, JSON.stringify(existing, null, 2));
    return existing;
  }

  // Create new identity
  const identity: MachineIdentity = {
    peerId: generatePeerId(),
    label: label ?? hostname(),
    hostname: hostname(),
    ip: getLocalIp(),
    platform: platform(),
    arch: arch(),
    registeredAt: new Date().toISOString(),
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(identityPath, JSON.stringify(identity, null, 2));
  return identity;
}

/**
 * Format machine identity for display in Claude context.
 */
export function formatMachineId(identity: MachineIdentity): string {
  return `${identity.label} (${identity.ip}, ${identity.platform}/${identity.arch})`;
}

/**
 * Generate a CLAUDE.md section that tells Claude about connected machines.
 */
export function generateMachineContext(
  localIdentity: MachineIdentity,
  peers: MachineIdentity[]
): string {
  const allMachines = [localIdentity, ...peers];
  const lines = [
    "## Multi-Machine Sync (claude-multi-boot)",
    "",
    `**This machine:** ${formatMachineId(localIdentity)}`,
    "",
    `**Total machines in room:** ${allMachines.length}`,
    "",
  ];

  if (peers.length > 0) {
    lines.push("**Connected peers:**");
    for (let i = 0; i < peers.length; i++) {
      lines.push(`- ${formatMachineId(peers[i])}`);
    }
    lines.push("");
    lines.push(
      "IMPORTANT: Each machine listed above is a separate physical/virtual machine with its own IP address. " +
      "Do NOT confuse file paths, environments, or running processes between machines. " +
      "When referencing work done on a specific machine, always prefix with the machine label. " +
      "The chat activity feed shows (hostname) before each message so you can identify the source machine."
    );
  } else {
    lines.push("No other machines connected yet.");
  }

  return lines.join("\n");
}
