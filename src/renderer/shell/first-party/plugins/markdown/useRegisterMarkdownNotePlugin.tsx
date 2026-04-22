import React, { useEffect } from "react";
import type { NoteTypeReactEditorProps } from "../../../archon-contribution-registry";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { MarkdownNoteEditor } from "./MarkdownNoteEditor";
import { MdxNoteEditor } from "./MdxNoteEditor";

/**
 * System note plugin: registers the in-app editor for `markdown`, `mdx`, and `root` note types.
 * No shell rail, tabs, or companion regions.
 */
export function useRegisterMarkdownNotePlugin(): void {
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    function MarkdownNoteEditorHost(props: NoteTypeReactEditorProps) {
      return (
        <MarkdownNoteEditor
          note={props.note}
          persist={props.persistToNotesStore !== false}
        />
      );
    }
    function MdxNoteEditorHost(props: NoteTypeReactEditorProps) {
      return (
        <MdxNoteEditor note={props.note} persist={props.persistToNotesStore !== false} />
      );
    }
    const disposers = [
      contrib.registerNoteTypeReactEditor("markdown", MarkdownNoteEditorHost),
      contrib.registerNoteTypeReactEditor("mdx", MdxNoteEditorHost),
      contrib.registerNoteTypeReactEditor("root", MarkdownNoteEditorHost),
    ];
    return () => {
      for (const d of disposers) d();
    };
  }, [contrib]);
}
