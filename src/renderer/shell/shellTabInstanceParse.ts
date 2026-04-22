/**
 * Shell tab `instanceId` format is `${tabTypeId}:${Date.now()}:${randomHex}`.
 * After a full reload the instance is gone; this recovers `tabTypeId` for deep links.
 */
export function parseEphemeralShellTabInstanceId(instanceId: string): string | null {
  const s = instanceId.trim();
  const m = s.match(/^(.+):(\d{10,17}):([a-f0-9]{4,})$/i);
  if (!m?.[1]) return null;
  return m[1];
}
