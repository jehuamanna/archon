import type {
  PluginHostTier,
  PluginMode,
  PluginType,
  Permission,
} from "./plugin-loader";
import type { ValidationError } from "./manifest-validator-types";

export function manifestValidateRequired(
  manifest: any,
  errors: ValidationError[],
): void {
  const requiredFields = ["name", "version", "type", "main", "mode"];

  for (const field of requiredFields) {
    if (!manifest[field]) {
      errors.push({
        field,
        message: `Required field '${field}' is missing`,
        severity: "error",
      });
    }
  }
}

export function manifestValidateTypes(
  manifest: any,
  errors: ValidationError[],
): void {
  const stringFields = [
    "name",
    "version",
    "type",
    "main",
    "mode",
    "displayName",
    "description",
    "author",
    "license",
    "ui",
    "html",
    "rootId",
    "icon",
  ];

  for (const field of stringFields) {
    if (
      manifest[field] !== undefined &&
      typeof manifest[field] !== "string"
    ) {
      errors.push({
        field,
        message: `Field '${field}' must be a string`,
        severity: "error",
      });
    }
  }

  if (
    manifest.noteTypes !== undefined &&
    !Array.isArray(manifest.noteTypes)
  ) {
    errors.push({
      field: "noteTypes",
      message: "Field 'noteTypes' must be an array",
      severity: "error",
    });
  }

  if (
    manifest.permissions !== undefined &&
    !Array.isArray(manifest.permissions)
  ) {
    errors.push({
      field: "permissions",
      message: "Field 'permissions' must be an array",
      severity: "error",
    });
  }

  if (
    manifest.activationEvents !== undefined &&
    !Array.isArray(manifest.activationEvents)
  ) {
    errors.push({
      field: "activationEvents",
      message: "Field 'activationEvents' must be an array",
      severity: "error",
    });
  }

  if (manifest.assets !== undefined && !Array.isArray(manifest.assets)) {
    errors.push({
      field: "assets",
      message: "Field 'assets' must be an array",
      severity: "error",
    });
  }

  if (manifest.workers !== undefined && !Array.isArray(manifest.workers)) {
    errors.push({
      field: "workers",
      message: "Field 'workers' must be an array of file paths",
      severity: "error",
    });
  }

  if (
    manifest.engines !== undefined &&
    typeof manifest.engines !== "object"
  ) {
    errors.push({
      field: "engines",
      message: "Field 'engines' must be an object",
      severity: "error",
    });
  }

  if (
    manifest.dependencies !== undefined &&
    typeof manifest.dependencies !== "object"
  ) {
    errors.push({
      field: "dependencies",
      message: "Field 'dependencies' must be an object",
      severity: "error",
    });
  }

  if (
    manifest.devDependencies !== undefined &&
    typeof manifest.devDependencies !== "object"
  ) {
    errors.push({
      field: "devDependencies",
      message: "Field 'devDependencies' must be an object",
      severity: "error",
    });
  }

  if (
    manifest.network !== undefined &&
    typeof manifest.network !== "object"
  ) {
    errors.push({
      field: "network",
      message: "Field 'network' must be an object",
      severity: "error",
    });
  }
}

export function manifestValidateValues(
  manifest: any,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (manifest.name && !/^[a-z0-9-]+$/.test(manifest.name)) {
    errors.push({
      field: "name",
      message: "Plugin name must be lowercase alphanumeric with hyphens only",
      severity: "error",
    });
  }

  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    errors.push({
      field: "version",
      message: "Version must follow semantic versioning (e.g., 1.0.0)",
      severity: "error",
    });
  }

  const validHostTiers: PluginHostTier[] = ["system", "core", "user"];
  if (
    manifest.hostTier !== undefined &&
    !validHostTiers.includes(manifest.hostTier)
  ) {
    errors.push({
      field: "hostTier",
      message: `hostTier must be one of: ${validHostTiers.join(", ")}`,
      severity: "error",
    });
  }

  const validTypes: PluginType[] = ["ui", "backend", "hybrid"];
  if (manifest.type && !validTypes.includes(manifest.type)) {
    errors.push({
      field: "type",
      message: `Plugin type must be one of: ${validTypes.join(", ")}`,
      severity: "error",
    });
  }

  const validModes: PluginMode[] = ["development", "production"];
  if (manifest.mode && !validModes.includes(manifest.mode)) {
    errors.push({
      field: "mode",
      message: `Plugin mode must be one of: ${validModes.join(", ")}`,
      severity: "error",
    });
  }

  const validPermissions: Permission[] = [
    "storage.read",
    "storage.write",
    "db.read",
    "db.write",
    "fs.read",
    "fs.write",
    "network.http",
    "ui.panel",
    "ui.toolbar",
  ];

  if (manifest.permissions && Array.isArray(manifest.permissions)) {
    for (const permission of manifest.permissions) {
      if (!validPermissions.includes(permission)) {
        errors.push({
          field: "permissions",
          message: `Invalid permission: ${permission}. Valid permissions: ${validPermissions.join(", ")}`,
          severity: "error",
        });
      }
    }
  }

  if (manifest.main) {
    if (
      manifest.mode === "development" &&
      !manifest.main.endsWith(".js") &&
      !manifest.main.endsWith(".ts")
    ) {
      warnings.push({
        field: "main",
        message: "Development mode backend should use .js or .ts extension",
        severity: "warning",
      });
    }
    if (
      manifest.mode === "production" &&
      !manifest.main.endsWith(".bundle.js")
    ) {
      warnings.push({
        field: "main",
        message: "Production mode backend should use .bundle.js extension",
        severity: "warning",
      });
    }
  }

  if (manifest.ui) {
    if (
      manifest.mode === "development" &&
      !manifest.ui.endsWith(".jsx") &&
      !manifest.ui.endsWith(".tsx")
    ) {
      warnings.push({
        field: "ui",
        message: "Development mode frontend should use .jsx or .tsx extension",
        severity: "warning",
      });
    }
    if (
      manifest.mode === "production" &&
      !manifest.ui.endsWith(".bundle.js")
    ) {
      warnings.push({
        field: "ui",
        message: "Production mode frontend should use .bundle.js extension",
        severity: "warning",
      });
    }
  }

  if (manifest.mode === "production") {
    if (manifest.dependencies) {
      warnings.push({
        field: "dependencies",
        message:
          "Production mode should not have dependencies (they should be bundled)",
        severity: "warning",
      });
    }
    if (manifest.devDependencies) {
      warnings.push({
        field: "devDependencies",
        message: "Production mode should not have devDependencies",
        severity: "warning",
      });
    }
  }

  if (manifest.network) {
    if (
      manifest.network.whitelist &&
      !Array.isArray(manifest.network.whitelist)
    ) {
      errors.push({
        field: "network.whitelist",
        message: "Network whitelist must be an array of URLs",
        severity: "error",
      });
    }

    if (
      manifest.network.requestApproval !== undefined &&
      typeof manifest.network.requestApproval !== "boolean"
    ) {
      errors.push({
        field: "network.requestApproval",
        message: "Network requestApproval must be a boolean",
        severity: "error",
      });
    }

    if (manifest.network.rateLimit) {
      if (
        manifest.network.rateLimit.requestsPerMinute !== undefined &&
        typeof manifest.network.rateLimit.requestsPerMinute !== "number"
      ) {
        errors.push({
          field: "network.rateLimit.requestsPerMinute",
          message: "Rate limit requestsPerMinute must be a number",
          severity: "error",
        });
      }

      if (
        manifest.network.rateLimit.requestsPerHour !== undefined &&
        typeof manifest.network.rateLimit.requestsPerHour !== "number"
      ) {
        errors.push({
          field: "network.rateLimit.requestsPerHour",
          message: "Rate limit requestsPerHour must be a number",
          severity: "error",
        });
      }
    }
  }
}

export function manifestValidateCombinations(
  manifest: any,
  errors: ValidationError[],
): void {
  if (
    (manifest.type === "ui" || manifest.type === "hybrid") &&
    !manifest.ui
  ) {
    errors.push({
      field: "ui",
      message: "UI and hybrid plugins must specify a 'ui' field",
      severity: "error",
    });
  }

  if (manifest.html && manifest.rootId) {
    errors.push({
      field: "html",
      message: "Cannot specify both 'html' and 'rootId' - choose one",
      severity: "error",
    });
  }

  if (manifest.html && manifest.type === "backend") {
    errors.push({
      field: "html",
      message: "Backend plugins don't need an 'html' field",
      severity: "error",
    });
  }

  if (
    manifest.network &&
    (!manifest.permissions || !manifest.permissions.includes("network.http"))
  ) {
    errors.push({
      field: "network",
      message: "Network configuration requires 'network.http' permission",
      severity: "error",
    });
  }
}
