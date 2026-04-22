export function isValidNoteId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 100;
}

export function isValidNoteType(type: unknown): type is string {
  return typeof type === 'string' && /^[a-z][a-z0-9-]*$/.test(type) && type.length < 50;
}

/** Prevent path traversal and invalid folder names for plugin IDs from IPC. */
export function isSafePluginName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 200 &&
    !/[\\/]/.test(name) &&
    !name.includes("..") &&
    name !== "." &&
    name !== ".."
  );
}

/** Relative path inside a plugin folder (no traversal). */
export function isSafeRelativePluginSourcePath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 500) {
    return false;
  }
  if (rel.includes("..") || rel.includes("\0")) {
    return false;
  }
  if (rel.startsWith("/") || rel.startsWith("\\")) {
    return false;
  }
  return true;
}

export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '');
}

export function validatePluginCode(code: unknown): string {
  if (typeof code !== 'string') {
    throw new Error('Plugin code must be a string');
  }
  
  if (code.includes('eval(') || code.includes('Function(')) {
    throw new Error('Plugin code cannot contain eval or Function constructor');
  }
  
  if (code.length > 100000) {
    throw new Error('Plugin code exceeds maximum size');
  }
  
  return code;
}
