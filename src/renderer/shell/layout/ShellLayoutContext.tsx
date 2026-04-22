import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { defaultShellLayoutState } from "./ShellLayoutState";
import { ShellLayoutStore } from "./ShellLayoutStore";

const Ctx = createContext<ShellLayoutStore | null>(null);

export function ShellLayoutProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const store = useMemo(() => new ShellLayoutStore(), []);

  useEffect(() => {
    void store.loadFromHost();
  }, [store]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useShellLayoutStore(): ShellLayoutStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useShellLayoutStore requires ShellLayoutProvider");
  return s;
}

export function useShellLayoutState() {
  const store = useShellLayoutStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.get(),
    () => defaultShellLayoutState(),
  );
}

