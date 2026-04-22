import * as fs from "fs";
import * as path from "path";

const APP_PREFS_FILE = "archon-app-prefs.json";

export type ArchonAppPrefs = {
  /** When true (default), empty primary/added project folders get sample notes. */
  seedSampleNotes: boolean;
  /**
   * One-shot: legacy Electron temp-dir scratch WPN was copied into renderer IndexedDB
   * (`archon_wpn_scratch__v1`); main workspace was cleared.
   */
  legacyScratchToIdbMigrated?: boolean;
};

const defaultPrefs: ArchonAppPrefs = {
  seedSampleNotes: false,
};

export function readAppPrefs(userDataPath: string): ArchonAppPrefs {
  const p = path.join(userDataPath, APP_PREFS_FILE);
  if (!fs.existsSync(p)) {
    return { ...defaultPrefs };
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ArchonAppPrefs>;
    return {
      seedSampleNotes:
        typeof j.seedSampleNotes === "boolean"
          ? j.seedSampleNotes
          : defaultPrefs.seedSampleNotes,
      legacyScratchToIdbMigrated:
        j.legacyScratchToIdbMigrated === true ? true : undefined,
    };
  } catch {
    return { ...defaultPrefs };
  }
}

export function writeAppPrefs(
  userDataPath: string,
  prefs: Partial<ArchonAppPrefs>,
): ArchonAppPrefs {
  const cur = readAppPrefs(userDataPath);
  const next: ArchonAppPrefs = {
    seedSampleNotes:
      typeof prefs.seedSampleNotes === "boolean"
        ? prefs.seedSampleNotes
        : cur.seedSampleNotes,
    legacyScratchToIdbMigrated:
      typeof prefs.legacyScratchToIdbMigrated === "boolean"
        ? prefs.legacyScratchToIdbMigrated
        : cur.legacyScratchToIdbMigrated,
  };
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, APP_PREFS_FILE),
    JSON.stringify(next, null, 2),
    "utf8",
  );
  return next;
}
