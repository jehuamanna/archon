import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAuth, signAccessToken, signRefreshToken } from "./auth.js";
import type { UserDoc } from "./db.js";
import { getUsersCollection } from "./db.js";
import { buildSessionsAfterAppend } from "./refresh-sessions.js";
import { getMcpDeviceSessionsCollection } from "./db.js";

const MAX_ACTIVE_SESSIONS_PER_USER = 5;

/** Pending browser MCP login window (user_code / device_code). Override with ARCHON_MCP_DEVICE_SESSION_TTL_MS (milliseconds), min 60_000, max 10 years. Default 30 days. */
function resolveDeviceSessionTtlMs(): number {
  const raw =
    typeof process.env.ARCHON_MCP_DEVICE_SESSION_TTL_MS === "string"
      ? process.env.ARCHON_MCP_DEVICE_SESSION_TTL_MS.trim()
      : "";
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 60_000) {
      return Math.min(Math.floor(n), 10 * 365 * 24 * 60 * 60 * 1000);
    }
  }
  return 30 * 24 * 60 * 60 * 1000;
}

const DEVICE_SESSION_TTL_MS = resolveDeviceSessionTtlMs();
const START_RATE_WINDOW_MS = 10 * 60 * 1000;
const START_RATE_MAX_PER_IP = 40;

const authorizeBody = z.object({
  user_code: z.string().min(4).max(64),
});

const tokenBody = z.object({
  device_code: z.string().min(10).max(512),
});

function hashDeviceCode(deviceCode: string, jwtSecret: string): string {
  return createHash("sha256")
    .update(deviceCode, "utf8")
    .update("\0", "utf8")
    .update(jwtSecret, "utf8")
    .digest("hex");
}

function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += alphabet[bytes[i]! % alphabet.length]!;
  }
  return s;
}

function randomDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

function clientIp(request: FastifyRequest): string {
  const xf = request.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0]!.trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

function verificationBaseUrl(request: FastifyRequest): string {
  const fromEnv =
    typeof process.env.ARCHON_MCP_WEB_VERIFY_BASE === "string"
      ? process.env.ARCHON_MCP_WEB_VERIFY_BASE.trim().replace(/\/+$/, "")
      : "";
  if (fromEnv) {
    return fromEnv;
  }
  const host = request.headers.host ?? "127.0.0.1:4010";
  const proto =
    request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function registerMcpDeviceAuthRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.post("/auth/mcp/device/start", async (request, reply) => {
    const ip = clientIp(request);
    const coll = getMcpDeviceSessionsCollection();
    const since = new Date(Date.now() - START_RATE_WINDOW_MS);
    const recentStarts = await coll.countDocuments({
      clientIp: ip,
      createdAt: { $gte: since },
    });
    if (recentStarts >= START_RATE_MAX_PER_IP) {
      return reply.status(429).send({ error: "Too many device login attempts from this network" });
    }

    let userCode = randomUserCode();
    for (let attempt = 0; attempt < 8; attempt++) {
      const clash = await coll.findOne({ userCode });
      if (!clash) {
        break;
      }
      userCode = randomUserCode();
    }

    const deviceCode = randomDeviceCode();
    const deviceCodeHash = hashDeviceCode(deviceCode, jwtSecret);
    const now = Date.now();
    const expiresAt = new Date(now + DEVICE_SESSION_TTL_MS);

    await coll.insertOne({
      userCode,
      deviceCodeHash,
      status: "awaiting_user",
      clientIp: ip,
      createdAt: new Date(now),
      expiresAt,
    });

    const base = verificationBaseUrl(request);
    const verification_uri = `${base}/mcp-auth?user_code=${encodeURIComponent(userCode)}`;

    return reply.send({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri,
      expires_in: Math.floor(DEVICE_SESSION_TTL_MS / 1000),
      interval: 2,
    });
  });

  app.post("/auth/mcp/device/authorize", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = authorizeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { user_code } = parsed.data;
    const coll = getMcpDeviceSessionsCollection();
    const row = await coll.findOne({ userCode: user_code });
    if (!row || !row._id) {
      return reply.status(404).send({ error: "Unknown or expired user_code" });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return reply.status(410).send({ error: "This login request has expired" });
    }
    if (row.status === "consumed") {
      return reply.status(410).send({ error: "This login request was already completed" });
    }

    if (row.boundUserId && row.boundUserId !== auth.sub) {
      return reply.status(403).send({ error: "This device session belongs to another account" });
    }

    if (row.status === "awaiting_mcp" && row.boundUserId === auth.sub) {
      return reply.send({ ok: true, status: "already_authorized" });
    }

    if (row.status !== "awaiting_user") {
      return reply.status(400).send({ error: "Invalid device session state" });
    }

    const active = await coll.countDocuments({
      boundUserId: auth.sub,
      status: "awaiting_mcp",
      expiresAt: { $gt: new Date() },
    });
    if (active >= MAX_ACTIVE_SESSIONS_PER_USER) {
      return reply.status(409).send({
        error: `Too many active MCP browser logins (${MAX_ACTIVE_SESSIONS_PER_USER}). Wait for them to expire or complete polling.`,
      });
    }

    const users = getUsersCollection();
    let userOid: ObjectId;
    try {
      userOid = new ObjectId(auth.sub);
    } catch {
      return reply.status(400).send({ error: "Invalid account id in session" });
    }

    const userRow = (await users.findOne({ _id: userOid })) as UserDoc | null;
    if (!userRow) {
      return reply.status(400).send({ error: "Account not found" });
    }
    const payload = { sub: auth.sub, email: auth.email };
    const jti = randomUUID();
    const accessToken = signAccessToken(jwtSecret, payload, "mcp");
    const refreshToken = signRefreshToken(jwtSecret, payload, jti, "mcp");
    const nextSessions = buildSessionsAfterAppend(userRow, jti);
    await users.updateOne(
      { _id: userOid },
      { $set: { refreshSessions: nextSessions }, $unset: { activeRefreshJti: "" } },
    );

    await coll.updateOne(
      { _id: row._id, status: "awaiting_user" },
      {
        $set: {
          boundUserId: auth.sub,
          status: "awaiting_mcp",
          issuedAccessToken: accessToken,
          issuedRefreshToken: refreshToken,
        },
      },
    );

    return reply.send({ ok: true, status: "authorized", userId: auth.sub });
  });

  app.post("/auth/mcp/device/token", async (request, reply) => {
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const deviceCodeHash = hashDeviceCode(parsed.data.device_code, jwtSecret);
    const coll = getMcpDeviceSessionsCollection();
    const row = await coll.findOne({ deviceCodeHash });
    if (!row || !row._id) {
      return reply.send({ status: "invalid" });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return reply.send({ status: "expired" });
    }
    if (row.status === "consumed") {
      return reply.send({ status: "invalid" });
    }
    if (row.status !== "awaiting_mcp") {
      return reply.send({ status: "pending" });
    }
    if (!row.issuedAccessToken || !row.issuedRefreshToken || !row.boundUserId) {
      return reply.send({ status: "pending" });
    }

    const out = {
      status: "authorized" as const,
      token: row.issuedAccessToken,
      refreshToken: row.issuedRefreshToken,
      userId: row.boundUserId,
    };

    await coll.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "consumed",
          issuedAccessToken: null,
          issuedRefreshToken: null,
        },
      },
    );

    return reply.send(out);
  });
}
