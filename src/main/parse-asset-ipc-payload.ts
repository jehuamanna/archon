/** Parse `ASSET_*` IPC payloads (string rel path or `{ relativePath, projectRoot? }`). */
export function parseAssetIpcPayload(payload: unknown): {
  rel: string;
  projectRoot?: string;
} {
  if (typeof payload === "string") {
    return { rel: payload };
  }
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    const rel =
      typeof o.relativePath === "string"
        ? o.relativePath
        : typeof o.rel === "string"
          ? o.rel
          : "";
    const projectRoot =
      typeof o.projectRoot === "string" ? o.projectRoot : undefined;
    return { rel, projectRoot };
  }
  return { rel: "" };
}
