import { describe, it, expect } from "vitest";
import { MachineColorMap } from "../src/shared/colors.js";

describe("MachineColorMap", () => {
  it("assigns a color function for a peer", () => {
    const map = new MachineColorMap();
    const color = map.getColor("peer-1");
    expect(typeof color).toBe("function");
  });

  it("returns the same color function for the same peer", () => {
    const map = new MachineColorMap();
    const c1 = map.getColor("peer-1");
    const c2 = map.getColor("peer-1");
    expect(c1).toBe(c2);
  });

  it("assigns different indices for different peers", () => {
    const map = new MachineColorMap();
    map.getColor("peer-1");
    map.getColor("peer-2");
    // Different peers should get different color names (different indices)
    expect(map.getColorName("peer-1")).not.toBe(map.getColorName("peer-2"));
  });

  it("supports 12 unique color names before cycling", () => {
    const map = new MachineColorMap();
    const names = new Set<string>();
    for (let i = 0; i < 12; i++) {
      map.getColor(`peer-${i}`);
      names.add(map.getColorName(`peer-${i}`));
    }
    expect(names.size).toBe(12);
  });

  it("cycles color names after palette exhaustion", () => {
    const map = new MachineColorMap();
    for (let i = 0; i < 12; i++) {
      map.getColor(`peer-${i}`);
    }
    map.getColor("peer-12");
    // 13th peer should cycle back to same color name as peer-0
    expect(map.getColorName("peer-12")).toBe(map.getColorName("peer-0"));
  });

  it("tracks size correctly", () => {
    const map = new MachineColorMap();
    expect(map.size).toBe(0);
    map.getColor("a");
    expect(map.size).toBe(1);
    map.getColor("b");
    expect(map.size).toBe(2);
    map.getColor("a"); // Existing — no increase
    expect(map.size).toBe(2);
  });

  describe("getBoldColor", () => {
    it("returns a function", () => {
      const map = new MachineColorMap();
      expect(typeof map.getBoldColor("peer-1")).toBe("function");
    });

    it("assigns same index as getColor for same peer", () => {
      const map = new MachineColorMap();
      map.getColor("peer-1");
      map.getBoldColor("peer-1");
      expect(map.size).toBe(1);
    });

    it("does not create a new index if peer already registered via getColor", () => {
      const map = new MachineColorMap();
      map.getColor("peer-1");
      map.getColor("peer-2");
      map.getBoldColor("peer-1"); // Should reuse index 0
      expect(map.getColorName("peer-1")).toBe("cyan"); // Still first color
    });
  });

  describe("formatTag", () => {
    it("wraps label in parentheses", () => {
      const map = new MachineColorMap();
      const tag = map.formatTag("peer-1", "work-laptop");
      // Strip ANSI codes to check content
      const plain = tag.replace(/\u001b\[[0-9;]*m/g, "");
      expect(plain).toBe("(work-laptop)");
    });

    it("handles empty label", () => {
      const map = new MachineColorMap();
      const tag = map.formatTag("peer-1", "");
      const plain = tag.replace(/\u001b\[[0-9;]*m/g, "");
      expect(plain).toBe("()");
    });
  });

  describe("formatMessage", () => {
    it("includes tag and message in plain text", () => {
      const map = new MachineColorMap();
      const msg = map.formatMessage("peer-1", "laptop", "hello world");
      const plain = msg.replace(/\u001b\[[0-9;]*m/g, "");
      expect(plain).toContain("(laptop)");
      expect(plain).toContain("hello world");
    });
  });

  describe("getColorName", () => {
    it("returns 'cyan' for the first peer", () => {
      const map = new MachineColorMap();
      map.getColor("first");
      expect(map.getColorName("first")).toBe("cyan");
    });

    it("returns 'magenta' for the second peer", () => {
      const map = new MachineColorMap();
      map.getColor("first");
      map.getColor("second");
      expect(map.getColorName("second")).toBe("magenta");
    });

    it("returns all 12 expected color names in order", () => {
      const map = new MachineColorMap();
      const expected = [
        "cyan", "magenta", "yellow", "green", "blue", "red",
        "orange", "teal", "purple", "gold", "sky-blue", "coral",
      ];
      for (let i = 0; i < 12; i++) {
        map.getColor(`peer-${i}`);
        expect(map.getColorName(`peer-${i}`)).toBe(expected[i]);
      }
    });

    it("defaults to index 0 for unknown peer", () => {
      const map = new MachineColorMap();
      expect(map.getColorName("unknown")).toBe("cyan");
    });
  });
});
