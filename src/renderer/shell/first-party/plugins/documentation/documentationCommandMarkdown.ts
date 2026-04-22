import type { ResolvedCommandApiDoc } from "../../../command-api-metadata";
import type { CommandArgDefinition } from "../../../archon-contribution-registry";

/** Escape cell content for GFM pipes tables (literal `|` and newlines). */
function cellSafe(s: string): string {
  return String(s || "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Normalize free prose; keeps Markdown emphasis intact for the real renderer. */
function proseBlock(s: string): string {
  return String(s || "").replace(/\r\n/g, "\n").trim();
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map((h) => cellSafe(h)).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${r.map((c) => cellSafe(c)).join(" | ")} |`)
    .join("\n");
  return [head, sep, body].join("\n");
}

function fenced(lang: string, body: string): string {
  const trimmed = body.replace(/\n+$/, "");
  return "```" + lang + "\n" + trimmed + "\n```";
}

function exampleArgsObject(doc: ResolvedCommandApiDoc): Record<string, unknown> {
  if (doc.exampleInvoke === null) {
    return {};
  }
  if (doc.exampleInvoke && typeof doc.exampleInvoke === "object") {
    return { ...doc.exampleInvoke };
  }
  if (doc.args && doc.args.length > 0) {
    const o: Record<string, unknown> = {};
    for (const a of doc.args) {
      if (a.example !== undefined) {
        o[a.name] = a.example as unknown;
      } else if (a.default !== undefined) {
        o[a.name] = a.default as unknown;
      }
    }
    return o;
  }
  return {};
}

function argsTableRows(args: CommandArgDefinition[]): string[][] {
  return args.map((a) => {
    let def = "—";
    if (a.default !== undefined) {
      try {
        def = JSON.stringify(a.default);
      } catch {
        def = String(a.default);
      }
    }
    return [
      a.name,
      a.type,
      a.required ? "yes" : "no",
      a.description?.trim() || "—",
      def,
    ];
  });
}

/**
 * Build markdown for the Documentation hub command detail view (rendered via MarkdownRenderer).
 */
export function resolvedCommandDocToMarkdown(doc: ResolvedCommandApiDoc): string {
  const lines: string[] = [];

  lines.push(`# ${cellSafe(doc.commandId)}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(proseBlock(doc.summary));
  lines.push("");

  if (doc.category) {
    lines.push("## Category");
    lines.push("");
    lines.push(proseBlock(doc.category));
    lines.push("");
  }

  lines.push("## Namespace");
  lines.push("");
  lines.push(
    mdTable(["Field", "Value"], [
      ["Namespace", doc.namespace],
      ["Short name", doc.shortName],
      ["Fully qualified id", doc.commandId],
    ]),
  );
  lines.push("");

  lines.push("## Discovery");
  lines.push("");
  const discoveryRows: string[][] = [
    ["palette", doc.palette ? "true" : "false"],
    ["miniBar", doc.miniBar ? "true" : "false"],
  ];
  if (doc.sourcePluginId) {
    discoveryRows.push(["sourcePluginId", String(doc.sourcePluginId)]);
  }
  if (doc.disambiguation) {
    discoveryRows.push(["disambiguation", doc.disambiguation]);
  }
  lines.push(mdTable(["Key", "Value"], discoveryRows));
  lines.push("");

  if (doc.apiDetails) {
    lines.push("## Extended description");
    lines.push("");
    lines.push(proseBlock(doc.apiDetails));
    lines.push("");
  }

  if (doc.proseDoc) {
    lines.push("## Documentation");
    lines.push("");
    lines.push(proseBlock(doc.proseDoc));
    lines.push("");
  }

  lines.push("## Arguments");
  lines.push("");
  if (doc.args && doc.args.length === 0) {
    lines.push(
      "This command declares **no arguments**. Pass `{}` or omit the args parameter when invoking.",
    );
    lines.push("");
    lines.push("### Shell (React / registry)");
    lines.push("");
    lines.push(
      "Use `invokeCommand` from `useShellNavigation()` (or `ArchonContributionRegistry.invokeCommand`):",
    );
    lines.push("");
    lines.push(
      fenced(
        "ts",
        `void invokeCommand(${JSON.stringify(doc.commandId)}, {});`,
      ),
    );
    lines.push("");
    lines.push("### DevTools");
    lines.push("");
    lines.push("When the shell devtools API is exposed:");
    lines.push("");
    lines.push(
      fenced(
        "js",
        `await window.archon?.shell?.commands?.invoke(${JSON.stringify(doc.commandId)}, {});`,
      ),
    );
  } else if (doc.args && doc.args.length > 0) {
    lines.push(
      "The handler receives these fields on the **args** object (second parameter to `invokeCommand`, or minibuffer JSON):",
    );
    lines.push("");
    lines.push(
      mdTable(
        ["Field", "Type", "Required", "Description", "Default"],
        argsTableRows(doc.args),
      ),
    );
  } else {
    lines.push(
      "No per-field contract is registered; the handler still receives an optional record of string keys when invoked programmatically.",
    );
  }
  lines.push("");

  lines.push("## Example invoke");
  lines.push("");
  const argsPayload = exampleArgsObject(doc);
  const invokeExample =
    doc.exampleInvoke === null
      ? { commandId: doc.commandId, args: null }
      : { commandId: doc.commandId, args: argsPayload };
  lines.push(fenced("json", JSON.stringify(invokeExample, null, 2)));
  lines.push("");
  if (doc.args && doc.args.length > 0) {
    lines.push("### TypeScript");
    lines.push("");
    lines.push(
      fenced(
        "ts",
        `void invokeCommand(${JSON.stringify(doc.commandId)}, ${JSON.stringify(argsPayload, null, 2)});`,
      ),
    );
  }

  lines.push("");
  lines.push("## Return type");
  lines.push("");
  lines.push(
    mdTable(["Type", "Description"], [
      [
        doc.returns.type,
        doc.returns.description ? proseBlock(doc.returns.description) : "—",
      ],
    ]),
  );

  return lines.join("\n");
}
