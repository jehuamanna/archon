import React, { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { ShellAppMenuRegistry } from "./ShellAppMenuRegistry";
import { ShellMenuRailRegistry } from "./ShellMenuRailRegistry";
import { ShellKeymapRegistry } from "./ShellKeymapRegistry";
import { ShellPanelMenuRegistry } from "./ShellPanelMenuRegistry";
import { ShellTabsRegistry } from "./ShellTabsRegistry";
import { ShellWidgetSlotRegistry } from "../widget-slots/ShellWidgetSlotRegistry";

export type ShellRegistries = {
  appMenu: ShellAppMenuRegistry;
  menuRail: ShellMenuRailRegistry;
  keymap: ShellKeymapRegistry;
  panelMenu: ShellPanelMenuRegistry;
  tabs: ShellTabsRegistry;
  /** Optional React widgets mounted in rail / chrome slots (see {@link ShellWidgetSlotRegistry}). */
  widgetSlots: ShellWidgetSlotRegistry;
};

const Ctx = createContext<ShellRegistries | null>(null);

export function ShellRegistriesProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const regs = useMemo<ShellRegistries>(() => {
    return {
      appMenu: new ShellAppMenuRegistry(),
      menuRail: new ShellMenuRailRegistry(),
      keymap: new ShellKeymapRegistry(),
      panelMenu: new ShellPanelMenuRegistry(),
      tabs: new ShellTabsRegistry(),
      widgetSlots: new ShellWidgetSlotRegistry(),
    };
  }, []);

  const registriesEpoch = useRef(0);
  useSyncExternalStore(
    (onChange) => {
      const bump = (): void => {
        registriesEpoch.current += 1;
        onChange();
      };
      const unsubs = [
        regs.appMenu.subscribe(bump),
        regs.menuRail.subscribe(bump),
        regs.keymap.subscribe(bump),
        regs.panelMenu.subscribe(bump),
        regs.tabs.subscribe(bump),
        regs.widgetSlots.subscribe(bump),
      ];
      return () => {
        for (const u of unsubs) u();
      };
    },
    () => registriesEpoch.current,
    () => 0,
  );

  return <Ctx.Provider value={regs}>{children}</Ctx.Provider>;
}

export function useShellRegistries(): ShellRegistries {
  const r = useContext(Ctx);
  if (!r) throw new Error("useShellRegistries requires ShellRegistriesProvider");
  return r;
}

