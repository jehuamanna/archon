/**
 * ADR-016: main → renderer workspace mirror payload (one message per debounced persist).
 * `slots[].json` is the raw UTF-8 body of each root's `data/archon-workspace.json` file.
 */
export type WorkspaceRxdbMirrorSlotPayload = {
  root: string;
  path: string;
  json: string;
};

export type WorkspaceRxdbMirrorPayloadV1 = {
  v: 1;
  vaultKey: string;
  slots: WorkspaceRxdbMirrorSlotPayload[];
};

export function isWorkspaceRxdbMirrorPayloadV1(
  x: unknown,
): x is WorkspaceRxdbMirrorPayloadV1 {
  if (!x || typeof x !== "object") {
    return false;
  }
  const o = x as Record<string, unknown>;
  if (o.v !== 1 || typeof o.vaultKey !== "string") {
    return false;
  }
  if (!Array.isArray(o.slots)) {
    return false;
  }
  for (const s of o.slots) {
    if (!s || typeof s !== "object") {
      return false;
    }
    const r = s as Record<string, unknown>;
    if (typeof r.root !== "string" || typeof r.path !== "string" || typeof r.json !== "string") {
      return false;
    }
  }
  return true;
}
