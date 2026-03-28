/**
 * Simple line-based delta encoding for text files.
 *
 * Produces a compact diff (operations: keep, add, remove) that can
 * reconstruct the new content from the old. Much smaller than sending
 * the full file when only a few lines changed.
 */

export interface DeltaOp {
  op: "keep" | "add" | "remove";
  /** For "keep": number of lines. For "add"/"remove": the line content. */
  value: string | number;
}

export interface Delta {
  ops: DeltaOp[];
  /** Hash of the base content this delta applies to */
  baseHash: string;
  /** Hash of the result after applying this delta */
  resultHash: string;
}

/**
 * Compute a line-level delta between old and new content.
 * Uses a simple LCS-based approach optimized for small diffs.
 */
export function computeDelta(oldContent: string, newContent: string): DeltaOp[] {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // For very small files, skip diffing
  if (oldLines.length < 3 || newLines.length < 3) {
    return [
      ...oldLines.map((l): DeltaOp => ({ op: "remove", value: l })),
      ...newLines.map((l): DeltaOp => ({ op: "add", value: l })),
    ];
  }

  // Simple Myers-like diff: find common prefix and suffix, diff the middle
  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < (minLen - prefixLen) &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const ops: DeltaOp[] = [];

  // Common prefix
  if (prefixLen > 0) {
    ops.push({ op: "keep", value: prefixLen });
  }

  // Middle section — changed lines
  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);

  for (const line of oldMiddle) {
    ops.push({ op: "remove", value: line });
  }
  for (const line of newMiddle) {
    ops.push({ op: "add", value: line });
  }

  // Common suffix
  if (suffixLen > 0) {
    ops.push({ op: "keep", value: suffixLen });
  }

  return ops;
}

/**
 * Apply a delta to old content to produce new content.
 */
export function applyDelta(oldContent: string, ops: DeltaOp[]): string {
  const oldLines = oldContent.split("\n");
  const result: string[] = [];
  let oldIdx = 0;

  for (const op of ops) {
    switch (op.op) {
      case "keep": {
        const count = op.value as number;
        for (let i = 0; i < count && oldIdx < oldLines.length; i++) {
          result.push(oldLines[oldIdx++]);
        }
        break;
      }
      case "remove":
        oldIdx++; // Skip this line
        break;
      case "add":
        result.push(op.value as string);
        break;
    }
  }

  return result.join("\n");
}

/**
 * Estimate the byte size of a delta vs full content.
 * Returns true if delta is smaller (worth sending).
 */
export function isDeltaSmaller(ops: DeltaOp[], fullContent: string): boolean {
  const deltaSize = JSON.stringify(ops).length;
  const fullSize = fullContent.length;
  return deltaSize < fullSize * 0.8; // Delta must be at least 20% smaller
}
