import React from "react";
import { ArchonLogo } from "../components/ArchonLogo";
import type { ElectronRunModeChoice } from "./electron-run-mode";
import { ElectronHomeChromeBar } from "./ElectronHomeChromeBar";

export function ElectronRunModeGreet({
  onChoose,
}: {
  onChoose: (mode: ElectronRunModeChoice) => void;
}): React.ReactElement {
  const card =
    "flex flex-col rounded-xl border border-border bg-background/80 p-5 shadow-sm backdrop-blur transition-colors hover:border-primary/30";

  return (
    <div className="relative flex h-screen min-h-0 w-full flex-col items-center justify-center overflow-y-auto bg-background px-4 py-8 text-foreground">
      <ElectronHomeChromeBar />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -bottom-48 -right-40 h-[34rem] w-[34rem] rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-3xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/10 text-primary">
            <ArchonLogo className="h-7 w-7" title="Archon" />
          </div>
          <h1 className="mt-4 text-balance text-[22px] font-semibold tracking-tight">
            How do you want to use Archon?
          </h1>
          <p className="mt-2 max-w-xl text-pretty text-[12px] leading-5 text-muted-foreground">
            <span className="font-medium text-foreground">Scratch</span> is a throwaway session (IndexedDB, no folder on
            disk). <span className="font-medium text-foreground">Local</span> is your private vault on disk (and
            optional sync from the top bar).             <span className="font-medium text-foreground">Cloud</span> matches the web app: workspaces and
            notes live on your configured sync API. You will be prompted to register or sign in when you enter.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <button type="button" className={card} onClick={() => onChoose("scratch")}>
            <span className="text-[13px] font-semibold">Scratch</span>
            <span className="mt-2 text-left text-[12px] leading-5 text-muted-foreground">
              Try ideas in a temporary session. Data stays in this app until you start a new scratch session or clear
              it. Not the same as the shell &quot;Scratch&quot; markdown tab (that is a single pinned note inside a
              workspace).
            </span>
          </button>
          <button type="button" className={card} onClick={() => onChoose("local")}>
            <span className="text-[13px] font-semibold">Local</span>
            <span className="mt-2 text-left text-[12px] leading-5 text-muted-foreground">
              Open a folder vault on this machine. Optional: sign in from Sync to push flat notes when a sync API URL
              is configured.
            </span>
          </button>
          <button type="button" className={card} onClick={() => onChoose("cloud")}>
            <span className="text-[13px] font-semibold">Cloud</span>
            <span className="mt-2 text-left text-[12px] leading-5 text-muted-foreground">
              Same WPN path as the browser: Mongo-backed workspaces via the sync API. Register or sign in is shown
              automatically when you open this mode.
            </span>
          </button>
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Your choice is saved on this device (key{" "}
          <span className="font-mono">archon.electron.runMode</span>). Use Close or Exit session to return here. The
          first window type may reload once when switching to or from Cloud.
        </p>
      </div>
    </div>
  );
}
