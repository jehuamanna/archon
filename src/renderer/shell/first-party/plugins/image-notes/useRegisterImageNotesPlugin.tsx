import React, { useEffect } from "react";
import type { NoteTypeReactEditorProps } from "../../../archon-contribution-registry";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { ImageNoteEditor } from "./ImageNoteEditor";

/**
 * First-party image-notes plugin: registers the in-app React editor for
 * `image` note types. Wrapped in a try/catch so a bug here can't break the
 * shell for other plugins (see Risks note, 5.2).
 */
export function useRegisterImageNotesPlugin(): void {
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    let dispose: (() => void) | null = null;
    try {
      function ImageNoteEditorHost(props: NoteTypeReactEditorProps) {
        return (
          <ImageNoteEditor
            note={props.note}
            persist={props.persistToNotesStore !== false}
          />
        );
      }
      dispose = contrib.registerNoteTypeReactEditor("image", ImageNoteEditorHost);
    } catch (err) {
      console.error("[image-notes] failed to register plugin", err);
    }
    return () => {
      if (dispose) {
        try {
          dispose();
        } catch (err) {
          console.error("[image-notes] dispose error", err);
        }
      }
    };
  }, [contrib]);
}
