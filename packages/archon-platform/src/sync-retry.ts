/** ADR-006 retry: 1s, 2s, 4s then throw (four attempts). */
export async function withSyncRetry<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await run();
    } catch (e) {
      last = e;
      if (attempt === 3) {
        break;
      }
      const ms = 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw last;
}
