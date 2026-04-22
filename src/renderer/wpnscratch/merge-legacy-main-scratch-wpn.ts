import type { WpnNoteRow, WpnProjectRow, WpnWorkspaceRow } from "../../shared/wpn-v2-types";

export type LegacyMainScratchWpnBundle = {
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
  notes: WpnNoteRow[];
  explorer: Array<{ project_id: string; expanded_ids: string[] }>;
};

export type ScratchWpnBundleSlice = {
  workspaces: WpnWorkspaceRow[];
  projects: WpnProjectRow[];
  notes: WpnNoteRow[];
  explorer: Array<{ project_id: string; expanded_ids: string[] }>;
};

function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) {
    m.set(r.id, r);
  }
  return m;
}

/**
 * Merges legacy main-process temp scratch WPN rows into an existing scratch IDB bundle.
 * Existing rows win on id collision (idempotent re-run after failed ack).
 */
export function mergeLegacyMainScratchWpnIntoScratchBundle(
  existing: ScratchWpnBundleSlice,
  legacy: LegacyMainScratchWpnBundle,
): ScratchWpnBundleSlice {
  const ws = byId(existing.workspaces);
  for (const w of legacy.workspaces) {
    if (!ws.has(w.id)) {
      ws.set(w.id, { ...w });
    }
  }
  const pj = byId(existing.projects);
  for (const p of legacy.projects) {
    if (!pj.has(p.id)) {
      pj.set(p.id, { ...p });
    }
  }
  const nt = byId(existing.notes);
  for (const n of legacy.notes) {
    if (!nt.has(n.id)) {
      nt.set(n.id, { ...n });
    }
  }
  const exByProject = new Map(existing.explorer.map((e) => [e.project_id, e]));
  for (const e of legacy.explorer) {
    if (!exByProject.has(e.project_id)) {
      exByProject.set(e.project_id, {
        project_id: e.project_id,
        expanded_ids: [...e.expanded_ids],
      });
    }
  }
  return {
    workspaces: [...ws.values()],
    projects: [...pj.values()],
    notes: [...nt.values()],
    explorer: [...exByProject.values()],
  };
}
