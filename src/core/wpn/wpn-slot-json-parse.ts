/**
 * Pure parse of WPN arrays from one `archon-workspace.json` slot file body (ADR-016 shared layer).
 */
import type {
  WpnNoteRow,
  WpnProjectRow,
  WpnWorkspaceRow,
} from "../../shared/wpn-v2-types";

export type WpnWorkspaceStoredRow = WpnWorkspaceRow & { owner_id: string };

export type WpnExplorerPersistedRow = {
  project_id: string;
  expanded_ids: string[];
};

export type ParsedWorkspaceSlotWpn = {
  workspaces: WpnWorkspaceStoredRow[];
  projects: WpnProjectRow[];
  notes: WpnNoteRow[];
  explorer: WpnExplorerPersistedRow[];
};

export function parseWorkspaceSlotWpnArrays(json: string): ParsedWorkspaceSlotWpn {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return { workspaces: [], projects: [], notes: [], explorer: [] };
  }
  if (!raw || typeof raw !== "object") {
    return { workspaces: [], projects: [], notes: [], explorer: [] };
  }
  const o = raw as Record<string, unknown>;
  const workspaces = Array.isArray(o.workspaces)
    ? (o.workspaces as WpnWorkspaceStoredRow[])
    : [];
  const projects = Array.isArray(o.projects) ? (o.projects as WpnProjectRow[]) : [];
  const notes = Array.isArray(o.notes) ? (o.notes as WpnNoteRow[]) : [];
  const explorer = Array.isArray(o.explorer)
    ? (o.explorer as WpnExplorerPersistedRow[])
    : [];
  return { workspaces, projects, notes, explorer };
}
