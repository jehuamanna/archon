/**
 * Admin selection state. Drives both `AdminSidebarView` (active node
 * highlight) and `AdminMainView` (which panel to render).
 *
 * Post-org/team migration the selection set is small: org-level admin
 * landings (people, teams, departments, activity) plus the master-admin
 * console. The pre-migration "space", "space-members", "workspace-
 * shares" and "project-shares" kinds were dropped — spaces/workspaces
 * no longer exist, and project access is managed inline within the
 * Teams panel via `team_projects` grants.
 */
export type AdminSelection =
  | { kind: "none" }
  | { kind: "account" }
  | { kind: "master" }
  | { kind: "org-people" }
  | { kind: "org-teams" }
  | { kind: "org-departments" }
  | { kind: "org-activity" };

export type AdminCompanionFocus =
  | { kind: "none" }
  | {
      kind: "org-member";
      userId: string;
      displayName?: string;
      role?: string;
    };

export type AdminSelectionState = {
  selection: AdminSelection;
  companionFocus: AdminCompanionFocus;
};

type Listener = () => void;

class AdminSelectionStore {
  private state: AdminSelectionState = {
    selection: { kind: "none" },
    companionFocus: { kind: "none" },
  };
  private readonly listeners = new Set<Listener>();

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get(): AdminSelectionState {
    return this.state;
  }

  setSelection(next: AdminSelection): void {
    if (this.state.selection === next) return;
    this.state = { ...this.state, selection: next };
    this.emit();
  }

  setCompanionFocus(next: AdminCompanionFocus): void {
    if (this.state.companionFocus === next) return;
    this.state = { ...this.state, companionFocus: next };
    this.emit();
  }

  reset(): void {
    this.state = {
      selection: { kind: "none" },
      companionFocus: { kind: "none" },
    };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const adminSelectionStore = new AdminSelectionStore();
