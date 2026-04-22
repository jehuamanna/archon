type SyncSessionInvalidatedHandler = () => void;

let syncSessionInvalidatedHandler: SyncSessionInvalidatedHandler | null = null;

export function setSyncSessionInvalidatedHandler(
  handler: SyncSessionInvalidatedHandler | null,
): void {
  syncSessionInvalidatedHandler = handler;
}

export function notifySyncSessionInvalidated(): void {
  syncSessionInvalidatedHandler?.();
}
