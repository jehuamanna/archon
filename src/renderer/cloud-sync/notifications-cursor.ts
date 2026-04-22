const CURSOR_KEY = "archon-notifications-cursor";

export function readNotificationsCursor(): string | null {
  try {
    return localStorage.getItem(CURSOR_KEY);
  } catch {
    return null;
  }
}

export function writeNotificationsCursor(cursor: string | null): void {
  try {
    if (cursor) {
      localStorage.setItem(CURSOR_KEY, cursor);
    } else {
      localStorage.removeItem(CURSOR_KEY);
    }
  } catch {
    /* private mode */
  }
}
