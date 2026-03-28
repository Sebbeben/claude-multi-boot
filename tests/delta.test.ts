import { describe, it, expect } from "vitest";
import { computeDelta, applyDelta, isDeltaSmaller } from "../src/shared/delta.js";

describe("computeDelta + applyDelta", () => {
  it("produces identity delta for identical content", () => {
    const content = "line1\nline2\nline3\nline4";
    const ops = computeDelta(content, content);
    const result = applyDelta(content, ops);
    expect(result).toBe(content);
  });

  it("handles single line change in the middle", () => {
    const old = "line1\nline2\nline3\nline4\nline5";
    const newContent = "line1\nline2\nCHANGED\nline4\nline5";
    const ops = computeDelta(old, newContent);
    const result = applyDelta(old, ops);
    expect(result).toBe(newContent);
  });

  it("handles appended lines", () => {
    const old = "line1\nline2\nline3";
    const newContent = "line1\nline2\nline3\nline4\nline5";
    const ops = computeDelta(old, newContent);
    const result = applyDelta(old, ops);
    expect(result).toBe(newContent);
  });

  it("handles removed lines", () => {
    const old = "line1\nline2\nline3\nline4\nline5";
    const newContent = "line1\nline2\nline5";
    const ops = computeDelta(old, newContent);
    const result = applyDelta(old, ops);
    expect(result).toBe(newContent);
  });

  it("handles completely different content", () => {
    const old = "aaa\nbbb\nccc\nddd";
    const newContent = "xxx\nyyy\nzzz\nwww";
    const ops = computeDelta(old, newContent);
    const result = applyDelta(old, ops);
    expect(result).toBe(newContent);
  });

  it("handles empty old content", () => {
    const ops = computeDelta("", "new\ncontent");
    const result = applyDelta("", ops);
    expect(result).toBe("new\ncontent");
  });

  it("handles empty new content", () => {
    const ops = computeDelta("old\ncontent", "");
    const result = applyDelta("old\ncontent", ops);
    expect(result).toBe("");
  });

  it("handles single line files", () => {
    const ops = computeDelta("old", "new");
    const result = applyDelta("old", ops);
    expect(result).toBe("new");
  });

  it("preserves exact whitespace", () => {
    const old = "  indented\n\ttabbed\n\n  spaces";
    const newContent = "  indented\n\ttabbed\n\nnew line\n  spaces";
    const ops = computeDelta(old, newContent);
    const result = applyDelta(old, ops);
    expect(result).toBe(newContent);
  });
});

describe("isDeltaSmaller", () => {
  it("returns true for small changes on large content", () => {
    const largeContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const modified = largeContent.replace("line 50", "CHANGED line 50");
    const ops = computeDelta(largeContent, modified);
    expect(isDeltaSmaller(ops, modified)).toBe(true);
  });

  it("returns false when delta is larger than content", () => {
    const old = "a\nb\nc";
    const newContent = "x\ny\nz";
    const ops = computeDelta(old, newContent);
    // For very small files where everything changed, delta may be larger
    // This tests the 80% threshold
    const deltaSize = JSON.stringify(ops).length;
    const fullSize = newContent.length;
    if (deltaSize >= fullSize * 0.8) {
      expect(isDeltaSmaller(ops, newContent)).toBe(false);
    }
  });
});
