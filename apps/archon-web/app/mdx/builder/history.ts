import type { BuilderDoc } from "./ast.js";

const MAX_HISTORY = 100;

export interface History {
  past: BuilderDoc[];
  future: BuilderDoc[];
}

export function newHistory(): History {
  return { past: [], future: [] };
}

export function pushState(history: History, state: BuilderDoc): History {
  const past = [...history.past, state];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, future: [] };
}

export function undo(
  history: History,
  current: BuilderDoc,
): { history: History; restored: BuilderDoc } | null {
  if (history.past.length === 0) return null;
  const prev = history.past[history.past.length - 1];
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
    },
    restored: prev,
  };
}

export function redo(
  history: History,
  current: BuilderDoc,
): { history: History; restored: BuilderDoc } | null {
  if (history.future.length === 0) return null;
  const next = history.future[history.future.length - 1];
  return {
    history: {
      past: [...history.past, current],
      future: history.future.slice(0, -1),
    },
    restored: next,
  };
}
