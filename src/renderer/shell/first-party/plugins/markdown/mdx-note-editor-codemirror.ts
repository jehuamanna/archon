/**
 * MDX notes share the markdown CodeMirror language (GFM-oriented highlighting).
 * JSX-heavy content is still plain text to the highlighter; compile-time rules live in
 * remark-archon-mdx-trust and remark-archon-mdx-facade-imports. For user className utilities
 * in raw MDX, prefer @archon/ui — arbitrary strings are not Tailwind-scanned.
 */
export {
  markdownNoteEditorExtensions as mdxNoteEditorExtensions,
  type MarkdownNoteOnBlurRef as MdxNoteOnBlurRef,
  type MarkdownNoteSelectionSyncRef as MdxNoteSelectionSyncRef,
  type MarkdownNoteWikiKeymapRef as MdxNoteWikiKeymapRef,
  type MarkdownNoteWikiKeymapState as MdxNoteWikiKeymapState,
} from "./markdown-note-editor-codemirror";
