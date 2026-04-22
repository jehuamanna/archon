/**
 * One-time SES hardening for the renderer before loading untrusted plugin code.
 * System (first-party) plugins may bypass compartments; user plugins should run in Compartment.
 */
const g = globalThis as { __archonSesLockdown?: boolean };

export function ensureSesLockdown(): void {
  if (g.__archonSesLockdown || typeof window === "undefined") {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ses = require("ses") as { lockdown?: (opts?: unknown) => void };
    if (typeof ses.lockdown === "function") {
      ses.lockdown();
      g.__archonSesLockdown = true;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[archon] SES lockdown not applied:", err);
  }
}
