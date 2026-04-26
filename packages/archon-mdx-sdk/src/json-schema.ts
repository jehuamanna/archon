/**
 * Derive a JSON Schema describing every Archon MDX component's props from
 * `PROP_SPECS`. Consumers (AI tools, builder UIs, validators) use this as a
 * single machine-readable contract — no need to reason about the TS types.
 */
import { PROP_SPECS, type PropSpec, type ComponentPropSpec } from "./prop-specs.js";
import { ALLOWED_FACADE_IMPORTS, STATE_KEY_RE } from "./validation.js";

interface JsonSchemaProperty {
  type?: "string" | "number" | "boolean";
  enum?: string[];
  pattern?: string;
  default?: unknown;
  description?: string;
  /** Custom marker — JSON Schema doesn't model "this string is a state-key reference". */
  "x-archon-kind"?: PropSpec["type"];
}

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

function propToJsonSchema(spec: PropSpec): JsonSchemaProperty {
  const out: JsonSchemaProperty = { "x-archon-kind": spec.type };
  if (spec.semantic) out.description = spec.semantic;
  if (spec.default !== undefined) out.default = spec.default;
  switch (spec.type) {
    case "string":
    case "stateKey":
    case "noteId":
      out.type = "string";
      if (spec.type === "stateKey") out.pattern = STATE_KEY_RE.source;
      break;
    case "number":
      out.type = "number";
      break;
    case "boolean":
      out.type = "boolean";
      break;
    case "enum":
      out.type = "string";
      if (spec.enum) out.enum = [...spec.enum];
      break;
  }
  return out;
}

function componentSpecToJsonSchema(spec: ComponentPropSpec): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const [name, prop] of Object.entries(spec)) {
    properties[name] = propToJsonSchema(prop);
    if (prop.required) required.push(name);
  }
  const out: JsonSchemaObject = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) out.required = required;
  return out;
}

export interface ArchonMdxSdkSpec {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $id: "https://archon.dev/mdx-sdk/v1/spec.json";
  sdkVersion: string;
  allowedImports: readonly string[];
  /** Per-component prop schema, keyed by tag name. */
  components: Record<string, JsonSchemaObject>;
}

export function buildMdxSdkJsonSchema(sdkVersion: string): ArchonMdxSdkSpec {
  const components: Record<string, JsonSchemaObject> = {};
  for (const [name, spec] of Object.entries(PROP_SPECS)) {
    components[name] = componentSpecToJsonSchema(spec);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://archon.dev/mdx-sdk/v1/spec.json",
    sdkVersion,
    allowedImports: ALLOWED_FACADE_IMPORTS,
    components,
  };
}
