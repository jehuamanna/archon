import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE_NAME = "mcp-cloud-auth.json";
const MAGIC = "archon-mcp-auth-v1";

export type PersistedMcpAuth = {
  accessToken: string;
  refreshToken: string;
};

function defaultAuthFilePath(): string {
  const override = process.env.ARCHON_MCP_AUTH_FILE?.trim();
  if (override) {
    return path.resolve(override);
  }
  const base =
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(os.homedir(), ".config");
  return path.join(base, "archon", FILE_NAME);
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

function encryptJson(plain: string, password: string): Buffer {
  const salt = randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(MAGIC, "utf8"),
    salt,
    iv,
    tag,
    enc,
  ]);
}

function decryptJson(buf: Buffer, password: string): string {
  const magicLen = Buffer.byteLength(MAGIC, "utf8");
  if (buf.length < magicLen + 16 + 12 + 16) {
    throw new Error("Corrupt encrypted auth file");
  }
  if (buf.subarray(0, magicLen).toString("utf8") !== MAGIC) {
    throw new Error("Unknown encrypted auth file format");
  }
  let o = magicLen;
  const salt = buf.subarray(o, o + 16);
  o += 16;
  const iv = buf.subarray(o, o + 12);
  o += 12;
  const tag = buf.subarray(o, o + 16);
  o += 16;
  const enc = buf.subarray(o);
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function encryptionPassword(): string | null {
  const raw = process.env.ARCHON_MCP_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    return null;
  }
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function resolveMcpAuthPersistPath(): string {
  return defaultAuthFilePath();
}

export function readPersistedMcpAuth(filePath: string): PersistedMcpAuth | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath);
    const pass = encryptionPassword();
    const magicBuf = Buffer.from(MAGIC, "utf8");
    const text =
      pass && raw.length >= magicBuf.length && raw.subarray(0, magicBuf.length).equals(magicBuf)
        ? decryptJson(raw, pass)
        : raw.toString("utf8");
    const j = JSON.parse(text) as { accessToken?: string; refreshToken?: string };
    const accessToken = typeof j.accessToken === "string" ? j.accessToken.trim() : "";
    const refreshToken =
      typeof j.refreshToken === "string" ? j.refreshToken.trim() : "";
    if (!accessToken) {
      return null;
    }
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

export function writePersistedMcpAuth(
  filePath: string,
  tokens: PersistedMcpAuth,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    },
    null,
    0,
  );
  const pass = encryptionPassword();
  const payload = pass ? encryptJson(body, pass) : Buffer.from(body, "utf8");
  fs.writeFileSync(filePath, payload, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* windows */
  }
}

export function clearPersistedMcpAuth(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    /* ignore */
  }
}
