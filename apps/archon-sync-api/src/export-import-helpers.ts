/**
 * PLAN-06 slice 4a — pure helpers for the v2 export/import pipeline.
 *
 * Kept free of Fastify / DB / R2 side-effects so they're easy to
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
 * - `rename`: always `create`; on collision, append `" 2"` (or `" 3"`, `" 4"`,
 *   …) until a free name is found. The imported workspace keeps its original
 *   name verbatim when there is no collision.
 */
export function chooseImportName(args: {
  name: string;
  existing: ReadonlySet<string>;
  policy: WpnImportConflictPolicy;
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
  // rename: append a numeric disambiguator.
  let n = 2;
  while (args.existing.has(`${trimmed} ${n}`)) n++;
  return { action: "create", name: `${trimmed} ${n}` };
}

// ────────────────────────────────────────────────────────────────────────────
// Slice 4b — v2 export manifest builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimum image metadata shape the manifest builder needs. Mirrored from
 * `WpnImageNoteMetadataV1` so this helper stays dependency-free.
 */
export type ExportImageMetadataProbe = {
  r2Key?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  originalFilename?: unknown;
};

/** Extension used when the export can't derive one from `originalFilename`. */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

function sanitizeForZip(name: string): string {
  // Rewrite anything outside a safe filename subset to `_` (letters,
  // digits, dot, underscore, dash). Collapses runs of unsafe chars and
  // strips a leading dot so the file stays inside its `assets/<noteId>/`
  // directory regardless of the stored originalFilename.
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return cleaned.length > 0 ? cleaned : "asset";
}

function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? "bin";
}

/**
 * Decide the in-archive filename for an image note's bytes. Prefers the
 * stored `originalFilename` (sanitized), otherwise synthesizes `<noteId>.<ext>`
 * from the mime type. The zipPath is always `assets/<noteId>/<filename>`.
 */
export function deriveAssetFilename(args: {
  noteId: string;
  mimeType: string;
  originalFilename?: string | null;
}): string {
  const original = (args.originalFilename ?? "").trim();
  if (original) {
    const safe = sanitizeForZip(original);
    if (safe.includes(".")) return safe;
    return `${safe}.${extFromMime(args.mimeType)}`;
  }
  return `${args.noteId}.${extFromMime(args.mimeType)}`;
}

export type ExportNoteInput = {
  id: string;
  parent_id: string | null;
  type: string;
  title: string;
  sibling_index: number;
  metadata: Record<string, unknown> | null;
};

export type ExportProjectInput = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  notes: ExportNoteInput[];
};

export type ExportWorkspaceInput = {
  id: string;
  name: string;
  sort_index: number;
  color_token: string | null;
  projects: ExportProjectInput[];
};

/** Per-asset descriptor returned alongside the manifest for the route to stream. */
export type AssetStreamPlan = {
  noteId: string;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  zipPath: string;
  filename: string;
};

export type BuildExportManifestResult = {
  metadata: WpnExportMetadata;
  /** Ordered list of R2 assets to stream into the ZIP at `asset.zipPath`. */
  assets: AssetStreamPlan[];
  /** Sum of `sizeBytes` across `assets` — caller checks against its cap. */
  totalAssetBytes: number;
};

export class ExportBytesCapExceededError extends Error {
  readonly capBytes: number;
  readonly observedBytes: number;
  constructor(capBytes: number, observedBytes: number) {
    super(
      `Export bundle exceeds byte cap (${observedBytes} > ${capBytes}). ` +
        `Reduce the selection or raise ARCHON_EXPORT_MAX_BYTES.`,
    );
    this.name = "ExportBytesCapExceededError";
    this.capBytes = capBytes;
    this.observedBytes = observedBytes;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Slice 4c — import planning (conflict-policy + name-rewrite pairs)
// ────────────────────────────────────────────────────────────────────────────

export type ImportWorkspaceAction =
  | { kind: "skip"; sourceWorkspaceId: string }
  | {
      kind: "create";
      sourceWorkspaceId: string;
      chosenName: string;
      /** True when the chosen name differs from the bundled workspace name. */
      renamed: boolean;
    }
  | {
      kind: "reuse";
      sourceWorkspaceId: string;
      existingWorkspaceId: string;
      chosenName: string;
    };

export type ImportPlan = {
  workspaces: ImportWorkspaceAction[];
  /** Old→new canonical path pairs for vFS link rewrites on rename. */
  canonicalPathRewrites: { oldCanonical: string; newCanonical: string }[];
};

/**
 * Decide, for each workspace in the bundle, whether to skip, reuse, or create
 * (and under what name). Also compute the canonical vFS path rewrites that
 * should be applied to markdown content so in-bundle `#/w/<ws>/<proj>/<title>`
 * links keep resolving post-import when the workspace was renamed.
 *
 * Pure: no DB, no R2.
 */
export function planImportWorkspaces(args: {
  bundle: WpnExportMetadata;
  existingWorkspaces: ReadonlyArray<{ id: string; name: string }>;
  policy: WpnImportConflictPolicy;
}): ImportPlan {
  const existingByName = new Map<string, string>();
  const existingNames = new Set<string>();
  for (const w of args.existingWorkspaces) {
    existingByName.set(w.name, w.id);
    existingNames.add(w.name);
  }
  const claimedNames = new Set(existingNames);
  const workspaces: ImportWorkspaceAction[] = [];
  const canonicalPathRewrites: ImportPlan["canonicalPathRewrites"] = [];

  for (const ws of args.bundle.workspaces) {
    const decision = chooseImportName({
      name: ws.name,
      existing: claimedNames,
      policy: args.policy,
    });
    if (decision.action === "skip") {
      workspaces.push({ kind: "skip", sourceWorkspaceId: ws.id });
      continue;
    }
    if (decision.action === "reuse") {
      const existingId = existingByName.get(decision.name);
      if (!existingId) {
        workspaces.push({
          kind: "create",
          sourceWorkspaceId: ws.id,
          chosenName: decision.name,
          renamed: decision.name !== ws.name,
        });
        claimedNames.add(decision.name);
        continue;
      }
      workspaces.push({
        kind: "reuse",
        sourceWorkspaceId: ws.id,
        existingWorkspaceId: existingId,
        chosenName: decision.name,
      });
      continue;
    }
    const renamed = decision.name !== ws.name;
    workspaces.push({
      kind: "create",
      sourceWorkspaceId: ws.id,
      chosenName: decision.name,
      renamed,
    });
    claimedNames.add(decision.name);
    if (renamed) {
      for (const proj of ws.projects) {
        for (const note of proj.notes) {
          canonicalPathRewrites.push({
            oldCanonical: `${ws.name}/${proj.name}/${note.title}`,
            newCanonical: `${decision.name}/${proj.name}/${note.title}`,
          });
        }
      }
    }
  }

  return { workspaces, canonicalPathRewrites };
}

/**
 * Build a v2 export manifest + the list of image-asset streams the caller
 * needs to write into the ZIP. Pure: no I/O, no DB, no R2.
 *
 * Each image note with a usable `r2Key` + `mimeType` + `sizeBytes` trio
 * contributes one `assets[]` entry in the manifest and one `AssetStreamPlan`
 * in the result. Image notes without R2 refs pass through (broken-on-import
 * by design — matches v1 behavior for partially-uploaded notes).
 */
export function buildExportManifest(args: {
  workspaces: ExportWorkspaceInput[];
  exportedAtMs: number;
  /** Max total asset bytes. Throws {@link ExportBytesCapExceededError} when exceeded. */
  maxAssetBytes: number;
}): BuildExportManifestResult {
  const assets: AssetStreamPlan[] = [];
  let totalBytes = 0;

  const workspaces: WpnExportWorkspaceEntry[] = args.workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    sort_index: ws.sort_index,
    color_token: ws.color_token,
    projects: ws.projects.map((proj) => ({
      id: proj.id,
      name: proj.name,
      sort_index: proj.sort_index,
      color_token: proj.color_token,
      notes: proj.notes.map((note): WpnExportNoteEntry => {
        const base: WpnExportNoteEntry = {
          id: note.id,
          parent_id: note.parent_id,
          type: note.type,
          title: note.title,
          sibling_index: note.sibling_index,
          metadata: note.metadata,
        };
        if (note.type !== "image") return base;
        const probe = (note.metadata ?? {}) as ExportImageMetadataProbe;
        const r2Key = typeof probe.r2Key === "string" ? probe.r2Key : null;
        const mimeType = typeof probe.mimeType === "string" ? probe.mimeType : null;
        const sizeBytes = typeof probe.sizeBytes === "number" ? probe.sizeBytes : null;
        if (!r2Key || !mimeType || sizeBytes === null || sizeBytes < 0) {
          return base;
        }
        const originalFilename =
          typeof probe.originalFilename === "string" ? probe.originalFilename : undefined;
        const filename = deriveAssetFilename({
          noteId: note.id,
          mimeType,
          originalFilename,
        });
        const zipPath = `assets/${note.id}/${filename}`;
        const assetEntry: WpnExportAssetEntry = {
          zipPath,
          mimeType,
          sizeBytes,
          ...(originalFilename ? { originalFilename } : {}),
        };
        totalBytes += sizeBytes;
        if (totalBytes > args.maxAssetBytes) {
          throw new ExportBytesCapExceededError(args.maxAssetBytes, totalBytes);
        }
        assets.push({
          noteId: note.id,
          r2Key,
          mimeType,
          sizeBytes,
          zipPath,
          filename,
        });
        return { ...base, assets: [assetEntry] };
      }),
    })),
  }));

  return {
    metadata: {
      version: 2,
      exported_at_ms: args.exportedAtMs,
      workspaces,
    },
    assets,
    totalAssetBytes: totalBytes,
  };
}
