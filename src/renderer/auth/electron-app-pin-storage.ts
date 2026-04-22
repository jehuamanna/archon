/**
 * Optional Electron app PIN: quick UI unlock per renderer session.
 * Sync JWTs stay in existing cloud storage; this only stores a PBKDF2 verifier.
 */

const PIN_RECORD_KEY = "archon-electron-app-pin-record-v1";
const OFFER_DISMISSED_KEY = "archon-electron-app-pin-offer-dismissed-v1";
const SESSION_UNLOCK_KEY = "archon-electron-app-pin-session-unlocked-v1";

const PBKDF2_ITERATIONS = 120_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

type PinRecordJson = {
  saltB64: string;
  verifierB64: string;
};

function b64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function b64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function readPinRecordJson(): PinRecordJson | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PIN_RECORD_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as PinRecordJson;
    if (!o?.saltB64 || !o?.verifierB64) return null;
    return o;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function deriveVerifierBytes(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

export function isElectronAppPinEnabled(): boolean {
  return readPinRecordJson() != null;
}

export function isPinOfferDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(OFFER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markPinOfferDismissed(): void {
  try {
    localStorage.setItem(OFFER_DISMISSED_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function isSessionPinUnlocked(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(SESSION_UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSessionPinUnlocked(): void {
  try {
    sessionStorage.setItem(SESSION_UNLOCK_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearSessionPinUnlock(): void {
  try {
    sessionStorage.removeItem(SESSION_UNLOCK_KEY);
  } catch {
    /* ignore */
  }
}

export async function setElectronAppPin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (trimmed.length < 4 || trimmed.length > 32) {
    throw new Error("PIN must be between 4 and 32 characters.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const verifier = await deriveVerifierBytes(trimmed, salt);
  const record: PinRecordJson = {
    saltB64: b64EncodeBytes(salt),
    verifierB64: b64EncodeBytes(verifier),
  };
  try {
    localStorage.setItem(PIN_RECORD_KEY, JSON.stringify(record));
  } catch {
    throw new Error("Could not save PIN.");
  }
}

export async function verifyElectronAppPin(pin: string): Promise<boolean> {
  const record = readPinRecordJson();
  if (!record) return false;
  const salt = b64Decode(record.saltB64);
  const expected = b64Decode(record.verifierB64);
  const derived = await deriveVerifierBytes(pin.trim(), salt);
  return timingSafeEqual(derived, expected);
}

/** Removes PIN record, offer-dismissed flag, and session unlock (local + session storage). */
export function clearAllElectronAppPinSettings(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PIN_RECORD_KEY);
    localStorage.removeItem(OFFER_DISMISSED_KEY);
  } catch {
    /* ignore */
  }
  clearSessionPinUnlock();
}
