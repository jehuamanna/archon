import type { ResourceVisibility } from "../../../../auth/auth-client";

export type AdminSelection =
  | { kind: "none" }
  | { kind: "master" }
  | { kind: "org-people" }
  | { kind: "org-teams" }
  | { kind: "org-activity" }
  | { kind: "space-members"; spaceId: string }
  | {
      kind: "workspace-shares";
      workspaceId: string;
      spaceId: string | null;
      initialVisibility: ResourceVisibility;
      workspaceName?: string;
      creatorUserId?: string | null;
    }
  | {
      kind: "project-shares";
      projectId: string;
      spaceId: string | null;
      initialVisibility: ResourceVisibility;
      projectName?: string;
      creatorUserId?: string | null;
    };

export type AdminCompanionFocus =
  | { kind: "none" }
  | { kind: "org-member"; userId: string; displayName?: string; role?: string }
  | {
      kind: "space-member";
      spaceId: string;
      userId: string;
      displayName?: string;
      role?: string;
    }
  | {
      kind: "share";
      resourceKind: "workspace" | "project";
      resourceId: string;
      userId: string;
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
