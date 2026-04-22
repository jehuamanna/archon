export const SHELL_SIDEBAR_COLLAPSED_KEY = "archon-primary-sidebar-collapsed";
export const LEFT_EXPANDED_PCT = 22;
export const LEFT_COLLAPSED_PCT = 3.2;

export function readShellSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SHELL_SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShellSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(SHELL_SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      localStorage.removeItem(SHELL_SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    /* ignore */
  }
}
