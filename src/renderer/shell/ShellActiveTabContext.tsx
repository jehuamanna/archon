import React, { createContext, useContext } from "react";
import type { ShellTabInstance } from "./registries/ShellTabsRegistry";

const Ctx = createContext<ShellTabInstance | null>(null);

export function ShellActiveMainTabProvider({
  tab,
  children,
}: {
  tab: ShellTabInstance | null;
  children: React.ReactNode;
}): React.ReactElement {
  return <Ctx.Provider value={tab}>{children}</Ctx.Provider>;
}

/** Active shell tab for the main workbench column (note id lives in `state`). */
export function useShellActiveMainTab(): ShellTabInstance | null {
  return useContext(Ctx);
}
