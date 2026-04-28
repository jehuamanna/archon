/**
 * `crypto.randomUUID` is gated to secure contexts (https, localhost, 127.0.0.1).
 * On a LAN IP over plain http (e.g. `http://10.42.0.94:3000` for cross-machine
 * dev), it is undefined while `crypto.getRandomValues` is still available — so
 * we synthesize an RFC 4122 v4 UUID from CSPRNG bytes.
 */
if (
  typeof globalThis !== "undefined" &&
  typeof globalThis.crypto !== "undefined" &&
  typeof (globalThis.crypto as Crypto).randomUUID !== "function" &&
  typeof globalThis.crypto.getRandomValues === "function"
) {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  c.randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h: string[] = [];
    for (let i = 0; i < 256; i++) h.push((i + 0x100).toString(16).slice(1));
    return `${h[b[0]]}${h[b[1]]}${h[b[2]]}${h[b[3]]}-${h[b[4]]}${h[b[5]]}-${h[b[6]]}${h[b[7]]}-${h[b[8]]}${h[b[9]]}-${h[b[10]]}${h[b[11]]}${h[b[12]]}${h[b[13]]}${h[b[14]]}${h[b[15]]}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}

export {};
