import { describe, it, expect } from "vitest";
import { mergeClaudeMd } from "../src/shared/conflict-resolver.js";

describe("mergeClaudeMd", () => {
  it("takes remote when local is empty", () => {
    const result = mergeClaudeMd(null, "", "# Hello\nWorld");
    expect(result.content).toBe("# Hello\nWorld");
    expect(result.hadConflict).toBe(false);
  });

  it("keeps local when remote is empty", () => {
    const result = mergeClaudeMd(null, "# Local\nContent", "");
    expect(result.content).toBe("# Local\nContent");
    expect(result.hadConflict).toBe(false);
  });

  it("takes remote when local unchanged from base", () => {
    const base = "# Title\nOld content";
    const result = mergeClaudeMd(base, base, "# Title\nNew content");
    expect(result.content).toContain("New content");
    expect(result.hadConflict).toBe(false);
  });

  it("keeps local when remote unchanged from base", () => {
    const base = "# Title\nOld content";
    const result = mergeClaudeMd(base, "# Title\nLocal changes", base);
    expect(result.content).toContain("Local changes");
    expect(result.hadConflict).toBe(false);
  });

  it("merges non-conflicting sections", () => {
    const base = "# Section A\nOriginal A\n\n# Section B\nOriginal B";
    const local = "# Section A\nChanged A\n\n# Section B\nOriginal B";
    const remote = "# Section A\nOriginal A\n\n# Section B\nChanged B";
    const result = mergeClaudeMd(base, local, remote);
    expect(result.content).toContain("Changed A");
    // Section B is different in both, so it should conflict
  });

  it("reports conflicts when same section changed on both sides", () => {
    const base = "# Section A\nOriginal\n";
    const local = "# Section A\nLocal version\n";
    const remote = "# Section A\nRemote version\n";
    const result = mergeClaudeMd(base, local, remote);
    expect(result.hadConflict).toBe(true);
    expect(result.conflictSections).toContain("# Section A");
    expect(result.content).toContain("<<<<<<< local");
    expect(result.content).toContain(">>>>>>> remote");
  });

  it("appends new sections from remote", () => {
    const local = "# Existing\nContent here\n";
    const remote = "# Existing\nContent here\n\n# New Section\nFrom remote\n";
    const result = mergeClaudeMd(null, local, remote);
    expect(result.content).toContain("New Section");
    expect(result.content).toContain("From remote");
  });

  it("preserves mesh block from remote", () => {
    const local = "# Project\nNotes\n\n<!-- claude-mesh:start -->\nOLD BLOCK\n<!-- claude-mesh:end -->";
    const remote = "# Project\nNotes\n\n<!-- claude-mesh:start -->\nNEW BLOCK\n<!-- claude-mesh:end -->";
    const result = mergeClaudeMd(null, local, remote);
    expect(result.content).toContain("NEW BLOCK");
    expect(result.content).not.toContain("OLD BLOCK");
  });

  it("handles identical content without conflict", () => {
    const content = "# Same\nIdentical content";
    const result = mergeClaudeMd(content, content, content);
    expect(result.hadConflict).toBe(false);
    expect(result.content).toContain("Identical content");
  });

  it("handles content with no headings (preamble only)", () => {
    const result = mergeClaudeMd(null, "Just text", "Different text");
    expect(result.hadConflict).toBe(false);
    // Preamble from local is kept, new content from remote with no matching heading is handled
  });
});
