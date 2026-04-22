import React, { useState } from "react";
import type { MainDebugLogLine } from "./useMainDebugLogStream";

type BottomDockTab = "debug" | "terminal";

export interface MainDebugDockContentProps {
  mainDebugLogs: MainDebugLogLine[];
  logScrollRef: React.RefObject<HTMLPreElement | null>;
  clearMainDebugLogs: () => Promise<void>;
  onHide: () => void;
}

const MainDebugDockContent: React.FC<MainDebugDockContentProps> = ({
  mainDebugLogs,
  logScrollRef,
  clearMainDebugLogs,
  onHide,
}) => {
  const [bottomDockTab, setBottomDockTab] = useState<BottomDockTab>("debug");

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border bg-muted/25 dark:bg-muted/15">
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/80 bg-muted/40 px-2 py-1"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={bottomDockTab === "debug"}
          className={`rounded px-2.5 py-1 text-[11px] font-medium ${
            bottomDockTab === "debug"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setBottomDockTab("debug")}
        >
          Debug
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={bottomDockTab === "terminal"}
          title="Reserved for a future integrated shell"
          className={`rounded px-2.5 py-1 text-[11px] font-medium ${
            bottomDockTab === "terminal"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setBottomDockTab("terminal")}
        >
          Terminal
        </button>
        <span className="flex-1 min-w-[1rem]" />
        {bottomDockTab === "debug" ? (
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void clearMainDebugLogs()}
          >
            Clear
          </button>
        ) : null}
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Hide bottom panel"
          aria-label="Hide bottom panel"
          onClick={onHide}
        >
          Hide
        </button>
      </div>
      {bottomDockTab === "debug" ? (
        <pre
          ref={logScrollRef}
          className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words"
        >
          {mainDebugLogs.length === 0 ? (
            <span className="text-muted-foreground">
              Main process logs (Node / Electron main console). Open this panel
              from the sidebar (“Main debug”) or Plugin IDE → File → Toggle
              bottom panel.
            </span>
          ) : (
            mainDebugLogs.map((line, i) => {
              const level = line.level;
              const color =
                level === "error"
                  ? "font-medium text-foreground"
                  : level === "warn"
                    ? "text-foreground/90"
                    : level === "debug"
                      ? "text-muted-foreground"
                      : "text-foreground/90";
              const t = new Date(line.ts);
              const stamp = t.toLocaleTimeString(undefined, {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              return (
                <div key={`${line.ts}-${i}`} className={color}>
                  <span className="text-muted-foreground select-none">
                    [{stamp}]{" "}
                  </span>
                  <span className="text-muted-foreground/80 uppercase text-[10px]">
                    {level}{" "}
                  </span>
                  {line.text}
                </div>
              );
            })
          )}
        </pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px] text-muted-foreground">
          An interactive terminal may be added here later. For now, use the
          system terminal or your editor for shell commands.
        </div>
      )}
    </div>
  );
};

export default MainDebugDockContent;
