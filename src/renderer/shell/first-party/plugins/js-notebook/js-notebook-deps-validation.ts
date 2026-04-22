import { Library } from "@observablehq/stdlib";
import type { NormalizedNotebookCell } from "./js-notebook-types";

let stdlibBuiltinNames: Set<string> | null = null;

function getStdlibBuiltinNames(): Set<string> {
  if (!stdlibBuiltinNames) {
    const lib = new Library();
    stdlibBuiltinNames = new Set(Object.keys(lib as Record<string, unknown>));
  }
  return stdlibBuiltinNames;
}

/** Injected in run; users may list it explicitly. */
const RUNTIME_INJECTED_DEPS = new Set(["archon", "__nb_global"]);

function isAmbientGlobalDep(dep: string): boolean {
  if (typeof globalThis === "undefined") return false;
  try {
    return dep in globalThis && (globalThis as Record<string, unknown>)[dep] !== undefined;
  } catch {
    return false;
  }
}

/**
 * Returns a user-facing error if any JS cell lists a dependency that cannot
 * resolve (not another JS cell name, not an @observablehq/stdlib builtin, etc.).
 */
export function validateNotebookJsDependencies(cells: NormalizedNotebookCell[]): string | null {
  const jsCells = cells.filter((c) => c.kind === "js");
  const jsNames = new Set(jsCells.map((c) => c.name));
  const builtins = getStdlibBuiltinNames();

  for (const c of jsCells) {
    for (const dep of c.inputs) {
      if (!dep) continue;
      if (dep === c.name) {
        return `Cell "${c.name}" cannot list itself as a dependency. Remove "${dep}" from deps.`;
      }
      if (jsNames.has(dep)) continue;
      if (builtins.has(dep) || RUNTIME_INJECTED_DEPS.has(dep)) continue;
      if (isAmbientGlobalDep(dep)) continue;
      return `Unknown dependency "${dep}" for cell "${c.name}". Deps must be names of other JS cells in this note (comma-separated), or @observablehq/stdlib builtins (e.g. d3, Plot). Leave deps empty if you only need literals or archon.`;
    }
  }
  return null;
}
