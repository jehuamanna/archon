import { useEffect } from "react";
import { useArchonContributionRegistry } from "./ArchonContributionContext";

export type UseArchonNoteModeLineOptions = {
  /** Uniquely scopes mode-line ids (e.g. note id or scratch key). */
  scopeId: string;
  /** First plugin mode-line segment (note type + main UI mode). */
  primaryLine: string;
  /** Second segment; omit or empty to clear that slot on update/unmount. */
  secondaryLine?: string | null;
  /** Higher sorts first within a segment (default 80). */
  priority?: number;
  sourcePluginId?: string | null;
};

/**
 * Registers `plugin.primary` / `plugin.secondary` for the active note editor.
 * Disposes on unmount or when `scopeId` changes. Re-register with the same
 * contribution ids when strings change (registry replaces by id).
 */
export function useArchonNoteModeLine(options: UseArchonNoteModeLineOptions): void {
  const registry = useArchonContributionRegistry();
  const {
    scopeId,
    primaryLine,
    secondaryLine,
    priority = 80,
    sourcePluginId = "archon.note",
  } = options;

  useEffect(() => {
    const idP = `archon.note.scope.${scopeId}.primary`;
    const idS = `archon.note.scope.${scopeId}.secondary`;
    const disposePrimary = registry.registerModeLineItem({
      id: idP,
      segment: "plugin.primary",
      priority,
      text: primaryLine,
      sourcePluginId,
    });
    let disposeSecondary: (() => void) | null = null;
    if (secondaryLine != null && secondaryLine !== "") {
      disposeSecondary = registry.registerModeLineItem({
        id: idS,
        segment: "plugin.secondary",
        priority,
        text: secondaryLine,
        sourcePluginId,
      });
    }
    return () => {
      disposePrimary();
      disposeSecondary?.();
    };
  }, [registry, scopeId, primaryLine, secondaryLine, priority, sourcePluginId]);
}
