import * as fs from "fs";
import * as path from "path";
import {
  getChildren,
  notes,
  setChildren,
  syncNullChildOrderFromRecords,
  type NoteRecord,
} from "./notes-store-core";
import { renameNote, setNoteContent } from "./notes-store-duplicate-create";

const DEFAULT_RELATIVE_DIR = path.join("docs", "bundled-plugin-authoring");
const ABOUT_ARCHON_RELATIVE_FILE = path.join("docs", "about-archon.md");
const ABOUT_ARCHON_NOTE_ID = "archon-docs:about-archon";

export type BundledDocsManifest = {
  version: number;
  folder: {
    id: string;
    title: string;
  };
  /** Main Documentation hub when no guide/command is selected (optional). */
  hubPlaceholder?: {
    id: string;
    file: string;
    title: string;
  };
  /** Short companion Markdown notes (opened from Documentation sidebar Settings); not listed under Guides. */
  companionPanels?: Array<{
    id: string;
    file: string;
    title: string;
    slot: string;
  }>;
  pages: Array<{
    id: string;
    file: string;
    title: string;
    /** Sidebar grouping label in Documentation → Guides (e.g. User guide / Plugin authoring). */
    section?: string;
  }>;
};

function isValidHubPlaceholder(
  h: unknown,
): h is NonNullable<BundledDocsManifest["hubPlaceholder"]> {
  return (
    !!h &&
    typeof h === "object" &&
    typeof (h as { id?: unknown }).id === "string" &&
    typeof (h as { file?: unknown }).file === "string" &&
    typeof (h as { title?: unknown }).title === "string"
  );
}

function isValidCompanionPanels(
  arr: unknown,
): arr is NonNullable<BundledDocsManifest["companionPanels"]> {
  if (!Array.isArray(arr)) return false;
  return arr.every(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof (p as { id?: unknown }).id === "string" &&
      typeof (p as { file?: unknown }).file === "string" &&
      typeof (p as { title?: unknown }).title === "string" &&
      typeof (p as { slot?: unknown }).slot === "string",
  );
}

function resolveDocsDir(): string {
  const env = process.env.ARCHON_BUNDLED_DOCS_DIR?.trim();
  if (env) {
    return path.resolve(env);
  }
  return path.resolve(process.cwd(), DEFAULT_RELATIVE_DIR);
}

function readManifest(dir: string): BundledDocsManifest | null {
  const p = path.join(dir, "manifest.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as BundledDocsManifest;
    const hubOk = j.hubPlaceholder === undefined || isValidHubPlaceholder(j.hubPlaceholder);
    const companionOk =
      j.companionPanels === undefined || isValidCompanionPanels(j.companionPanels);
    if (
      j &&
      typeof j.version === "number" &&
      j.folder &&
      typeof j.folder.id === "string" &&
      typeof j.folder.title === "string" &&
      hubOk &&
      companionOk &&
      Array.isArray(j.pages) &&
      j.pages.every(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.file === "string" &&
          typeof p.title === "string" &&
          (p.section === undefined || typeof p.section === "string"),
      )
    ) {
      return j;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function upsertNote(rec: NoteRecord): void {
  const prev = notes.get(rec.id);
  if (!prev) {
    notes.set(rec.id, { ...rec });
    return;
  }
  prev.type = rec.type;
  prev.parentId = rec.parentId;
  prev.metadata = rec.metadata ? { ...rec.metadata } : undefined;
  renameNote(rec.id, rec.title);
  setNoteContent(rec.id, rec.content);
}

function ensureRootSibling(id: string): void {
  const roots = [...getChildren(null)];
  if (!roots.includes(id)) {
    roots.push(id);
    setChildren(null, roots);
  }
}

function ensureChildOf(parentId: string, childId: string): void {
  const ch = [...getChildren(parentId)];
  if (!ch.includes(childId)) {
    ch.push(childId);
    setChildren(parentId, ch);
  }
}

/**
 * Upserts bundled documentation notes from local `.md` / `.mdx` files (manifest-driven).
 * Safe to call on every workspace bootstrap / API server start: overwrites title/body from disk.
 *
 * @returns true if the notes store was modified (caller should persist the workspace JSON).
 */
export function seedBundledDocumentationNotesFromDir(): boolean {
  const dir = resolveDocsDir();
  if (!fs.existsSync(dir)) {
    return false;
  }

  const manifest = readManifest(dir);
  if (!manifest || manifest.pages.length === 0) {
    return false;
  }

  let modified = false;
  const metaBase = {
    bundledDoc: true as const,
    manifestVersion: manifest.version,
  };

  const folderRec: NoteRecord = {
    id: manifest.folder.id,
    parentId: null,
    type: "markdown",
    title: manifest.folder.title,
    content:
      "# Documentation\n\nBundled read-only guides: **User guide** (using the app) and **Plugin authoring** (extending the shell). Open a page below or use Documentation → Guides in the sidebar.",
    metadata: { ...metaBase, bundledDocRole: "folder" },
  };

  const prevFolder = notes.get(folderRec.id);
  upsertNote(folderRec);
  ensureRootSibling(folderRec.id);
  if (
    !prevFolder ||
    prevFolder.title !== folderRec.title ||
    prevFolder.content !== folderRec.content
  ) {
    modified = true;
  }

  for (let i = 0; i < manifest.pages.length; i++) {
    const page = manifest.pages[i]!;
    const filePath = path.join(dir, page.file);
    if (!fs.existsSync(filePath)) {
      // eslint-disable-next-line no-console
      console.warn(`[Archon] bundled docs: missing file ${page.file}`);
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const rec: NoteRecord = {
      id: page.id,
      parentId: manifest.folder.id,
      type: "markdown",
      title: page.title,
      content,
      metadata: {
        ...metaBase,
        bundledDocRole: "page",
        bundledDocOrder: i,
        bundledDocSection: page.section ?? "Plugin authoring",
        sourceFile: page.file,
      },
    };

    const prevPage = notes.get(page.id);
    upsertNote(rec);
    ensureChildOf(manifest.folder.id, page.id);
    const nextSection = page.section ?? "Plugin authoring";
    if (
      !prevPage ||
      prevPage.content !== content ||
      prevPage.title !== page.title ||
      (prevPage.metadata as { bundledDocSection?: string } | undefined)?.bundledDocSection !== nextSection
    ) {
      modified = true;
    }
  }

  const seedExtraPage = (
    id: string,
    title: string,
    filePath: string,
    metadata: NoteRecord["metadata"],
  ): void => {
    if (!fs.existsSync(filePath)) {
      // eslint-disable-next-line no-console
      console.warn(`[Archon] bundled docs: missing file ${path.basename(filePath)}`);
      return;
    }
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const rec: NoteRecord = {
      id,
      parentId: manifest.folder.id,
      type: "markdown",
      title,
      content,
      metadata: metadata ? { ...metadata } : undefined,
    };
    const prev = notes.get(id);
    upsertNote(rec);
    ensureChildOf(manifest.folder.id, id);
    if (!prev || prev.content !== content || prev.title !== title) {
      modified = true;
    }
  };

  const hub = manifest.hubPlaceholder;
  if (hub) {
    seedExtraPage(hub.id, hub.title, path.join(dir, hub.file), {
      ...metaBase,
      bundledDocRole: "hub",
      bundledDocOrder: -5,
      sourceFile: hub.file,
    });
  }

  const companions = manifest.companionPanels ?? [];
  for (let i = 0; i < companions.length; i++) {
    const cp = companions[i]!;
    seedExtraPage(cp.id, cp.title, path.join(dir, cp.file), {
      ...metaBase,
      bundledDocRole: "companion",
      bundledDocCompanionSlot: cp.slot,
      bundledDocOrder: 5000 + i,
      sourceFile: cp.file,
    });
  }

  // Extra bundled docs that aren't part of the plugin-authoring manifest.
  // These are still seeded into the in-memory legacy notes tree so the Docs hub can display them.
  const aboutPath = path.resolve(process.cwd(), ABOUT_ARCHON_RELATIVE_FILE);
  if (fs.existsSync(aboutPath)) {
    try {
      const content = fs.readFileSync(aboutPath, "utf8");
      const rec: NoteRecord = {
        id: ABOUT_ARCHON_NOTE_ID,
        parentId: manifest.folder.id,
        type: "markdown",
        title: "About Archon",
        content,
        metadata: {
          ...metaBase,
          bundledDocRole: "page",
          bundledDocOrder: -10,
          bundledDocSection: "Reference",
          sourceFile: path.basename(ABOUT_ARCHON_RELATIVE_FILE),
        },
      };

      const prev = notes.get(rec.id);
      upsertNote(rec);
      ensureChildOf(manifest.folder.id, rec.id);
      if (!prev || prev.content !== content || prev.title !== rec.title) {
        modified = true;
      }
    } catch {
      /* ignore */
    }
  }

  syncNullChildOrderFromRecords();
  return modified;
}
