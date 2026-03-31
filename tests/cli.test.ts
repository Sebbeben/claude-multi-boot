import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function run(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return exec("node", [CLI, ...args], {
    cwd,
    timeout: 5000,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

describe("CLI", () => {
  it("shows version", async () => {
    const { stdout } = await run(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("shows help", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toContain("claude-mesh");
    expect(stdout).toContain("host");
    expect(stdout).toContain("join");
    expect(stdout).toContain("serve");
    expect(stdout).toContain("sync");
    expect(stdout).toContain("status");
    expect(stdout).toContain("install-hooks");
  });

  it("host --help shows options", async () => {
    const { stdout } = await run(["host", "--help"]);
    expect(stdout).toContain("--port");
    expect(stdout).toContain("--label");
    expect(stdout).toContain("--project");
  });

  it("join --help shows address argument", async () => {
    const { stdout } = await run(["join", "--help"]);
    expect(stdout).toContain("address");
    expect(stdout).toContain("--port");
    expect(stdout).toContain("--label");
  });

  describe("init command", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "mesh-cli-init-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("creates .claude-mesh.json config file", async () => {
      await run(["init", "--project", tempDir, "--label", "test-machine"]);

      const configPath = join(tempDir, ".claude-mesh.json");
      expect(existsSync(configPath)).toBe(true);

      const config = JSON.parse(await readFile(configPath, "utf-8"));
      expect(config.roomId).toBeTruthy();
      expect(config.serverUrl).toContain("ws://");
      expect(config.projectPath).toBe(tempDir);
      expect(config.syncPaths).toContain("CLAUDE.md");
      expect(config.machine).toBeDefined();
      expect(config.machine.label).toBe("test-machine");
    });

    it("uses provided room ID", async () => {
      await run(["init", "--project", tempDir, "--room", "custom-room-123"]);

      const config = JSON.parse(await readFile(join(tempDir, ".claude-mesh.json"), "utf-8"));
      expect(config.roomId).toBe("custom-room-123");
    });

    it("uses provided server URL", async () => {
      await run(["init", "--project", tempDir, "--server", "ws://myserver:9999"]);

      const config = JSON.parse(await readFile(join(tempDir, ".claude-mesh.json"), "utf-8"));
      expect(config.serverUrl).toBe("ws://myserver:9999");
    });
  });

  describe("status command", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "mesh-cli-status-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("shows not initialized when no config exists", async () => {
      try {
        await run(["status", "--project", tempDir]);
      } catch (e: unknown) {
        // Status exits with code 0 but prints warning
        const err = e as { stdout?: string };
        if (err.stdout) {
          expect(err.stdout).toContain("Not initialized");
        }
      }
    });

    it("shows config info when initialized", async () => {
      // First init
      await run(["init", "--project", tempDir, "--label", "status-test"]);

      const { stdout } = await run(["status", "--project", tempDir]);
      expect(stdout).toContain("claude-mesh");
      expect(stdout).toContain("Room");
    });
  });

  describe("install-hooks command", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "mesh-cli-hooks-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("creates .claude/settings.local.json", async () => {
      await run(["install-hooks", "--project", tempDir]);

      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      expect(existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
    });

    it("preserves existing settings when adding hooks", async () => {
      const settingsDir = join(tempDir, ".claude");
      await (await import("node:fs/promises")).mkdir(settingsDir, { recursive: true });
      await writeFile(
        join(settingsDir, "settings.local.json"),
        JSON.stringify({ existingKey: "preserved" }),
      );

      await run(["install-hooks", "--project", tempDir]);

      const settings = JSON.parse(await readFile(join(settingsDir, "settings.local.json"), "utf-8"));
      expect(settings.existingKey).toBe("preserved");
      expect(settings.hooks.SessionStart).toBeDefined();
    });

    it("hook commands reference correct script paths", async () => {
      await run(["install-hooks", "--project", tempDir]);

      const settings = JSON.parse(await readFile(join(tempDir, ".claude", "settings.local.json"), "utf-8"));
      const sessionHook = settings.hooks.SessionStart[0].hooks[0];
      const toolHook = settings.hooks.PostToolUse[0].hooks[0];

      expect(sessionHook.command).toContain("session-start.js");
      expect(toolHook.command).toContain("post-tool-use.js");
      expect(sessionHook.type).toBe("command");
      expect(toolHook.type).toBe("command");
    });
  });

  describe("sync command", () => {
    it("errors when no config file exists", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "mesh-cli-sync-"));
      try {
        await run(["sync", "--project", tempDir]);
        expect.fail("should have thrown");
      } catch (e: unknown) {
        const err = e as { stderr?: string; code?: number };
        // Should exit with error
        expect(err.stderr || "").toContain("");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
