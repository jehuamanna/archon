import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ARCHON_MINIBAR_OUTPUT_EVENT,
  type ArchonMinibarEchoDetail,
} from "./minibarEcho";
import type { ArchonShellVm } from "./useArchonShell";

function splitMiniBar(text: string): { id: string; rest: string; hasSpace: boolean } {
  const raw = text ?? "";
  const firstSpace = raw.indexOf(" ");
  if (firstSpace < 0) return { id: raw, rest: "", hasSpace: false };
  return { id: raw.slice(0, firstSpace), rest: raw.slice(firstSpace + 1), hasSpace: true };
}

function commandLabel(c: { title: string; category?: string | null }): string {
  const cat = c.category?.trim();
  return cat ? `${cat}: ${c.title}` : c.title;
}

function restoreFocusOutsideMinibar(lastOutside: React.MutableRefObject<HTMLElement | null>): void {
  const el = lastOutside.current;
  if (el && document.contains(el)) {
    try {
      el.focus();
      if (document.activeElement === el) return;
    } catch {
      /* ignore */
    }
  }
  const main = document.querySelector("[data-archon-main-surface]") as HTMLElement | null;
  main?.focus();
}

export function ArchonMiniBar({ vm }: { vm: ArchonShellVm }): React.ReactElement | null {
  const { miniBarText, setMiniBarText, runFromMiniBarText, commands } = vm;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusOutsideMinibarRef = useRef<HTMLElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [echo, setEcho] = useState<ArchonMinibarEchoDetail | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const escSeqRef = useRef(0);

  const { id: typedId, rest, hasSpace } = useMemo(() => splitMiniBar(miniBarText), [miniBarText]);
  const typedIdNorm = typedId.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (hasSpace) return [];
    const eligible = commands.filter((c) => c.miniBar !== false);
    // No suggestions until the user types — avoids a permanent overlay above the bar that steals clicks.
    if (!typedIdNorm) {
      return [];
    }
    const starts = eligible.filter((c) => c.id.toLowerCase().startsWith(typedIdNorm));
    const contains = eligible.filter(
      (c) =>
        !c.id.toLowerCase().startsWith(typedIdNorm) &&
        (c.id.toLowerCase().includes(typedIdNorm) ||
          commandLabel(c).toLowerCase().includes(typedIdNorm)),
    );
    return [...starts, ...contains].slice(0, 12);
  }, [commands, hasSpace, typedIdNorm]);

  useEffect(() => {
    setErr(null);
    setEcho(null);
    setActiveIdx(0);
  }, []);

  useEffect(() => {
    const onEcho = (e: Event) => {
      const ce = e as CustomEvent<ArchonMinibarEchoDetail>;
      const d = ce.detail;
      if (!d || typeof d.text !== "string") return;
      setErr(null);
      setEcho({ text: d.text, kind: d.kind ?? "info" });
    };
    window.addEventListener(ARCHON_MINIBAR_OUTPUT_EVENT, onEcho);
    return () => window.removeEventListener(ARCHON_MINIBAR_OUTPUT_EVENT, onEcho);
  }, []);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, suggestions.length]);

  const showSuggestionPanel =
    inputFocused && !hasSpace && typedIdNorm.length > 0 && suggestions.length > 0;

  useEffect(() => {
    const onPointerDown = (e: MouseEvent | PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const t = e.target as Node | null;
      if (t && root.contains(t)) return;
      if (document.activeElement === inputRef.current) {
        inputRef.current?.blur();
        window.setTimeout(() => {
          const ae = document.activeElement;
          if (ae === document.body || ae === document.documentElement) {
            restoreFocusOutsideMinibar(lastFocusOutsideMinibarRef);
          }
        }, 0);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    const onFocusRequest = (e: Event) => {
      const ae = document.activeElement;
      if (ae instanceof HTMLElement) {
        const root = rootRef.current;
        if (!root || !root.contains(ae)) {
          lastFocusOutsideMinibarRef.current = ae;
        }
      }
      const detail = (e as CustomEvent<{ prefill?: string } | undefined>).detail;
      if (detail?.prefill != null) {
        setMiniBarText(String(detail.prefill));
      }
      setErr(null);
      setActiveIdx(0);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("archon-minibar-focus", onFocusRequest as EventListener);
    return () =>
      window.removeEventListener("archon-minibar-focus", onFocusRequest as EventListener);
  }, [setMiniBarText]);

  return (
    <div
      ref={rootRef}
      className="archon-minibar-host shrink-0 border-t border-border bg-background"
      onPointerDownCapture={(e) => {
        const root = rootRef.current;
        if (!root || !root.contains(e.target as Node)) return;
        const ae = document.activeElement;
        if (ae instanceof HTMLElement && !root.contains(ae)) {
          lastFocusOutsideMinibarRef.current = ae;
        }
      }}
    >
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <span className="shrink-0 border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
          M-x
        </span>
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            value={miniBarText}
            onChange={(e) => setMiniBarText(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => {
              setInputFocused(false);
              escSeqRef.current = 0;
            }}
            placeholder='commandId {args} — JSON {"x":1} or JS object { id: "me", chord: "ctrl+shift+x", commandId: "archon.shell.openMiniBar" }'
            className="w-full min-w-0 rounded-none border border-input bg-background px-2 py-2 text-[12px] font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(e) => {
              if (e.key !== "Escape") {
                escSeqRef.current = 0;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setErr(null);
                if (miniBarText.trim() !== "") {
                  escSeqRef.current = 0;
                  setMiniBarText("");
                  setActiveIdx(0);
                  setEcho(null);
                  return;
                }
                escSeqRef.current = 0;
                inputRef.current?.blur();
                restoreFocusOutsideMinibar(lastFocusOutsideMinibarRef);
                return;
              }
              if (showSuggestionPanel) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(suggestions.length - 1, i + 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(0, i - 1));
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const pick = suggestions[activeIdx] ?? suggestions[0];
                  if (pick) setMiniBarText(`${pick.id} `);
                  return;
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                setErr(null);
                setEcho(null);
                void (async () => {
                  try {
                    if (!hasSpace && rest.trim().length === 0) {
                      const pick = suggestions[activeIdx];
                      if (pick && pick.id.toLowerCase() !== typedIdNorm) {
                        setMiniBarText(`${pick.id} `);
                        return;
                      }
                    }
                    await runFromMiniBarText(miniBarText);
                  } catch (ex) {
                    setEcho(null);
                    setErr(ex instanceof Error ? ex.message : "Command failed");
                  }
                })();
              }
            }}
          />
          {showSuggestionPanel ? (
            <div
              className="absolute bottom-full mb-1 w-full overflow-hidden rounded-none border border-border bg-background shadow-lg"
              onMouseDown={(e) => e.preventDefault()}
            >
              <ul className="max-h-56 overflow-auto py-1">
                {suggestions.map((c, idx) => {
                  const active = idx === activeIdx;
                  return (
                    <li key={c.id}>
                      <button
                        ref={active ? activeItemRef : null}
                        type="button"
                        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] ${
                          active ? "bg-muted/60" : "hover:bg-muted/40"
                        }`}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onMouseDown={(ev) => {
                          // keep focus in input
                          ev.preventDefault();
                        }}
                        onClick={() => setMiniBarText(`${c.id} `)}
                      >
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.id}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {commandLabel(c)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
                <span className="font-mono">↑</span>/<span className="font-mono">↓</span> to select,{" "}
                <span className="font-mono">Tab</span> to complete
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {echo ? (
        <pre
          className={`max-h-40 w-full overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 font-mono text-[11px] leading-snug ${
            echo.kind === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-foreground"
          }`}
          role="status"
        >
          {echo.text}
        </pre>
      ) : null}
      {err ? (
        <div className="w-full border-t border-border px-3 pb-2 pt-2 text-[11px] text-red-600 dark:text-red-400">
          {err}
        </div>
      ) : null}
    </div>
  );
}

