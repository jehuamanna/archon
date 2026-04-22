import React from "react";
import type { PluginIDEProps } from "../plugin-ide/PluginIDE.types";
import { PluginIDEView } from "../plugin-ide/PluginIDEView";
import { usePluginIDE } from "../plugin-ide/usePluginIDE";

const PluginIDE: React.FC<PluginIDEProps> = (props) => {
  const vm = usePluginIDE(props);
  return <PluginIDEView vm={vm} />;
};

export default PluginIDE;
export type { PluginIDEProps } from "../plugin-ide/PluginIDE.types";
