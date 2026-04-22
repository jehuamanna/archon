import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useState } from "react";
import { useMainDebugDock } from "../debug/MainDebugDockContext";
import { useTheme } from "../theme/ThemeContext";

export type SettingsCategory = "appearance" | "debug" | "keyboard";

const DEBUG_MODE_KEY = "archon-debug-mode";

function readDebugModeFlag(): boolean {
  try {
    return localStorage.getItem(DEBUG_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDebugModeFlag(v: boolean): void {
  try {
    if (v) {
      localStorage.setItem(DEBUG_MODE_KEY, "1");
    } else {
      localStorage.removeItem(DEBUG_MODE_KEY);
    }
  } catch {
    /* ignore */
  }
}

interface SettingsViewProps {
  category: SettingsCategory;
}

const KBD =
  "inline rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground/90 shadow-sm";

const SettingsView: React.FC<SettingsViewProps> = ({ category }) => {
  const { colorMode } = useTheme();
  const { toggleMainDebugDock, mainDebugDockExpanded } = useMainDebugDock();
  const [debugMode, setDebugMode] = useState(readDebugModeFlag);
  const [seedSampleNotes, setSeedSampleNotes] = useState(true);
  const [seedPrefLoaded, setSeedPrefLoaded] = useState(false);

  useEffect(() => {
    void getArchon().getAppPrefs().then((p) => {
      setSeedSampleNotes(p.seedSampleNotes);
      setSeedPrefLoaded(true);
    });
  }, []);

  if (category === "keyboard") {
    return (
      <div className="box-border h-full overflow-auto p-6">
        <h2 className="text-[13px] font-semibold text-foreground">
          Keyboard shortcuts
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Plugin editor shortcuts (⌘ on macOS, Ctrl on Windows/Linux). These are
          fixed in this version; configurable keymaps may come later.
        </p>
        <ul className="mt-6 grid max-w-xl grid-cols-1 gap-x-10 gap-y-2 text-[11px] text-muted-foreground sm:grid-cols-2">
          <li>
            <kbd className={KBD}>⌘/Ctrl+S</kbd> Save
          </li>
          <li>
            <kbd className={KBD}>⌘/Ctrl+⇧S</kbd> Save all
          </li>
          <li>
            <kbd className={KBD}>⇧T</kbd> Check types
          </li>
          <li>
            <kbd className={KBD}>⇧B</kbd> Bundle
          </li>
          <li>
            <kbd className={KBD}>⇧L</kbd> Reload registry
          </li>
          <li>
            <kbd className={KBD}>⇧E</kbd> Bundle + reload
          </li>
          <li>
            <kbd className={KBD}>⇧O</kbd> Import files
          </li>
          <li>
            <kbd className={KBD}>⇧N</kbd> New file
          </li>
          <li>
            <kbd className={KBD}>⇧P</kbd> Load parent (.archonplugin)
          </li>
          <li>
            <kbd className={KBD}>⇧D</kbd> Copy dist
          </li>
          <li>
            <kbd className={KBD}>⇧C</kbd> / <kbd className={KBD}>⇧X</kbd> /{" "}
            <kbd className={KBD}>⇧V</kbd> Copy / cut / paste path
          </li>
          <li>
            <kbd className={KBD}>⇧M</kbd> / <kbd className={KBD}>F2</kbd> Rename
          </li>
          <li>
            <kbd className={KBD}>⇧I</kbd> Install dependencies
          </li>
          <li>
            <kbd className={KBD}>⇧⌫</kbd> Delete path
          </li>
        </ul>
      </div>
    );
  }

  if (category === "appearance") {
    return (
      <div className="box-border h-full overflow-auto p-6">
        <h2 className="text-[13px] font-semibold text-foreground">Appearance</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Theme follows the app shell and editor surfaces.
        </p>
        <fieldset className="mt-6 space-y-3">
          <legend className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Color mode
          </legend>
          <p className="text-[11px] text-muted-foreground">
            Light mode only for now. Dark and system options will return later.
          </p>
          <label className="flex cursor-not-allowed items-center gap-2 text-[12px] text-muted-foreground">
            <input
              type="radio"
              name="archon-color"
              checked={colorMode === "light"}
              disabled
            />
            Light
          </label>
        </fieldset>
        <fieldset className="mt-8 space-y-2">
          <legend className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            New projects
          </legend>
          <label className="flex cursor-pointer items-start gap-2 text-[12px]">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border-border"
              checked={!seedSampleNotes}
              disabled={!seedPrefLoaded}
              onChange={(e) => {
                const skip = e.target.checked;
                const nextEnabled = !skip;
                setSeedSampleNotes(nextEnabled);
                void getArchon().setSeedSampleNotes(nextEnabled).then((r) => {
                  if (r.ok) {
                    setSeedSampleNotes(r.seedSampleNotes);
                  }
                });
              }}
            />
            <span>
              Skip sample notes when opening or adding an{" "}
              <span className="font-mono text-[11px]">empty</span> project folder
              <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                When on, new empty folders get Home plus Markdown and Rich Text
                starter notes, same as Open project and Add folder.
              </span>
            </span>
          </label>
        </fieldset>
        <div className="mt-8 rounded-md border border-border bg-muted/20 p-4 text-[11px] text-muted-foreground">
          Additional layout options may be added here later.
        </div>
      </div>
    );
  }

  return (
    <div className="box-border h-full overflow-auto p-6">
      <h2 className="text-[13px] font-semibold text-foreground">Debug</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Diagnostics and developer tooling for this window.
      </p>
      <div className="mt-6 space-y-6">
        <div>
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={mainDebugDockExpanded}
              onChange={() => toggleMainDebugDock()}
              className="h-3.5 w-3.5 rounded-sm border-border"
            />
            Show main log panel (bottom dock)
          </label>
          <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
            Toggles the resizable panel that streams main-process log lines.
          </p>
        </div>
        <div>
          <button
            type="button"
            className="rounded-sm border border-input bg-background px-3 py-1.5 text-[12px] shadow-sm hover:bg-muted/50"
            onClick={() => void getArchon().toggleDeveloperTools()}
          >
            Open Developer Tools
          </button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Electron DevTools for this renderer (same as a typical browser
            inspector). Use it while the Plugin IDE preview is open to debug the
            host window; the plugin note UI runs inside a sandboxed iframe with
            its own document.
          </p>
        </div>
        <div>
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => {
                const v = e.target.checked;
                setDebugMode(v);
                writeDebugModeFlag(v);
              }}
              className="h-3.5 w-3.5 rounded-sm border-border"
            />
            Debug mode (reserved)
          </label>
          <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
            Stored locally for future verbose logging and diagnostics. It does
            not change the main log panel today.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SettingsView;
