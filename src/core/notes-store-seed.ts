import { randomUUID } from "crypto";
import { normalizeLegacyNoteType } from "../shared/note-type-legacy";
import { registry } from "./registry";
import {
  getChildren,
  notes,
  setChildren,
} from "./notes-store-core";

const defaultSampleContent: Record<
  string,
  { content: string; metadata?: Record<string, unknown> }
> = {
  root: {
    content:
      "# Welcome to Archon\n\nThis **Home** note is the workspace root — use it as your documentation landing page.\n\n## Tips\n\n- Add child notes for topics, specs, and runbooks.\n- Use **Markdown** notes for readable docs; other note types showcase plugins.\n- The tree on the left is your single outline for everything in this workspace.\n\n---\n\n_Edit this page anytime to match your project._",
  },
  markdown: {
    content:
      "# Hello World\n\nThis is a **markdown** note rendered by a plugin!\n\n## Features\n\n- Dynamic plugin loading\n- Component registry\n- Hot reload support",
  },
  mdx: {
    content:
      "# MDX note\n\n<ArchonCallout>\n\nUse **MDX** with whitelisted components. Curly-brace JavaScript expressions are disabled in workspace notes for safety.\n\n</ArchonCallout>\n",
  },
  text: {
    content:
      "<h1>Rich Text Editor</h1><p>This note uses <strong>Tiptap</strong> for rich text editing.</p>",
  },
  code: {
    content:
      'function hello() {\n  console.log("Hello from Monaco!");\n}\n\nhello();',
    metadata: { language: "javascript" },
  },
  pdf: {
    content: '{"assetRel":""}',
  },
  image: {
    content: '{"assetRel":""}',
  },
  video: {
    content: '{"assetRel":""}',
  },
  audio: {
    content: '{"assetRel":""}',
  },
  "js-notebook": {
    content: JSON.stringify([
      { id: "seed-o1", name: "greeting", inputs: [], body: '"Hello from JS notebook"' },
      { id: "seed-o2", name: "n", inputs: [], body: "40 + 2" },
    ]),
  },
};

const defaultTypeToTitle: Record<string, string> = {
  root: "Home",
  markdown: "Markdown Note",
  mdx: "MDX Note",
  text: "Rich Text Note",
  code: "Code Editor",
  pdf: "PDF",
  image: "Image",
  video: "Video",
  audio: "Audio",
  "js-notebook": "JS notebook",
};

export function titleForType(type: string): string {
  const t = normalizeLegacyNoteType(type);
  return (
    defaultTypeToTitle[t] ||
    `${t.charAt(0).toUpperCase() + t.slice(1)} Note`
  );
}

export function bodyForType(type: string): {
  content: string;
  metadata?: Record<string, unknown>;
} {
  const t = normalizeLegacyNoteType(type);
  const sc = defaultSampleContent[t];
  return {
    content: sc?.content || `Sample content for ${t}`,
    metadata: sc?.metadata,
  };
}

export function pickWorkspaceOverviewType(
  registeredTypes: string[],
): string | null {
  if (registeredTypes.length === 0) {
    return null;
  }
  if (registeredTypes.includes("markdown")) {
    return "markdown";
  }
  if (registeredTypes.includes("root")) {
    return "root";
  }
  return registeredTypes[0]!;
}

export function overviewTitleAndBody(overviewType: string): {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
} {
  if (overviewType === "markdown") {
    return {
      title: "Home",
      content: defaultSampleContent.root.content,
    };
  }
  const { content, metadata } = bodyForType(overviewType);
  return {
    title: overviewType === "root" ? "Home" : titleForType(overviewType),
    content,
    metadata,
  };
}

/**
 * Types to create as sample children under seeded Home — same set as “new note” pickers
 * (no system plugins, no workspace `root` pseudo-type).
 */
export function sampleChildNoteTypes(
  overviewType: string,
  selectableNoteTypes: string[],
): string[] {
  return selectableNoteTypes.filter(
    (t) => t !== "root" && t !== overviewType,
  );
}

let seedSampleNotesEnabled = true;

export function setSeedSampleNotesPreference(enabled: boolean): void {
  seedSampleNotesEnabled = enabled;
}

export function getSeedSampleNotesPreference(): boolean {
  return seedSampleNotesEnabled;
}

export function ensureNotesSeeded(
  registeredTypes: string[],
  opts?: { homeMarkdown?: string },
): void {
  if (!seedSampleNotesEnabled) {
    return;
  }
  if (notes.size > 0) {
    return;
  }
  const overviewType = pickWorkspaceOverviewType(registeredTypes);
  if (!overviewType) {
    return;
  }
  const { title: overviewTitle, content, metadata } = overviewTitleAndBody(
    overviewType,
  );
  const homeId = randomUUID();
  notes.set(homeId, {
    id: homeId,
    parentId: null,
    type: overviewType,
    title: overviewTitle,
    content:
      overviewType === "markdown" && opts?.homeMarkdown != null
        ? opts.homeMarkdown
        : content,
    metadata,
  });
  const childTypes = sampleChildNoteTypes(
    overviewType,
    registry.getSelectableNoteTypes(),
  );
  const childIds: string[] = [];
  for (const type of childTypes) {
    const id = randomUUID();
    const body = bodyForType(type);
    notes.set(id, {
      id,
      parentId: homeId,
      type,
      title: titleForType(type),
      content: body.content,
      metadata: body.metadata,
    });
    childIds.push(id);
  }
  setChildren(null, [homeId]);
  setChildren(homeId, childIds);
}
