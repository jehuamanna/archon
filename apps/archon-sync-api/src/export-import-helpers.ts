/**
 * PLAN-06 slice 4a — pure helpers for the v2 export/import pipeline.
 *
 * Kept free of Fastify / Mongo / R2 side-effects so they're easy to
 * unit-test without infrastructure. The sync-api routes (slice 4b + 4c)
 * compose these with the I/O edges.
 */

import { randomUUID } from "node:crypto";

// ── Sync-api mirror of shared export/import types ─────────────────────────
// Kept in this file so the helper has no cross-workspace dependency on the
// root shared/ path. The canonical definition lives at
// src/shared/wpn-import-export-types.ts and these mirrors MUST match it.

export type WpnExportAssetEntry = {
  zipPath: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename?: string;
};

export type WpnExportNoteEntry = {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  sibling_index: number;
  metadata: Record<string, unknown> | null;
  assets?: WpnExportAssetEntry[];
};

export type WpnExportProjectEntry = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  notes: WpnExportNoteEntry[];
};

export type WpnExportWorkspaceEntry = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  projects: WpnExportProjectEntry[];
};

export type WpnExportBundleVersion = 1 | 2;

export type WpnExportMetadata = {
  version: WpnExportBundleVersion;
  exported_at_ms: number;
  workspaces: WpnExportWorkspaceEntry[];
};

export type WpnImportConflictPolicy = "skip" | "overwrite" | "rename";

// ────────────────────────────────────────────────────────────────────────────
// ID remapping
// ────────────────────────────────────────────────────────────────────────────

export type IdRemap = {
  workspaces: Map<string, string>;
  projects: Map<string, string>;
  notes: Map<string, string>;
};

export type RemappedBundle = {
  bundle: WpnExportMetadata;
  idRemap: IdRemap;
};

/**
 * Produce a deep copy of `bundle` with new UUIDs everywhere (workspace,
 * project, note) and with internal references (`parent_id`) rewritten to
 * point at the new ids. The returned `idRemap` lets the caller translate
 * any other references (e.g. vFS paths in markdown content) at route level.
 *
 * Metadata `r2Key` / `thumbKey` / `thumbMime` / `thumbSizeBytes` are NOT
 * rewritten here — use `clearImageMetadataKeys` before the import route
 * re-uploads bytes and writes the fresh keys.
 */
export function remapExportBundleIds(
  bundle: WpnExportMetadata,
  idFactory: () => string = randomUUID,
): RemappedBundle {
  const wsMap = new Map<string, string>();
  const projMap = new Map<string, string>();
  const noteMap = new Map<string, string>();

  const workspaces = bundle.workspaces.map((ws): WpnExportWorkspaceEntry => {
    const newWsId = idFactory();
    wsMap.set(ws.id, newWsId);
    const projects = ws.projects.map((proj): WpnExportProjectEntry => {
      const newProjId = idFactory();
      projMap.set(proj.id, newProjId);
      const notes = proj.notes.map((note): WpnExportNoteEntry => {
        const newNoteId = idFactory();
        noteMap.set(note.id, newNoteId);
        return {
          ...note,
          id: newNoteId,
          // parent_id rewrite happens in a second pass once we have every note id.
        };
      });
      return {
        ...proj,
        id: newProjId,
        notes,
      };
    });
    return {
      ...ws,
      id: newWsId,
      projects,
    };
  });

  // Second pass — rewrite parent_id using the fully-populated note map.
  for (const ws of workspaces) {
    for (const proj of ws.projects) {
      for (const note of proj.notes) {
        if (note.parent_id !== null) {
          note.parent_id = noteMap.get(note.parent_id) ?? null;
        }
      }
    }
  }

  return {
    bundle: {
      version: bundle.version,
      exported_at_ms: bundle.exported_at_ms,
      workspaces,
    },
    idRemap: {
      workspaces: wsMap,
      projects: projMap,
      notes: noteMap,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata key clearing (pre-re-upload)
// ────────────────────────────────────────────────────────────────────────────

const IMAGE_ASSET_METADATA_KEYS = [
  "r2Key",
  "thumbKey",
  "thumbMime",
  "thumbSizeBytes",
] as const;

/**
 * Return a copy of the metadata with the image-asset R2 references removed.
 * The import route re-uploads bytes under a fresh key (derived from the
 * importing user's org/space + the remapped workspace/project/note ids)
 * and then writes a new `r2Key`; the thumbnail fields are rebuilt on first
 * client open (slice 4d).
 */
export function clearImageMetadataKeys(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if ((IMAGE_ASSET_METADATA_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Conflict-policy naming on import
// ────────────────────────────────────────────────────────────────────────────

export type ConflictDecision =
  | { action: "skip" }
  | { action: "reuse"; name: string }
  | { action: "create"; name: string };

/**
 * Decide what name (if any) to use for an imported workspace given the
 * existing workspace names in the target space and the policy chosen.
 *
 * - `skip`: returns `{ action: "skip" }` when a collision exists; otherwise
 *   `{ action: "create", name }`.
 * - `overwrite`: returns `{ action: "reuse", name }` when a collision exists
 *   (the route merges into the existing workspace); otherwise `create`.
 * - `rename`: always `create`; on collision, append `" (imported YYYY-MM-DD)"`
 *   and a numeric disambiguator on repeat collisions.
 */
export function chooseImportName(args: {
  name: string;
  existing: ReadonlySet<string>;
  policy: WpnImportConflictPolicy;
  /** Timestamp used to stamp the rename suffix. Injected for testability. */
  nowMs?: number;
}): ConflictDecision {
  const trimmed = args.name.trim() || "Workspace";
  const collision = args.existing.has(trimmed);
  if (!collision) {
    return { action: "create", name: trimmed };
  }
  if (args.policy === "skip") {
    return { action: "skip" };
  }
  if (args.policy === "overwrite") {
    return { action: "reuse", name: trimmed };
  }
  // rename
  const datestamp = formatDatestamp(args.nowMs ?? Date.now());
  const baseSuffix = ` (imported ${datestamp})`;
  const base = `${trimmed}${baseSuffix}`;
  if (!args.existing.has(base)) {
    return { action: "create", name: base };
  }
  let n = 2;
  while (args.existing.has(`${base} ${n}`)) n++;
  return { action: "create", name: `${base} ${n}` };
}

function formatDatestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
