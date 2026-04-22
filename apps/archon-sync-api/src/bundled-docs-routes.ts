import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type BundledManifest = {
  version: number;
  folder: { id: string; title: string };
  hubPlaceholder?: { id: string; file: string; title: string };
  companionPanels?: Array<{ id: string; file: string; title: string; slot: string }>;
  pages: Array<{
    id: string;
    file: string;
    title: string;
    section?: string;
  }>;
};

function resolveBundledDocsDir(): string {
  const env = process.env.ARCHON_BUNDLED_DOCS_DIR?.trim();
  if (env) {
    return path.resolve(env);
  }
  return path.resolve(__dirname, "../../../docs/bundled-plugin-authoring");
}

function readManifest(dir: string): BundledManifest | null {
  const p = path.join(dir, "manifest.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as BundledManifest;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.pages)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function noteTypeForFile(file: string): "markdown" | "mdx" {
  return file.toLowerCase().endsWith(".mdx") ? "mdx" : "markdown";
}

function buildNoteResponse(
  dir: string,
  manifest: BundledManifest,
  id: string,
): { note: Record<string, unknown> } | null {
  const metaBase = {
    bundledDoc: true,
    manifestVersion: manifest.version,
  };

  if (id === manifest.folder.id) {
    const content =
      "# Documentation\n\nBundled read-only guides. Open a page from Documentation → Guides in the sidebar.";
    return {
      note: {
        id: manifest.folder.id,
        parentId: null,
        type: "markdown",
        title: manifest.folder.title,
        content,
        metadata: { ...metaBase, bundledDocRole: "folder" },
      },
    };
  }

  const hub = manifest.hubPlaceholder;
  if (hub && hub.id === id) {
    const fp = path.join(dir, hub.file);
    if (!fs.existsSync(fp)) {
      return null;
    }
    const content = fs.readFileSync(fp, "utf8");
    return {
      note: {
        id: hub.id,
        parentId: manifest.folder.id,
        type: noteTypeForFile(hub.file),
        title: hub.title,
        content,
        metadata: {
          ...metaBase,
          bundledDocRole: "hub",
          bundledDocOrder: -5,
          sourceFile: hub.file,
        },
      },
    };
  }

  for (let i = 0; i < (manifest.companionPanels ?? []).length; i++) {
    const cp = manifest.companionPanels![i]!;
    if (cp.id !== id) {
      continue;
    }
    const fp = path.join(dir, cp.file);
    if (!fs.existsSync(fp)) {
      return null;
    }
    const content = fs.readFileSync(fp, "utf8");
    return {
      note: {
        id: cp.id,
        parentId: manifest.folder.id,
        type: noteTypeForFile(cp.file),
        title: cp.title,
        content,
        metadata: {
          ...metaBase,
          bundledDocRole: "companion",
          bundledDocCompanionSlot: cp.slot,
          bundledDocOrder: 5000 + i,
          sourceFile: cp.file,
        },
      },
    };
  }

  for (let i = 0; i < manifest.pages.length; i++) {
    const page = manifest.pages[i]!;
    if (page.id !== id) {
      continue;
    }
    const fp = path.join(dir, page.file);
    if (!fs.existsSync(fp)) {
      return null;
    }
    const content = fs.readFileSync(fp, "utf8");
    return {
      note: {
        id: page.id,
        parentId: manifest.folder.id,
        type: noteTypeForFile(page.file),
        title: page.title,
        content,
        metadata: {
          ...metaBase,
          bundledDocRole: "page",
          bundledDocOrder: i,
          bundledDocSection: page.section ?? "Guides",
          sourceFile: page.file,
        },
      },
    };
  }

  if (id === "archon-docs:about-archon") {
    const aboutPath = path.join(path.dirname(dir), "about-archon.md");
    if (!fs.existsSync(aboutPath)) {
      return null;
    }
    const content = fs.readFileSync(aboutPath, "utf8");
    return {
      note: {
        id: "archon-docs:about-archon",
        parentId: manifest.folder.id,
        type: "markdown",
        title: "About Archon",
        content,
        metadata: { ...metaBase, bundledDocRole: "page", sourceFile: "about-archon.md" },
      },
    };
  }

  return null;
}

/**
 * Read-only bundled documentation from disk (same sources as core `bundled-docs-seed`).
 * No auth — content is public product docs. Hosts should not expose internal paths.
 */
export type BundledGuideIndexRow = {
  id: string;
  title: string;
  section: string;
  order: number;
};

/**
 * Lightweight catalog for Documentation → Guides in the web shell (no WPN seed required).
 * Matches `bundledDocRole: "page"` rows from the manifest; same ids as `/public/bundled-docs/notes/:id`.
 */
export function buildBundledGuideIndex(dir: string, manifest: BundledManifest): BundledGuideIndexRow[] {
  const out: BundledGuideIndexRow[] = manifest.pages.map((page, i) => ({
    id: page.id,
    title: page.title,
    section: page.section ?? "Guides",
    order: i,
  }));
  const aboutPath = path.join(path.dirname(dir), "about-archon.md");
  if (fs.existsSync(aboutPath)) {
    out.push({
      id: "archon-docs:about-archon",
      title: "About Archon",
      section: "Reference",
      order: 10_000,
    });
  }
  out.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.title.localeCompare(b.title)));
  return out;
}

export function registerBundledDocsPublicRoutes(app: FastifyInstance): void {
  app.get("/public/bundled-docs/guide-index", async (_request, reply) => {
    const dir = resolveBundledDocsDir();
    if (!fs.existsSync(dir)) {
      return reply.status(404).send({ error: "Bundled documentation directory not found" });
    }
    const manifest = readManifest(dir);
    if (!manifest) {
      return reply.status(404).send({ error: "Bundled documentation manifest missing" });
    }
    return reply.send({ guides: buildBundledGuideIndex(dir, manifest) });
  });

  app.get("/public/bundled-docs/notes/:id", async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const dir = resolveBundledDocsDir();
    if (!fs.existsSync(dir)) {
      return reply.status(404).send({ error: "Bundled documentation directory not found" });
    }
    const manifest = readManifest(dir);
    if (!manifest) {
      return reply.status(404).send({ error: "Bundled documentation manifest missing" });
    }
    const out = buildNoteResponse(dir, manifest, id);
    if (!out) {
      return reply.status(404).send({ error: "Unknown bundled documentation id" });
    }
    return reply.send(out);
  });
}
