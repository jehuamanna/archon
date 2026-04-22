import type { WorkspaceStore } from "../workspace-store";

function slotForWorkspace(
  store: WorkspaceStore,
  ownerId: string,
  workspaceId: string,
): { slotIndex: number } | null {
  for (let i = 0; i < store.slots.length; i++) {
    const slot = store.slots[i]!;
    if (slot.workspaces.some((w) => w.id === workspaceId && w.owner_id === ownerId)) {
      return { slotIndex: i };
    }
  }
  return null;
}

function slotForProject(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
): { slotIndex: number } | null {
  for (let i = 0; i < store.slots.length; i++) {
    const slot = store.slots[i]!;
    const proj = slot.projects.find((p) => p.id === projectId);
    if (!proj) {
      continue;
    }
    const ws = slot.workspaces.find(
      (w) => w.id === proj.workspace_id && w.owner_id === ownerId,
    );
    if (ws) {
      return { slotIndex: i };
    }
  }
  return null;
}

export function wpnJsonGetWorkspaceSettings(
  store: WorkspaceStore,
  ownerId: string,
  workspaceId: string,
): Record<string, unknown> {
  const found = slotForWorkspace(store, ownerId, workspaceId);
  if (!found) {
    return {};
  }
  const slot = store.slots[found.slotIndex]!;
  const cur = slot.wpnWorkspaceSettings[workspaceId];
  return cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
}

export function wpnJsonPatchWorkspaceSettings(
  store: WorkspaceStore,
  ownerId: string,
  workspaceId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const found = slotForWorkspace(store, ownerId, workspaceId);
  if (!found) {
    throw new Error("Workspace not found");
  }
  const slot = store.slots[found.slotIndex]!;
  const cur = wpnJsonGetWorkspaceSettings(store, ownerId, workspaceId);
  const next = { ...cur, ...patch };
  slot.wpnWorkspaceSettings[workspaceId] = next;
  store.persist();
  return next;
}

export function wpnJsonGetProjectSettings(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
): Record<string, unknown> {
  const found = slotForProject(store, ownerId, projectId);
  if (!found) {
    return {};
  }
  const slot = store.slots[found.slotIndex]!;
  const cur = slot.wpnProjectSettings[projectId];
  return cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
}

export function wpnJsonPatchProjectSettings(
  store: WorkspaceStore,
  ownerId: string,
  projectId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const found = slotForProject(store, ownerId, projectId);
  if (!found) {
    throw new Error("Project not found");
  }
  const slot = store.slots[found.slotIndex]!;
  const cur = wpnJsonGetProjectSettings(store, ownerId, projectId);
  const next = { ...cur, ...patch };
  slot.wpnProjectSettings[projectId] = next;
  store.persist();
  return next;
}
