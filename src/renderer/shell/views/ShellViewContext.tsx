import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { ShellViewRegistry } from "./ShellViewRegistry";

const Ctx = createContext<ShellViewRegistry | null>(null);

export function ShellViewProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const reg = useMemo(() => new ShellViewRegistry(), []);
  useSyncExternalStore(
    (onStoreChange) => reg.subscribe(onStoreChange),
    () => reg.getSnapshotVersion(),
    () => 0,
  );
  return <Ctx.Provider value={reg}>{children}</Ctx.Provider>;
}

export function useShellViewRegistry(): ShellViewRegistry {
  const r = useContext(Ctx);
  if (!r) throw new Error("useShellViewRegistry requires ShellViewProvider");
  return r;
}

