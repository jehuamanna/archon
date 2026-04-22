import { ipcMain } from "electron";
import { assertElectronFileVaultWindow } from "./electron-wpn-backend";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  buildWorkspaceRxdbMirrorPayload,
  flushWorkspaceMirrorFromRenderer,
} from "./workspace-rxdb-mirror-broadcast";

export function registerWorkspaceRxdbMirrorIpc(): void {
  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_PULL);
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_PULL, (event) => {
    assertElectronFileVaultWindow(event);
    const payload = buildWorkspaceRxdbMirrorPayload();
    if (!payload) {
      return { ok: false as const, error: "No workspace mirror payload" };
    }
    return { ok: true as const, payload };
  });

  ipcMain.removeHandler(IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_FLUSH_TO_DISK);
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_RXDB_MIRROR_FLUSH_TO_DISK, (event, raw: unknown) => {
    assertElectronFileVaultWindow(event);
    return flushWorkspaceMirrorFromRenderer(raw);
  });
}
