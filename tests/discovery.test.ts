import { describe, it, expect, afterEach } from "vitest";
import { DiscoveryBroadcaster, DiscoveryListener } from "../src/shared/discovery.js";

describe("Discovery", () => {
  let broadcaster: DiscoveryBroadcaster | null = null;
  let listener: DiscoveryListener | null = null;

  afterEach(() => {
    broadcaster?.stop();
    listener?.stop();
  });

  it("broadcaster and listener discover each other on localhost", async () => {
    broadcaster = new DiscoveryBroadcaster(24680, "test-room-id", "my-laptop", "tok123");
    listener = new DiscoveryListener();

    await listener.start();
    broadcaster.start();

    const host = await listener.waitForHost(5000);

    expect(host).not.toBeNull();
    expect(host!.port).toBe(24680);
    expect(host!.roomId).toBe("test-room-id");
    expect(host!.label).toBe("my-laptop");
    expect(host!.token).toBe("tok123");
  });

  it("listener returns null on timeout when no broadcaster", async () => {
    listener = new DiscoveryListener();
    await listener.start();

    const host = await listener.waitForHost(1000);
    expect(host).toBeNull();
  });

  it("getDiscoveredHosts returns all found hosts", async () => {
    broadcaster = new DiscoveryBroadcaster(24680, "room-1", "host-a");
    listener = new DiscoveryListener();

    await listener.start();
    broadcaster.start();

    await new Promise((r) => setTimeout(r, 3000));

    const hosts = listener.getDiscoveredHosts();
    expect(hosts.length).toBeGreaterThanOrEqual(1);
    expect(hosts[0].label).toBe("host-a");
  });
});
