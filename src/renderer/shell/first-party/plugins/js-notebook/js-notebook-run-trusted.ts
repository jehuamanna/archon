import DOMPurify from "dompurify";
import { Inspector } from "@observablehq/inspector";
import { Runtime } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";
import { createNotebookCellGlobalThisProxy } from "./js-notebook-cell-globals";
import type { NormalizedNotebookCell } from "./js-notebook-types";

function isHtmlPayload(value: unknown): value is { html: string } {
  return (
    !!value &&
    typeof value === "object" &&
    "html" in value &&
    typeof (value as { html: unknown }).html === "string"
  );
}

/** `module.variable()` needs an observer object; `Inspector.into()` returns a factory for `runtime.module(define, factory)` only. */
function wrapInspectorForHtml(slot: HTMLElement, inspector: InstanceType<typeof Inspector>) {
  return {
    pending() {
      inspector.pending();
    },
    fulfilled(value: unknown, name?: string) {
      if (isHtmlPayload(value)) {
        while (slot.firstChild) slot.removeChild(slot.firstChild);
        const wrap = document.createElement("div");
        wrap.className = "archon-notebook-html";
        wrap.innerHTML = DOMPurify.sanitize(value.html);
        slot.appendChild(wrap);
        return;
      }
      return inspector.fulfilled(value, name);
    },
    rejected(error: unknown, name?: string) {
      return inspector.rejected(error, name);
    },
  };
}

export type TrustedRunMeta = {
  runId: number;
  startedAt: number;
};

export function runJsNotebookTrusted(opts: {
  cells: NormalizedNotebookCell[];
  /** Mount each cell's inspector here; use a detached element if no UI slot (e.g. dependency-only). */
  getOutputSlot: (cellId: string) => HTMLElement | null;
  archonFactory: () => unknown;
  signal?: AbortSignal;
  meta: TrustedRunMeta;
  onCellFinished?: (cellId: string, ms: number, errorMessage?: string) => void;
}): { dispose: () => void } {
  const { cells, getOutputSlot, archonFactory, signal, meta, onCellFinished } = opts;

  const lib = new Library();
  const cellGlobalThis = createNotebookCellGlobalThisProxy();
  const builtins: Record<string, unknown> = {
    ...lib,
    archon: archonFactory,
    /** Shadowed into each cell so `globalThis`/`window` omit `document` (see cell wrapper). */
    __nb_global: cellGlobalThis,
  };
  const runtime = new Runtime(builtins as never);
  const mod = runtime.module();

  for (const c of cells) {
    if (c.kind === "md") continue;

    const root = getOutputSlot(c.id);
    const block = document.createElement("div");
    block.dataset.cellId = c.id;
    block.className = "archon-notebook-cell-out";
    const errSlot = document.createElement("div");
    errSlot.className = "archon-notebook-cell-error mb-1 hidden text-[11px] text-destructive";
    const slot = document.createElement("div");
    block.appendChild(errSlot);
    block.appendChild(slot);
    if (root) {
      root.innerHTML = "";
      root.appendChild(block);
    }

    const inspector = Inspector.into(slot)();
    const wrappedObserver = wrapInspectorForHtml(slot, inspector);

    const t0 = performance.now();
    mod.variable(wrappedObserver).define(
      c.name,
      [...c.inputs, "archon", "__nb_global"],
      (...args: unknown[]) => {
        if (signal?.aborted) {
          const e = new DOMException("Aborted", "AbortError");
          onCellFinished?.(c.id, performance.now() - t0, e.message);
          throw e;
        }
        const nbGlobalVal = args[args.length - 1];
        const archonVal = args[args.length - 2];
        const inArgs = args.slice(0, -2);
        let fn: (...a: unknown[]) => unknown;
        const returnExpr = c.body.trim() === "" ? "undefined" : c.body;
        try {
          fn = new Function(
            ...c.inputs,
            "archon",
            "__nb_global",
            `"use strict"; return (async () => { const globalThis = __nb_global; const window = __nb_global; return (${returnExpr}); })();`,
          ) as (...a: unknown[]) => unknown;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errSlot.textContent = msg;
          errSlot.classList.remove("hidden");
          onCellFinished?.(c.id, performance.now() - t0, msg);
          throw e;
        }
        return Promise.resolve()
          .then(() => fn(...inArgs, archonVal, nbGlobalVal))
          .then(
            (v) => {
              onCellFinished?.(c.id, performance.now() - t0);
              return v;
            },
            (e: unknown) => {
              const msg = e instanceof Error ? e.message : String(e);
              errSlot.textContent = msg;
              errSlot.classList.remove("hidden");
              onCellFinished?.(c.id, performance.now() - t0, msg);
              throw e;
            },
          );
      },
    );
  }

  return {
    dispose: () => {
      try {
        runtime.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}
