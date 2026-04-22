import type {
  CommandApiContract,
  CommandArgDefinition,
  CommandContribution,
  CommandReturnSpec,
} from "./archon-contribution-registry";

const GENERIC_ARGS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  description:
    "Optional invoke payload. This command does not declare per-field types; any JSON-serializable object may be accepted.",
  additionalProperties: true,
} as const;

const NO_ARGS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  description: "This command takes no arguments.",
  properties: {},
  additionalProperties: false,
} as const;

/** Split `a.b.c` → namespace `a.b`, shortName `c`. */
export function deriveCommandNamespace(commandId: string): { namespace: string; shortName: string } {
  const i = commandId.lastIndexOf(".");
  if (i <= 0) return { namespace: "(root)", shortName: commandId };
  return { namespace: commandId.slice(0, i), shortName: commandId.slice(i + 1) };
}

function jsonTypeForLabel(typeLabel: string): string {
  const t = typeLabel.trim().toLowerCase();
  if (t === "string" || t === "number" || t === "boolean" || t === "integer") return t;
  if (t === "object" || t === "array") return t;
  if (t === "any" || t === "unknown") return "string";
  return "string";
}

/** Build a small JSON Schema object from structured arg definitions. */
export function buildArgsJsonSchemaFromDefinitions(
  args: CommandArgDefinition[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of args) {
    const base: Record<string, unknown> = {
      description: a.description ?? "",
    };
    if (a.schema) {
      properties[a.name] = { ...base, ...a.schema };
    } else {
      base.type = jsonTypeForLabel(a.type);
      if (a.default !== undefined) base.default = a.default;
      if (a.example !== undefined) base.examples = [a.example];
      properties[a.name] = base;
    }
    if (a.required) required.push(a.name);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export type ResolvedCommandApiDoc = {
  commandId: string;
  namespace: string;
  shortName: string;
  summary: string;
  category?: string;
  sourcePluginId?: string | null;
  disambiguation?: string;
  palette: boolean;
  miniBar: boolean;
  proseDoc: string | null;
  /** Extra narrative from `api.details` only (not the same as `doc`). */
  apiDetails: string | null;
  args: CommandArgDefinition[] | undefined;
  argsJsonSchema: Record<string, unknown>;
  exampleInvoke: Record<string, unknown> | null | undefined;
  returns: CommandReturnSpec;
  rawApi?: CommandApiContract;
};

export function resolveCommandApiDoc(cmd: CommandContribution): ResolvedCommandApiDoc {
  const derived = deriveCommandNamespace(cmd.id);
  const api = cmd.api;
  const namespace = api?.namespace ?? derived.namespace;
  const shortName = api?.shortName ?? derived.shortName;
  const summary = api?.summary ?? cmd.title;
  const proseDoc = cmd.doc ?? null;
  const apiDetails = api?.details?.trim() ? api.details.trim() : null;

  const args = api?.args;
  let argsJsonSchema: Record<string, unknown>;
  if (api?.argsJsonSchema && typeof api.argsJsonSchema === "object") {
    argsJsonSchema = { ...api.argsJsonSchema };
  } else if (args !== undefined) {
    if (args.length === 0) {
      argsJsonSchema = { ...NO_ARGS_SCHEMA };
    } else {
      argsJsonSchema = buildArgsJsonSchemaFromDefinitions(args);
    }
  } else {
    argsJsonSchema = { ...GENERIC_ARGS_SCHEMA };
  }

  const returns: CommandReturnSpec = api?.returns ?? {
    type: "void | Promise<void>",
    description:
      "Handlers run in the renderer; async commands return a Promise. Errors may surface via UI or console.",
  };

  return {
    commandId: cmd.id,
    namespace,
    shortName,
    summary,
    category: cmd.category,
    sourcePluginId: cmd.sourcePluginId,
    disambiguation: cmd.disambiguation,
    palette: cmd.palette !== false,
    miniBar: cmd.miniBar !== false,
    proseDoc,
    apiDetails,
    args: args !== undefined ? args : undefined,
    argsJsonSchema,
    exampleInvoke: api?.exampleInvoke,
    returns,
    rawApi: api,
  };
}
