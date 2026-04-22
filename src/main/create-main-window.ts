import { BrowserWindow, Menu, app, type MenuItemConstructorOptions } from "electron";
import { readPrimaryWpnBackend } from "./electron-launch-profile";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import {
  createCloudWpnWindow,
  createLocalVaultWindow,
} from "./create-cloud-wpn-window";
import { registerWebContentsWpnBackend } from "./electron-wpn-backend";
import { ctx } from "./main-context";
import {
  DEV_SERVER_NET_ERRORS,
  devServerMissingDataUrl,
  resolveMainWindowLoadUrl,
} from "./main-window-url";

declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export { resolveMainWindowLoadUrl } from "./main-window-url";

export function createMainWindow(): void {
  const primaryBackend = readPrimaryWpnBackend(app.getPath("userData"));
  ctx.mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--archon-electron-wpn-backend=${primaryBackend}`],
      /** Never disable DevTools; production debugging uses F12 / Ctrl+Shift+I / (macOS) Cmd+Opt+I. */
      devTools: true,
    },
  });
  registerWebContentsWpnBackend(ctx.mainWindow.webContents, primaryBackend);
  /**
   * `runAppReady` clears the app menu (`Menu.setApplicationMenu(null)`). Without a replacement,
   * Linux/Windows lose menu accelerators; macOS keeps no menu at all — restore a minimal menu with
   * View → Toggle Developer Tools (menu bar visible; F12 / Ctrl+Shift+I still work).
   */
  const appMenu: MenuItemConstructorOptions =
    process.platform === "darwin"
      ? {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }
      : {
          label: app.name,
          submenu: [{ role: "quit" }],
        };

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    {
      label: "File",
      submenu: [
        {
          label: "New cloud WPN window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            createCloudWpnWindow();
          },
        },
        { type: "separator" },
        {
          label: "New local window",
          click: () => {
            createLocalVaultWindow();
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        { type: "separator" },
        /** Default accelerator is Ctrl+Shift+I (Linux/Win); F12 / Cmd+Opt+I in before-input-event. */
        { role: "toggleDevTools" },
      ],
    },
  ];

  if (process.env.NODE_ENV === "development") {
    template.push({
      label: "Developer",
      submenu: [
        {
          label: "Log contribution registry count",
          accelerator:
            process.platform === "darwin"
              ? "Alt+Cmd+Shift+L"
              : "Ctrl+Shift+Alt+L",
          click: (_item, browserWindow) => {
            const win = browserWindow ?? ctx.mainWindow;
            if (win instanceof BrowserWindow) {
              win.webContents.send(IPC_CHANNELS.UI_RUN_CONTRIBUTION_COMMAND, {
                commandId: "archon.contributions.listCommands",
              });
            }
          },
        },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  const initialLoadUrl = resolveMainWindowLoadUrl();
  ctx.mainWindow.loadURL(initialLoadUrl);

  if (process.env.NODE_ENV === "development") {
    ctx.mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || validatedURL.startsWith("data:")) {
        return;
      }
      if (!DEV_SERVER_NET_ERRORS.has(errorCode)) {
        return;
      }
      let expected: URL;
      let got: URL;
      try {
        expected = new URL(initialLoadUrl);
        got = new URL(validatedURL);
      } catch {
        return;
      }
      if (got.origin !== expected.origin) {
        return;
      }
      const win = ctx.mainWindow;
      if (!win || win.isDestroyed()) {
        return;
      }
      void win.loadURL(devServerMissingDataUrl(initialLoadUrl));
    });
  }

  /** Nudge renderer to run HTTP sync while online (`@archon/platform` DesktopHost). */
  const SYNC_TRIGGER_MS = 30_000;
  ctx.mainWindow.webContents.once("did-finish-load", () => {
    setInterval(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.DESKTOP_SYNC_TRIGGER);
        }
      }
    }, SYNC_TRIGGER_MS);
  });

  if (process.env.NODE_ENV === "development") {
    ctx.mainWindow.webContents.openDevTools();
  } else if (process.env.ARCHON_OPEN_DEVTOOLS === "1") {
    /** Production debugging on Linux/packaged builds: `ARCHON_OPEN_DEVTOOLS=1 ./archon` */
    ctx.mainWindow.webContents.openDevTools();
  }

  ctx.mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) {
      return;
    }
    const win = ctx.mainWindow;
    if (!win || win.isDestroyed()) {
      return;
    }

    if (input.key === "F12") {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }

    const primary = input.control || input.meta;

    if (primary && input.shift && input.key.toLowerCase() === "i") {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }

    if (
      process.platform === "darwin" &&
      input.meta &&
      input.alt &&
      input.key.toLowerCase() === "i"
    ) {
      event.preventDefault();
      win.webContents.toggleDevTools();
      return;
    }

    if (!primary || input.alt || input.shift) {
      return;
    }
    if (input.key.toLowerCase() !== "r") {
      return;
    }
    event.preventDefault();
    win.webContents.reload();
  });

  const mainWin = ctx.mainWindow;
  mainWin.on("closed", () => {
    if (ctx.mainWindow === mainWin) {
      ctx.mainWindow = null;
    }
  });
}
