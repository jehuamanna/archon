import * as fs from "fs";
import * as path from "path";
import type { PluginInventoryItem } from "../shared/archon-renderer-api";

export type PluginCatalogPersistRow = {
  plugin_id: string;
  host_tier: string;
  is_bundled: boolean;
  can_toggle: boolean;
  enabled: boolean;
  loaded: boolean;
  manifest_version: string | null;
};

const FILE = "plugin-catalog.json";

export function getPluginCatalogJsonPath(userDataPath: string): string {
  return path.join(userDataPath, FILE);
}

type CatalogFile = {
  version: 1;
  rows: PluginCatalogPersistRow[];
  updated_at_ms: number;
};

function readCatalog(userDataPath: string): CatalogFile {
  const filePath = getPluginCatalogJsonPath(userDataPath);
  if (!fs.existsSync(filePath)) {
    return { version: 1, rows: [], updated_at_ms: 0 };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return { version: 1, rows: [], updated_at_ms: 0 };
    }
    const o = raw as Record<string, unknown>;
    const rows = Array.isArray(o.rows) ? (o.rows as PluginCatalogPersistRow[]) : [];
    return {
      version: 1,
      rows,
      updated_at_ms:
        typeof o.updated_at_ms === "number" ? o.updated_at_ms : Date.now(),
    };
  } catch {
    return { version: 1, rows: [], updated_at_ms: 0 };
  }
}

function writeCatalog(userDataPath: string, data: CatalogFile): void {
  const filePath = getPluginCatalogJsonPath(userDataPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, filePath);
}

export function syncPluginCatalogRows(
  userDataPath: string,
  rows: PluginCatalogPersistRow[],
): void {
  writeCatalog(userDataPath, {
    version: 1,
    rows: rows.map((r) => ({ ...r })),
    updated_at_ms: Date.now(),
  });
}

export function readUserTierPluginInventory(
  userDataPath: string,
): PluginInventoryItem[] {
  const { rows } = readCatalog(userDataPath);
  return rows
    .filter((r) => r.host_tier === "user")
    .sort((a, b) => a.plugin_id.localeCompare(b.plugin_id))
    .map((r) => ({
      id: r.plugin_id,
      isBundled: r.is_bundled,
      canToggle: r.can_toggle,
      enabled: r.enabled,
      loaded: r.loaded,
    }));
}

export function readUserLoadedPluginIds(userDataPath: string): string[] {
  const { rows } = readCatalog(userDataPath);
  return rows
    .filter((r) => r.host_tier === "user" && r.loaded)
    .map((r) => r.plugin_id)
    .sort();
}
