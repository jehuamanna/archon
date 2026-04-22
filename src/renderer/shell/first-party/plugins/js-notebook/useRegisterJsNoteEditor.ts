import { useEffect } from "react";
import { useArchonContributionRegistry } from "../../../ArchonContributionContext";
import { JsNoteEditorHost } from "./JsNoteEditor";

/**
 * Registers the in-shell React editor for `js-notebook` notes (content = JSON cell array).
 */
export function useRegisterJsNoteEditor(): void {
  const contrib = useArchonContributionRegistry();

  useEffect(() => {
    return contrib.registerNoteTypeReactEditor("js-notebook", JsNoteEditorHost);
  }, [contrib]);
}
