import { getArchon } from "../../../shared/archon-host-access";

type Archon = ReturnType<typeof getArchon>;

export type PluginInventoryRow = Awaited<
  ReturnType<Archon["getPluginInventory"]>
>[number];

export type PluginUiMeta = Awaited<
  ReturnType<Archon["getPluginManifestUi"]>
>;

export type UserMessage = {
  type: "success" | "error" | "info";
  text: string;
} | null;
