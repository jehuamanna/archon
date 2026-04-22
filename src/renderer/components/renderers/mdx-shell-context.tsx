import React, { createContext, useContext } from "react";
import type { Note } from "@archon/ui-types";
import type { MarkdownUiLinkCallbacks } from "./useArchonMarkdownUiComponents";

export type MdxShellContextValue = MarkdownUiLinkCallbacks & {
  nestingDepth: number;
  /** The note currently being rendered — available to bundled-tier MDX via `useMdxShell()`. */
  note: Note | null;
};

const MdxShellContext = createContext<MdxShellContextValue | null>(null);

export function MdxShellProvider({
  value,
  children,
}: {
  value: MdxShellContextValue;
  children: React.ReactNode;
}): React.ReactElement {
  return <MdxShellContext.Provider value={value}>{children}</MdxShellContext.Provider>;
}

export function useMdxShell(): MdxShellContextValue {
  const v = useContext(MdxShellContext);
  if (!v) {
    return {
      nestingDepth: 0,
      note: null,
    };
  }
  return v;
}
