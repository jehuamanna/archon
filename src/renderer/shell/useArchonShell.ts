import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandContribution } from "./archon-contribution-registry";
import { useArchonCommands, useArchonContributionRegistry } from "./ArchonContributionContext";
import { useShellRegistries } from "./registries/ShellRegistriesContext";
import { chordFromEvent } from "./registries/ShellKeymapRegistry";
import { registerSystemPaletteCommands } from "./system-plugins/registerSystemPaletteCommands";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function commandLabel(c: CommandContribution): string {
  const cat = c.category?.trim();
  return cat ? `${cat}: ${c.title}` : c.title;
}

function fuzzyScore(haystack: string, needle: string): number | null {
  const h = haystack;
  const n = needle;
  if (!n) return 0;
  if (h.includes(n)) {
    // Substring match: strong signal. Prefer earlier + tighter.
    const at = h.indexOf(n);
    return 200 - Math.min(150, at) - Math.min(50, h.length - n.length);
  }
  // Subsequence fuzzy match: walk haystack, reward consecutive chars.
  let hi = 0;
  let score = 0;
  let run = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni]!;
    let found = false;
    while (hi < h.length) {
      const hh = h[hi]!;
      hi += 1;
      if (hh === ch) {
        found = true;
        run += 1;
        score += 5 + Math.min(10, run * 2);
        break;
      }
      run = 0;
    }
    if (!found) return null;
  }
  // Prefer matches that start earlier.
  score -= Math.min(80, hi);
  return score;
}

/**
 * Minibuffer args: strict JSON first, then a single JS object literal `{ a: 1, b: 'x' }`
 * (same as pasting into DevTools) for convenience.
 */
function parseMinibarArgs(rest: string): Record<string, unknown> {
  const t = rest.trim();
  if (!t) {
    throw new Error("Missing args object after command id.");
  }
  try {
    const parsed = JSON.parse(t) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Args must be a plain object.");
    }
    return parsed as Record<string, unknown>;
  } catch (jsonErr) {
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const fn = new Function(`"use strict"; return (${t});`);
        const v = fn() as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          return v as Record<string, unknown>;
        }
        throw new Error("Args must be a plain object.");
      } catch {
        /* fall through */
      }
    }
    throw new Error(
      jsonErr instanceof Error
        ? `Invalid args. Use JSON with double quotes, e.g. {"id":"x"}, or a JS object { id: 'x' }. ${jsonErr.message}`
        : "Invalid args.",
    );
  }
}

function scoreCommand(c: CommandContribution, q: string): number | null {
  if (!q) return 0;
  const id = norm(c.id);
  const label = norm(commandLabel(c));
  const doc = norm(c.doc ?? "");
  const parts = q.split(/\s+/).filter(Boolean);

  let total = 0;
  for (const p of parts) {
    // High boosts for exact/prefix/word-ish matches in id/label.
    if (id === p) {
      total += 1000;
      continue;
    }
    if (id.startsWith(p)) {
      total += 700;
      continue;
    }
    if (label.startsWith(p)) {
      total += 520;
      continue;
    }
    const wordRe = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
    if (wordRe.test(c.id) || wordRe.test(commandLabel(c))) {
      total += 380;
      continue;
    }

    // Fuzzy match across concatenated fields; require a match.
    const hay = `${id} ${label} ${doc}`;
    const s = fuzzyScore(hay, p);
    if (s == null) return null;
    total += s;
  }
  return total;
}

export type ShellSurface = "palette" | "miniBar";

export type ArchonShellVm = {
  open: boolean;
  surface: ShellSurface;
  query: string;
  setQuery: (v: string) => void;
  commands: CommandContribution[];
  results: CommandContribution[];
  selectedIndex: number;
  setSelectedIndex: (n: number) => void;
  close: () => void;
  openPalette: () => void;
  openMiniBar: (prefill?: string) => void;
  runSelected: () => Promise<void>;
  runFromMiniBarText: (text: string) => Promise<void>;
  miniBarText: string;
  setMiniBarText: (v: string) => void;
};

/**
 * Emacs-ish shell VM (pure state + registry invocation).
 * - Palette: fuzzy filter of registered commands.
 * - Mini bar: accepts `commandId {jsonArgs}` or just `commandId`.
 */
export function useArchonShell(): ArchonShellVm {
  const registry = useArchonContributionRegistry();
  const shellRegs = useShellRegistries();
  const commands = useArchonCommands().filter((c) => c.palette !== false || c.miniBar !== false);
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<ShellSurface>("palette");
  const [query, setQuery] = useState("");
  const [miniBarText, setMiniBarText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lastOpenAtRef = useRef<number>(0);

  const results = useMemo(() => {
    const q = norm(query);
    const eligible = commands.filter((c) => {
      if (surface === "palette") return c.palette !== false;
      return c.miniBar !== false;
    });
    if (!q) {
      return eligible.slice().sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
    }
    return eligible
      .map((c) => ({ c, s: scoreCommand(c, q) }))
      .filter((x): x is { c: CommandContribution; s: number } => typeof x.s === "number")
      .sort((a, b) => b.s - a.s || commandLabel(a.c).localeCompare(commandLabel(b.c)))
      .map((x) => x.c);
  }, [commands, query, surface]);

  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndex]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const openPalette = useCallback(() => {
    setSurface("palette");
    setOpen(true);
    setQuery("");
    setSelectedIndex(0);
    lastOpenAtRef.current = Date.now();
  }, []);

  const openMiniBar = useCallback((prefill?: string) => {
    // Minibuffer is always visible; do not set open=true or shortcuts stop working.
    setMiniBarText(prefill ?? "");
    lastOpenAtRef.current = Date.now();
  }, []);

  const runCommand = useCallback(
    async (id: string, args?: Record<string, unknown>) => {
      const r = registry.invokeCommand(id, args);
      await Promise.resolve(r);
    },
    [registry],
  );

  const runSelected = useCallback(async () => {
    const cmd = results[selectedIndex];
    if (!cmd) return;
    if (cmd.doc?.includes("args:")) {
      openMiniBar(`${cmd.id} `);
      return;
    }
    close();
    await runCommand(cmd.id);
  }, [close, openMiniBar, results, runCommand, selectedIndex]);

  const runFromMiniBarText = useCallback(
    async (text: string) => {
      const raw = text.trim();
      if (!raw) return;
      const space = raw.indexOf(" ");
      const id = (space >= 0 ? raw.slice(0, space) : raw).trim();
      const rest = space >= 0 ? raw.slice(space + 1).trim() : "";
      let args: Record<string, unknown> | undefined;
      if (rest) {
        args = parseMinibarArgs(rest);
      }
      await runCommand(id, args);
    },
    [runCommand],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isInput = (e.target as HTMLElement | null)?.closest(
        "input, textarea, [contenteditable=true]",
      );
      const chord = chordFromEvent(e);
      const b = shellRegs.keymap.match(chord);
      if (b) {
        const block = b.ignoreWhenInput === true && Boolean(isInput);
        if (!block) {
          e.preventDefault();
          if (b.commandId === "archon.shell.openMiniBar") {
            try {
              window.dispatchEvent(
                new CustomEvent("archon-minibar-focus", {
                  detail: { prefill: String(b.commandArgs?.prefill ?? "") },
                }),
              );
            } catch {
              /* ignore */
            }
          }
          void Promise.resolve(registry.invokeCommand(b.commandId, b.commandArgs));
          return;
        }
      }

      if (!open) return;

      // avoid eating the open keystroke (sometimes keyup arrives late)
      if (Date.now() - lastOpenAtRef.current < 50) {
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (surface === "palette") {
        // If the palette input is focused, let the component handle navigation.
        // Otherwise Arrow/Enter will be handled twice (global + input handler).
        if (
          isInput &&
          (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")
        ) {
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => Math.min(results.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          void runSelected();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    close,
    open,
    openMiniBar,
    openPalette,
    registry,
    results.length,
    runSelected,
    shellRegs.keymap,
    surface,
  ]);

  // Key chords forwarded from sandboxed view iframes.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as unknown;
      if (!d || typeof d !== "object") return;
      const type = (d as { type?: unknown }).type;
      if (type !== "archon.shell.keys") return;
      const chord = (d as { chord?: unknown }).chord;
      if (typeof chord !== "string" || !chord.trim()) return;
      const b = shellRegs.keymap.match(chord);
      if (!b) return;
      // Mirror keyboard handler behavior: prevent default only happens inside the iframe.
      if (b.commandId === "archon.shell.openMiniBar") {
        try {
          window.dispatchEvent(
            new CustomEvent("archon-minibar-focus", {
              detail: { prefill: String(b.commandArgs?.prefill ?? "") },
            }),
          );
        } catch {
          /* ignore */
        }
      }
      void Promise.resolve(registry.invokeCommand(b.commandId, b.commandArgs));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [registry, shellRegs.keymap]);

  // System shell plugin: palette + mini buffer open commands.
  useEffect(() => {
    return registerSystemPaletteCommands(registry, { openPalette, openMiniBar });
  }, [openMiniBar, openPalette, registry]);

  return {
    open,
    surface,
    query,
    setQuery,
    commands,
    results,
    selectedIndex,
    setSelectedIndex,
    close,
    openPalette,
    openMiniBar,
    runSelected,
    runFromMiniBarText,
    miniBarText,
    setMiniBarText,
  };
}

