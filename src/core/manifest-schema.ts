/**
 * JSON Schema (draft-07) subset for Archon plugin manifest.json (Epic 1.4).
 * Validated with Ajv in manifest-validator.
 */
export const MANIFEST_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["name", "version", "type", "main", "mode"],
  additionalProperties: true,
  properties: {
    name: { type: "string", minLength: 1 },
    version: { type: "string" },
    type: { type: "string", enum: ["ui", "backend", "hybrid"] },
    main: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["development", "production"] },
    displayName: { type: "string" },
    description: { type: "string" },
    author: { type: "string" },
    license: { type: "string" },
    ui: { type: "string" },
    html: { type: "string" },
    rootId: { type: "string" },
    icon: { type: "string" },
    noteTypes: { type: "array", items: { type: "string" } },
    permissions: { type: "array", items: { type: "string" } },
    activationEvents: { type: "array", items: { type: "string" } },
    engines: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    dependencies: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    devDependencies: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    assets: { type: "array", items: { type: "string" } },
    workers: { type: "array", items: { type: "string", minLength: 1 } },
    network: {
      type: "object",
      properties: {
        whitelist: { type: "array", items: { type: "string" } },
        requestApproval: { type: "boolean" },
        rateLimit: {
          type: "object",
          properties: {
            requestsPerMinute: { type: "number" },
            requestsPerHour: { type: "number" },
          },
        },
      },
    },
    theme: { type: "string", enum: ["inherit", "isolated"] },
    designSystemVersion: { type: "string" },
    hostTier: {
      type: "string",
      enum: ["system", "core", "user"],
    },
  },
} as const;
