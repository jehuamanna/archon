import jwt, { type SignOptions } from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAndTranslateAccess } from "./auth-translate.js";

const ACCESS_EXPIRES =
  (typeof process.env.ARCHON_JWT_ACCESS_EXPIRES === "string" &&
    process.env.ARCHON_JWT_ACCESS_EXPIRES.trim()) ||
  "15m";
const REFRESH_EXPIRES =
  (typeof process.env.ARCHON_JWT_REFRESH_EXPIRES === "string" &&
    process.env.ARCHON_JWT_REFRESH_EXPIRES.trim()) ||
  "30d";

/** Access + refresh tokens from MCP browser or password login. */
const MCP_ACCESS_EXPIRES =
  (typeof process.env.ARCHON_JWT_MCP_ACCESS_EXPIRES === "string" &&
    process.env.ARCHON_JWT_MCP_ACCESS_EXPIRES.trim()) ||
  "7d";
const MCP_REFRESH_EXPIRES =
  (typeof process.env.ARCHON_JWT_MCP_REFRESH_EXPIRES === "string" &&
    process.env.ARCHON_JWT_MCP_REFRESH_EXPIRES.trim()) ||
  "7d";

/**
 * Realtime principal block. Every post-cutover access token carries one;
 * pre-cutover tokens leave it absent and the verifier falls back to
 * `mcp?: boolean`.
 */
export type Principal = {
  type: "user" | "mcp";
  metadata?: Record<string, unknown>;
};

export type JwtPayload = {
  sub: string;
  email: string;
  typ?: string;
  /** Present on refresh tokens (rotation / single active session). */
  jti?: string;
  /** MCP-issued tokens carry this so /auth/refresh keeps MCP access + refresh TTLs. */
  mcp?: boolean;
  /** Canonical realtime identity. Optional for backward compatibility. */
  principal?: Principal;
  /** Active organization context (Phase 1). May be absent on legacy tokens. */
  activeOrgId?: string;
  /** Active space context (Phase 2). May be absent on legacy tokens. */
  activeSpaceId?: string;
};

export type RefreshJwtPayload = JwtPayload & { typ: "refresh"; jti: string };

/** Issue web-style vs MCP-style JWT expiries (see ARCHON_JWT_* and ARCHON_JWT_MCP_* env). */
export type AuthTokenVariant = "default" | "mcp";
/** @deprecated use AuthTokenVariant */
export type RefreshTokenVariant = AuthTokenVariant;

export function signToken(
  secret: string,
  payload: JwtPayload,
  expiresIn: string | false = false,
): string {
  const opts: SignOptions = { algorithm: "HS256" };
  if (expiresIn) {
    opts.expiresIn = expiresIn as SignOptions["expiresIn"];
  }
  return jwt.sign(payload, secret, opts);
}

export function signAccessToken(
  secret: string,
  payload: JwtPayload,
  variant: AuthTokenVariant = "default",
): string {
  const expiresIn = variant === "mcp" ? MCP_ACCESS_EXPIRES : ACCESS_EXPIRES;
  const body: JwtPayload =
    variant === "mcp"
      ? {
          sub: payload.sub,
          email: payload.email,
          typ: "access",
          mcp: true,
          ...(payload.activeOrgId ? { activeOrgId: payload.activeOrgId } : {}),
          ...(payload.activeSpaceId ? { activeSpaceId: payload.activeSpaceId } : {}),
        }
      : { ...payload, typ: "access" };
  return signToken(secret, body, expiresIn);
}

export function signRefreshToken(
  secret: string,
  payload: JwtPayload,
  jti: string,
  variant: AuthTokenVariant = "default",
): string {
  const expiresIn = variant === "mcp" ? MCP_REFRESH_EXPIRES : REFRESH_EXPIRES;
  const body: JwtPayload =
    variant === "mcp"
      ? { sub: payload.sub, email: payload.email, typ: "refresh", jti, mcp: true }
      : { sub: payload.sub, email: payload.email, typ: "refresh", jti };
  return signToken(secret, body, expiresIn);
}

export function verifyToken(secret: string, token: string): JwtPayload {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as JwtPayload).sub !== "string" ||
    typeof (decoded as JwtPayload).email !== "string"
  ) {
    throw new Error("Invalid token payload");
  }
  return decoded as JwtPayload;
}

export function verifyAccessToken(secret: string, token: string): JwtPayload {
  const p = verifyToken(secret, token);
  if (p.typ === "refresh") {
    throw new Error("Invalid token type");
  }
  return p;
}

export function verifyRefreshToken(
  secret: string,
  token: string,
): RefreshJwtPayload {
  const p = verifyToken(secret, token) as RefreshJwtPayload;
  if (p.typ !== "refresh" || typeof p.jti !== "string" || p.jti.length === 0) {
    throw new Error("Invalid refresh token");
  }
  return p;
}

export function authBearerHeader(
  request: FastifyRequest,
): string | undefined {
  const h = request.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) {
    return undefined;
  }
  return h.slice("Bearer ".length).trim();
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtSecret: string,
): Promise<JwtPayload | null> {
  const token = authBearerHeader(request);
  if (!token) {
    await reply.status(401).send({ error: "Missing Authorization bearer token" });
    return null;
  }
  try {
    return await verifyAndTranslateAccess(jwtSecret, token);
  } catch {
    await reply.status(401).send({ error: "Invalid or expired token" });
    return null;
  }
}
