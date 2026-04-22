import Ajv, { type ValidateFunction } from "ajv";
import type { PluginManifest } from "./plugin-loader";
import { inferPluginTypeFromDisk } from "./manifest-infer-type";
import { MANIFEST_JSON_SCHEMA } from "./manifest-schema";
import {
  manifestValidateCombinations,
  manifestValidateRequired,
  manifestValidateTypes,
  manifestValidateValues,
} from "./manifest-validator-rules";
import type { ValidationError, ValidationResult } from "./manifest-validator-types";

export type { ValidationError, ValidationResult } from "./manifest-validator-types";
export { inferPluginTypeFromDisk } from "./manifest-infer-type";

export class ManifestValidator {
  private readonly ajvValidate: ValidateFunction;

  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: false });
    this.ajvValidate = ajv.compile(MANIFEST_JSON_SCHEMA as object);
  }

  validateForLoad(manifest: any, pluginPath: string): ValidationResult {
    const base = this.validate(manifest);
    if (!base.valid) {
      return base;
    }
    const warnings = [...base.warnings];
    try {
      const inferred = inferPluginTypeFromDisk(
        pluginPath,
        manifest as PluginManifest,
      );
      if (manifest.type && inferred !== manifest.type) {
        warnings.push({
          field: "type",
          message: `Declared type "${manifest.type}" but project layout suggests "${inferred}". See sprints/PLUGIN_MIGRATION.md.`,
          severity: "warning",
        });
      }
    } catch (e) {
      warnings.push({
        field: "type",
        message: `Could not infer type from disk: ${e instanceof Error ? e.message : String(e)}`,
        severity: "warning",
      });
    }
    return { ...base, warnings };
  }

  validate(manifest: any): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    const schemaOk = this.ajvValidate(manifest);
    if (!schemaOk && this.ajvValidate.errors) {
      for (const err of this.ajvValidate.errors) {
        const field =
          err.instancePath && err.instancePath.length > 0
            ? err.instancePath.replace(/^\//, "").replace(/\//g, ".")
            : "manifest";
        errors.push({
          field,
          message: err.message ?? "JSON Schema validation failed",
          severity: "error",
        });
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    manifestValidateRequired(manifest, errors);
    manifestValidateTypes(manifest, errors);
    manifestValidateValues(manifest, errors, warnings);
    manifestValidateCombinations(manifest, errors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  formatErrors(result: ValidationResult): string {
    const lines: string[] = [];

    if (result.errors.length > 0) {
      lines.push("Validation Errors:");
      for (const error of result.errors) {
        lines.push(`  - [${error.field}] ${error.message}`);
      }
    }

    if (result.warnings.length > 0) {
      lines.push("\nValidation Warnings:");
      for (const warning of result.warnings) {
        lines.push(`  - [${warning.field}] ${warning.message}`);
      }
    }

    return lines.join("\n");
  }
}

export const manifestValidator = new ManifestValidator();
