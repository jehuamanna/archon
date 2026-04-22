import "./main/ensure-safe-cwd";
import { loadRepoRootEnvOnce } from "./main/load-repo-root-env";

loadRepoRootEnvOnce();

import * as fs from "fs";
import * as path from "path";
import { app, BrowserWindow, protocol } from "electron";
import { runAppReady } from "./main/run-app-ready";
import { registerStaticIpcHandlers } from "./main/register-static-ipc";
import { createMainWindow } from "./main/create-main-window";
import { flushWorkspaceStorePendingPersist } from "./core/workspace-store";
import { ctx } from "./main/main-context";

/**
 * Linux: Align Electron’s temp with `linux-chromium-tmp-env.ts` (TMPDIR before electron
 * loads). Portable / custom `userData` may differ from `~/.config/archon`; this wins.
 * Opt out: `ARCHON_SKIP_CHROMIUM_TEMP_REDIRECT=1`.
 */
function applyLinuxUserDataTemp(): void {
  if (process.platform !== "linux") {
    return;
  }
  if (process.env.ARCHON_SKIP_CHROMIUM_TEMP_REDIRECT === "1") {
    return;
  }
  try {
    const dir = path.join(app.getPath("userData"), "chromium-tmp");
    fs.mkdirSync(dir, { recursive: true });
    app.setPath("temp", dir);
    process.env.TMPDIR = dir;
    process.env.TMP = dir;
    process.env.TEMP = dir;
  } catch {
    /* ignore */
  }
}

applyLinuxUserDataTemp();

/**
 * Linux (especially AppImage): Chromium may abort if `chrome-sandbox` is present but
 * not SUID root (4755). Portable mounts under `/tmp/.mount_*` often hit this.
 * Must run before app ready.
 */
function applyLinuxSandboxMitigations(): void {
  if (process.platform !== "linux") {
    return;
  }
  app.commandLine.appendSwitch("no-sandbox");
}

applyLinuxSandboxMitigations();

/**
 * Chromium POSIX shm in `/dev/shm` can FATAL (`platform_shared_memory_region_posix`) on
 * some Linux stacks even when `/dev/shm` looks fine (e.g. ESRCH with certain GPU/Wayland
 * setups); `chmod 1777` does not always help. Default to `--disable-dev-shm-usage` on Linux.
 *
 * Some paths still use system `/tmp`, not always `TMPDIR`. Opt out: `ARCHON_USE_DEV_SHM=1`.
 */
function applyLinuxDevShmMitigation(): void {
  if (process.platform !== "linux") {
    return;
  }
  if (process.env.ARCHON_USE_DEV_SHM === "1") {
    return;
  }
  app.commandLine.appendSwitch("disable-dev-shm-usage");
}

applyLinuxDevShmMitigation();

/**
 * Linux: MP4 in <video> can crash or loop-restart the GPU process (gbm_bo_import,
 * CreateSharedImage) on some Mesa/Wayland/NVIDIA stacks. Mitigate before app ready.
 * Opt out: ARCHON_HW_VIDEO=1 to keep HW decode. Nuclear: ARCHON_DISABLE_HARDWARE_ACCELERATION=1.
 */
function applyLinuxGpuVideoMitigations(): void {
  if (process.platform !== "linux") {
    return;
  }
  if (process.env.ARCHON_DISABLE_HARDWARE_ACCELERATION === "1") {
    app.disableHardwareAcceleration();
    return;
  }
  if (process.env.ARCHON_HW_VIDEO === "1") {
    return;
  }
  app.commandLine.appendSwitch("disable-accelerated-video-decode");
}

applyLinuxGpuVideoMitigations();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "archon-asset",
    privileges: {
      standard: true,
      secure: true,
      /** Lets nested PDF/media frames load despite strict CSP in host / srcdoc. */
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  /**
   * Back-compat alias: early UI/content used `node-asset:` (missing "x").
   * Keep this registered so existing notes and plugins don't 404.
   */
  {
    scheme: "node-asset",
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  /** Bundled pdf.js worker (`main_window/pdf.worker.min.mjs`) for plugin iframes — avoids `import(blob:)`. */
  {
    scheme: "archon-pdf-worker",
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

registerStaticIpcHandlers();

app.on("ready", () => {
  runAppReady();
});

app.on("before-quit", () => {
  flushWorkspaceStorePendingPersist();
  // Terminate all spawned MCP server child processes
  if (ctx.mcpClientManager) {
    ctx.mcpClientManager.disconnectAll().catch(() => {});
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
