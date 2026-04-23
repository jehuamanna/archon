/**
 * MDX expression sandbox.
 *
 * Inline `{...}` expressions inside MDX are evaluated with a strict allow-list
 * of globals — no `window`, `document`, `fetch`, `eval`, `Function`, `globalThis`
 * (see decisions R3-Qg + R4-Qa). The MDX compiler emits expression code into
 * ordinary JS; at module-execution time we replace the global object the
 * expression code sees with a frozen endowments record.
 *
 * Implementation uses `new Function(...names, body)` with only the allow-list
 * names in scope. `this` is bound to `undefined` via strict mode (MDX
 * compile output is ESM).
 */

export interface SandboxEndowments {
  Math: typeof Math;
  Date: typeof Date;
  JSON: typeof JSON;
  Array: typeof Array;
  Object: typeof Object;
  String: typeof String;
  Number: typeof Number;
  Boolean: typeof Boolean;
}

export function defaultEndowments(): SandboxEndowments {
  return Object.freeze({
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
  });
}

/**
 * Evaluate a compiled MDX module source under the endowments.
 * Returns the default export (the React component).
 */
export function evaluateMdxModule(
  compiledJs: string,
  reactRuntime: { jsx: unknown; jsxs: unknown; Fragment: unknown },
  sdkRuntime: Record<string, unknown>,
  endowments: SandboxEndowments = defaultEndowments(),
): { default: unknown } {
  // Build the factory: module sees only the allow-list + injected runtimes.
  const globalNames = [
    "Math",
    "Date",
    "JSON",
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
  ] as const;

  // MDX v3 emits `export default function MDXContent(...) {...}` alongside named
  // helpers. We shim ESM by replacing `export default` with an assignment.
  const wrapped = rewriteEsmToCjs(compiledJs);

  const module: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    "module",
    "exports",
    "sdk",
    "reactRuntime",
    ...globalNames,
    `"use strict";\n${wrapped}\n//# sourceURL=archon-mdx-module`,
  );
  factory(
    module,
    module.exports,
    sdkRuntime,
    reactRuntime,
    ...globalNames.map((name) => endowments[name as keyof SandboxEndowments]),
  );
  return module.exports as { default: unknown };
}

/**
 * Minimal ESM-to-CJS rewriter for MDX compile output.
 *
 * MDX v3 emits code shaped like:
 *   import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
 *   import { Button } from "@archon/mdx-sdk";
 *   export default function MDXContent(props) { ... }
 *
 * We rewrite imports to pull from `sdk` / `reactRuntime` and `export default`
 * to a CJS assignment.
 */
function rewriteEsmToCjs(src: string): string {
  let out = src;
  // react/jsx-runtime — always resolved via the host-provided reactRuntime.
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']react\/jsx-runtime["'];?/g,
    (_m, names: string) => rewriteImportList(names, "reactRuntime"),
  );
  // react (components module).
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']react["'];?/g,
    (_m, names: string) => rewriteImportList(names, "reactRuntime"),
  );
  // @archon/mdx-sdk — the authoring SDK (components + hooks).
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']@archon\/mdx-sdk["'];?/g,
    (_m, names: string) => rewriteImportList(names, "sdk"),
  );
  // Any other import = sandbox escape attempt.
  if (/^\s*import\s+/m.test(out)) {
    throw new Error(
      "MDX sandbox: only @archon/mdx-sdk and react/jsx-runtime imports are permitted",
    );
  }
  out = out.replace(/export\s+default\s+/g, "module.exports.default = ");
  out = out.replace(/export\s*\{\s*([^}]+)\s*\};?/g, (_m, names: string) => {
    return names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => `module.exports.${n} = ${n};`)
      .join("\n");
  });
  return out;
}

function rewriteImportList(names: string, source: string): string {
  return names
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (!m) throw new Error(`MDX sandbox: cannot parse import "${entry}"`);
      const imported = m[1];
      const local = m[2] ?? m[1];
      return `const ${local} = ${source}.${imported};`;
    })
    .join("\n");
}
