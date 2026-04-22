import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapWorkspaceNotes, releaseWorkspaceStore } from "./notes-persistence";
import { resetNotesStore } from "./notes-store";
import { getNotesDatabase } from "./workspace-store";
import { wpnJsonCreateProject, wpnJsonCreateWorkspace, wpnJsonListWorkspaces } from "./wpn/wpn-json-service";
import { getWpnOwnerId } from "./wpn/wpn-owner";

const PREFS_FILE = "archon-project-prefs.json";

export type ProjectPrefs = {
  lastProjectRoot: string | null;
  /** All open project folders (first = primary: notes DB anchor + assets). */
  workspaceRoots?: string[];
  /** Optional display names in the sidebar (keys = resolved absolute paths). */
  workspaceLabels?: Record<string, string>;
  /** Shell-only workbench layout/visibility (renderer-owned schema). */
  shellLayout?: unknown;
};

/** Drop labels for paths no longer in the workspace; normalize keys. */
export function pruneWorkspaceLabels(
  labels: Record<string, string> | undefined,
  roots: string[],
): Record<string, string> | undefined {
  if (!labels || Object.keys(labels).length === 0) {
    return undefined;
  }
  const rootSet = new Set(roots.map((r) => path.resolve(String(r).trim())));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const rk = path.resolve(String(k).trim());
    if (rootSet.has(rk) && typeof v === "string" && v.trim().length > 0) {
      out[rk] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep workspace order; drop paths that are missing or not directories. */
export function filterExistingWorkspaceRoots(roots: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of roots) {
    const r = path.resolve(String(p).trim());
    if (!r || seen.has(r)) {
      continue;
    }
    try {
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) {
        seen.add(r);
        out.push(r);
      }
    } catch {
      /* skip invalid paths */
    }
  }
  return out;
}

export function getNormalizedWorkspaceRoots(prefs: ProjectPrefs): string[] {
  const raw =
    Array.isArray(prefs.workspaceRoots) && prefs.workspaceRoots.length > 0
      ? prefs.workspaceRoots
      : prefs.lastProjectRoot
        ? [prefs.lastProjectRoot]
        : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== "string" || !p.trim()) {
      continue;
    }
    const r = path.resolve(p.trim());
    if (seen.has(r)) {
      continue;
    }
    seen.add(r);
    out.push(r);
  }
  return out;
}

export function readProjectPrefs(userDataPath: string): ProjectPrefs {
  const p = path.join(userDataPath, PREFS_FILE);
  if (!fs.existsSync(p)) {
    return { lastProjectRoot: null };
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ProjectPrefs>;
    if (j.lastProjectRoot != null && typeof j.lastProjectRoot !== "string") {
      return { lastProjectRoot: null };
    }
    let workspaceRoots: string[] | undefined;
    if (Array.isArray(j.workspaceRoots)) {
      workspaceRoots = j.workspaceRoots.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      );
      if (workspaceRoots.length === 0) {
        workspaceRoots = undefined;
      }
    }
    let workspaceLabels: Record<string, string> | undefined;
    if (
      j.workspaceLabels &&
      typeof j.workspaceLabels === "object" &&
      !Array.isArray(j.workspaceLabels)
    ) {
      const wl: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        j.workspaceLabels as Record<string, unknown>,
      )) {
        if (
          typeof k === "string" &&
          k.trim().length > 0 &&
          typeof v === "string" &&
          v.trim().length > 0
        ) {
          wl[path.resolve(k.trim())] = v.trim();
        }
      }
      if (Object.keys(wl).length > 0) {
        workspaceLabels = wl;
      }
    }
    return {
      lastProjectRoot:
        typeof j.lastProjectRoot === "string" ? j.lastProjectRoot : null,
      workspaceRoots,
      workspaceLabels,
      shellLayout: j.shellLayout,
    };
  } catch {
    return { lastProjectRoot: null };
  }
}

export function writeProjectPrefs(
  userDataPath: string,
  prefs: ProjectPrefs,
): void {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, PREFS_FILE),
    JSON.stringify(prefs, null, 2),
    "utf8",
  );
}

/** Primary workspace persistence: `projectRoot/data/archon-workspace.json`. */
export function getProjectNotesDbPath(projectRoot: string): string {
  return path.resolve(projectRoot, "data", "archon-workspace.json");
}

/** `projectRoot/data/notes-tree.json` (legacy JSON migration target inside project). */
export function getProjectLegacyNotesJsonPath(projectRoot: string): string {
  return path.join(projectRoot, "data", "notes-tree.json");
}

/** `projectRoot/assets` */
export function getProjectAssetsDir(projectRoot: string): string {
  return path.resolve(projectRoot, "assets");
}

export function ensureProjectDirectories(projectRoot: string): void {
  const root = path.resolve(projectRoot);
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
}

export type ActivateProjectResult =
  | {
      ok: true;
      root: string;
      dbPath: string;
      workspaceRoots: string[];
      /** Ephemeral Electron temp-dir session (not written to disk until saved). */
      scratch?: boolean;
    }
  | { ok: false; error: string };

function seedWpnWorkspaceIfEmpty(): void {
  const store = getNotesDatabase();
  if (!store) {
    return;
  }
  const owner = getWpnOwnerId();
  if (wpnJsonListWorkspaces(store, owner).length > 0) {
    return;
  }
  const w = wpnJsonCreateWorkspace(store, owner, "Workspace");
  wpnJsonCreateProject(store, owner, w.id, "Project");
}

/**
 * Open a temp-dir workspace: full app experience, nothing written to `archon-workspace.json` until the user saves to a folder.
 * Does not update project prefs (closing the app drops the session).
 */
export function activateScratchWorkspace(
  registeredTypes: string[],
): ActivateProjectResult {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archon-scratch-"));
  try {
    releaseWorkspaceStore();
  } catch {
    /* ignore */
  }
  resetNotesStore();
  const legacyJson = getProjectLegacyNotesJsonPath(tempRoot);
  bootstrapWorkspaceNotes([tempRoot], legacyJson, registeredTypes, {
    scratchSession: true,
  });
  seedWpnWorkspaceIfEmpty();
  return {
    ok: true,
    root: tempRoot,
    dbPath: getProjectNotesDbPath(tempRoot),
    workspaceRoots: [tempRoot],
    scratch: true,
  };
}

/**
 * Write scratch state into `targetRoot`, remove the temp tree, activate the folder as the real workspace (updates prefs).
 */
export function saveScratchWorkspaceToFolder(
  targetRoot: string,
  userDataPath: string,
  registeredTypes: string[],
): ActivateProjectResult {
  const store = getNotesDatabase();
  if (!store?.scratchSession) {
    return { ok: false, error: "Not in a scratch session" };
  }
  if (store.roots.length === 0) {
    return { ok: false, error: "No scratch root" };
  }
  const scratchRoot = store.roots[0]!;
  const resolved = path.resolve(targetRoot);
  fs.mkdirSync(path.join(resolved, "data"), { recursive: true });
  fs.mkdirSync(path.join(resolved, "assets"), { recursive: true });

  store.diskPersistence = true;
  store.scratchSession = false;
  store.roots.splice(0, store.roots.length, resolved);
  store.persist();

  const sAssets = path.join(scratchRoot, "assets");
  const tAssets = path.join(resolved, "assets");
  if (fs.existsSync(sAssets)) {
    fs.cpSync(sAssets, tAssets, { recursive: true });
  }

  try {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }

  try {
    releaseWorkspaceStore();
  } catch {
    /* ignore */
  }
  resetNotesStore();
  return activateWorkspace([resolved], userDataPath, registeredTypes);
}

/** Remove scratch temp files and start a fresh scratch workspace. Clears saved workspace prefs. */
export function replaceScratchWithNewSession(
  userDataPath: string,
  registeredTypes: string[],
): ActivateProjectResult {
  const store = getNotesDatabase();
  if (!store?.scratchSession || store.roots.length === 0) {
    return { ok: false, error: "Not in a scratch session" };
  }
  const old = store.roots[0]!;
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
  try {
    releaseWorkspaceStore();
  } catch {
    /* ignore */
  }
  resetNotesStore();
  writeProjectPrefs(userDataPath, {
    lastProjectRoot: null,
    workspaceRoots: undefined,
  });
  return activateScratchWorkspace(registeredTypes);
}

/**
 * Close current notes DB, reset store, open multiple project folders (merged tree), persist prefs.
 */
export function activateWorkspace(
  rootsInput: string[],
  userDataPath: string,
  registeredTypes: string[],
): ActivateProjectResult {
  const roots = [
    ...new Set(
      rootsInput
        .map((p) => path.resolve(String(p).trim()))
        .filter((p) => p.length > 0),
    ),
  ];
  if (roots.length === 0) {
    return { ok: false, error: "No folders selected" };
  }
  const existing = filterExistingWorkspaceRoots(roots);
  if (existing.length === 0) {
    try {
      releaseWorkspaceStore();
    } catch {
      /* ignore */
    }
    resetNotesStore();
    writeProjectPrefs(userDataPath, {
      lastProjectRoot: null,
      workspaceRoots: undefined,
    });
    return { ok: true, root: "", dbPath: "", workspaceRoots: [] };
  }
  const rootsResolved = existing;
  ensureProjectDirectories(rootsResolved[0]!);
  try {
    releaseWorkspaceStore();
  } catch {
    /* ignore */
  }
  resetNotesStore();
  const dbPath = getProjectNotesDbPath(rootsResolved[0]!);
  const legacyJson = getProjectLegacyNotesJsonPath(rootsResolved[0]!);
  bootstrapWorkspaceNotes(rootsResolved, legacyJson, registeredTypes);
  const prevPrefs = readProjectPrefs(userDataPath);
  writeProjectPrefs(userDataPath, {
    lastProjectRoot: rootsResolved[0]!,
    workspaceRoots: rootsResolved,
    workspaceLabels: pruneWorkspaceLabels(
      prevPrefs.workspaceLabels,
      rootsResolved,
    ),
  });
  return {
    ok: true,
    root: rootsResolved[0]!,
    dbPath,
    workspaceRoots: rootsResolved,
  };
}

export function setWorkspaceFolderLabel(
  userDataPath: string,
  rootPath: string,
  label: string | null,
):
  | { ok: true; workspaceLabels: Record<string, string> }
  | { ok: false; error: string } {
  const prefs = readProjectPrefs(userDataPath);
  const roots = getNormalizedWorkspaceRoots(prefs);
  const norm = path.resolve(String(rootPath).trim());
  if (!roots.some((r) => path.resolve(r) === norm)) {
    return { ok: false, error: "Path is not in the workspace" };
  }
  const nextLabels: Record<string, string> = {
    ...(prefs.workspaceLabels ?? {}),
  };
  if (label == null || label.trim() === "") {
    delete nextLabels[norm];
  } else {
    nextLabels[norm] = label.trim();
  }
  const pruned = pruneWorkspaceLabels(nextLabels, roots) ?? {};
  writeProjectPrefs(userDataPath, {
    lastProjectRoot: prefs.lastProjectRoot,
    workspaceRoots: prefs.workspaceRoots,
    workspaceLabels: Object.keys(pruned).length > 0 ? pruned : undefined,
  });
  return { ok: true, workspaceLabels: pruned };
}

/** Replace workspace with a single folder. */
export function activateProject(
  projectRootAbs: string,
  userDataPath: string,
  registeredTypes: string[],
): ActivateProjectResult {
  return activateWorkspace([projectRootAbs], userDataPath, registeredTypes);
}

export function deactivateProject(): void {
  try {
    releaseWorkspaceStore();
  } catch {
    /* ignore */
  }
  resetNotesStore();
}

/** Close DB, clear in-memory notes, clear saved workspace prefs (no folders open). */
export function closeWorkspace(userDataPath: string): ActivateProjectResult {
  const store = getNotesDatabase();
  const scratchRoot =
    store?.scratchSession && store.roots[0] ? store.roots[0] : null;
  try {
    releaseWorkspaceStore();
  } catch {
    /* ignore */
  }
  resetNotesStore();
  if (scratchRoot) {
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }
  writeProjectPrefs(userDataPath, {
    lastProjectRoot: null,
    workspaceRoots: undefined,
  });
  return { ok: true, root: "", dbPath: "", workspaceRoots: [] };
}
