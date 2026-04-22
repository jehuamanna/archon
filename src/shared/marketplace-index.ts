import * as fs from "fs";
import * as path from "path";

export const MARKETPLACE_INDEX_FILENAME = "marketplace-index.json";

export const MARKETPLACE_INDEX_SCHEMA_VERSION = 1;

/** One row in marketplace-index.json (build output). */
export type MarketplaceIndexEntry = {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  packageFile: string;
  markdownFile: string | null;
  readmeSnippet?: string;
};

export type MarketplaceIndexFile = {
  schemaVersion: number;
  generatedAt: string;
  plugins: MarketplaceIndexEntry[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIndexEntry(v: unknown): v is MarketplaceIndexEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.name === "string" &&
    typeof v.version === "string" &&
    typeof v.packageFile === "string" &&
    (v.markdownFile === null || typeof v.markdownFile === "string")
  );
}

/**
 * Read and validate marketplace-index.json under `marketDir`.
 * Returns empty catalog if missing or invalid (callers may log).
 */
export function loadMarketplaceIndex(
  marketDir: string,
): { ok: true; data: MarketplaceIndexFile } | { ok: false; error: string } {
  const indexPath = path.join(marketDir, MARKETPLACE_INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) {
    return { ok: false, error: `Missing ${MARKETPLACE_INDEX_FILENAME}` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, "utf8");
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "Invalid JSON in marketplace index" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Marketplace index must be an object" };
  }
  const sv = parsed.schemaVersion;
  if (sv !== MARKETPLACE_INDEX_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Unsupported marketplace schemaVersion: ${String(sv)}`,
    };
  }
  const pluginsRaw = parsed.plugins;
  if (!Array.isArray(pluginsRaw)) {
    return { ok: false, error: "Marketplace index missing plugins array" };
  }
  const plugins: MarketplaceIndexEntry[] = [];
  for (const row of pluginsRaw) {
    if (isIndexEntry(row)) {
      plugins.push({
        name: row.name,
        version: row.version,
        displayName:
          typeof row.displayName === "string" ? row.displayName : undefined,
        description:
          typeof row.description === "string" ? row.description : undefined,
        packageFile: row.packageFile,
        markdownFile: row.markdownFile,
        readmeSnippet:
          typeof row.readmeSnippet === "string" ? row.readmeSnippet : undefined,
      });
    }
  }
  const generatedAt =
    typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
  return {
    ok: true,
    data: {
      schemaVersion: MARKETPLACE_INDEX_SCHEMA_VERSION,
      generatedAt,
      plugins,
    },
  };
}

/** Drop index rows whose package (or optional markdown) file is missing on disk. */
export function filterMarketplaceIndexByExistingFiles(
  marketDir: string,
  data: MarketplaceIndexFile,
): MarketplaceIndexFile {
  const plugins = data.plugins.filter((p) => {
    const pkg = path.join(marketDir, p.packageFile);
    if (!fs.existsSync(pkg)) return false;
    if (p.markdownFile) {
      const md = path.join(marketDir, p.markdownFile);
      if (!fs.existsSync(md)) return false;
    }
    return true;
  });
  return { ...data, plugins };
}
