import { hashContent } from "./utils.js";

/**
 * Section-based merge for CLAUDE.md files.
 *
 * Strategy:
 * - The file is split into sections by markdown headings (## or #).
 * - The claude-mesh managed block is always replaced wholesale.
 * - Other sections are merged: if both local and remote changed the same
 *   section, we keep both with a conflict marker.
 * - New sections from remote are appended.
 */

export interface MergeResult {
  content: string;
  hadConflict: boolean;
  conflictSections: string[];
}

interface Section {
  heading: string; // The heading line, or "" for preamble
  body: string;    // Full text including heading
}

const MESH_START = "<!-- claude-mesh:start -->";
const MESH_END = "<!-- claude-mesh:end -->";

function extractMeshBlock(content: string): { block: string; rest: string } {
  const startIdx = content.indexOf(MESH_START);
  const endIdx = content.indexOf(MESH_END);
  if (startIdx === -1 || endIdx === -1) {
    return { block: "", rest: content };
  }
  const block = content.slice(startIdx, endIdx + MESH_END.length);
  const rest = (content.slice(0, startIdx) + content.slice(endIdx + MESH_END.length)).trim();
  return { block, rest };
}

function parseSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let current: Section = { heading: "", body: "" };

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      // Push current section if it has content
      if (current.body.trim()) {
        sections.push(current);
      }
      current = { heading: line.trim(), body: line + "\n" };
    } else {
      current.body += line + "\n";
    }
  }
  if (current.body.trim()) {
    sections.push(current);
  }
  return sections;
}

/**
 * Three-way-ish merge for CLAUDE.md content.
 *
 * @param base    - The last known common version (from knownHashes tracking)
 * @param local   - Current local file content
 * @param remote  - Incoming remote content
 * @returns Merged content and conflict info
 */
export function mergeClaudeMd(
  base: string | null,
  local: string,
  remote: string,
): MergeResult {
  // If local is empty, just take remote
  if (!local.trim()) {
    return { content: remote, hadConflict: false, conflictSections: [] };
  }

  // If remote is empty, keep local
  if (!remote.trim()) {
    return { content: local, hadConflict: false, conflictSections: [] };
  }

  // If local hasn't changed from base, just take remote
  if (base !== null && hashContent(local) === hashContent(base)) {
    return { content: remote, hadConflict: false, conflictSections: [] };
  }

  // If remote hasn't changed from base, keep local
  if (base !== null && hashContent(remote) === hashContent(base)) {
    return { content: local, hadConflict: false, conflictSections: [] };
  }

  // Both changed — do section-level merge
  const { block: remoteMesh, rest: remoteRest } = extractMeshBlock(remote);
  const { rest: localRest } = extractMeshBlock(local);

  const localSections = parseSections(localRest);
  const remoteSections = parseSections(remoteRest);

  const merged: string[] = [];
  const conflictSections: string[] = [];
  const usedRemoteHeadings = new Set<string>();

  for (const localSec of localSections) {
    const remoteSec = remoteSections.find(
      (r) => r.heading && r.heading === localSec.heading
    );

    if (!remoteSec || !localSec.heading) {
      // No matching remote section, or preamble — keep local
      merged.push(localSec.body.trimEnd());
    } else {
      usedRemoteHeadings.add(remoteSec.heading);
      if (hashContent(localSec.body) === hashContent(remoteSec.body)) {
        // Same content
        merged.push(localSec.body.trimEnd());
      } else {
        // Conflict — keep both with markers
        conflictSections.push(localSec.heading);
        merged.push(
          `<<<<<<< local\n${localSec.body.trimEnd()}\n=======\n${remoteSec.body.trimEnd()}\n>>>>>>> remote`
        );
      }
    }
  }

  // Append any new sections from remote that weren't in local
  for (const remoteSec of remoteSections) {
    if (remoteSec.heading && !usedRemoteHeadings.has(remoteSec.heading)) {
      const existsLocally = localSections.some(
        (l) => l.heading === remoteSec.heading
      );
      if (!existsLocally) {
        merged.push(remoteSec.body.trimEnd());
      }
    }
  }

  // Re-attach the mesh block (always use latest remote version)
  let finalContent = merged.join("\n\n");
  if (remoteMesh) {
    finalContent = finalContent + "\n\n" + remoteMesh;
  }

  return {
    content: finalContent.trim() + "\n",
    hadConflict: conflictSections.length > 0,
    conflictSections,
  };
}
