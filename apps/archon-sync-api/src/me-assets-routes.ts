import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth, type JwtPayload } from "./auth.js";
import { isImageNotesFeatureEnabled } from "./server-env.js";
import {
  buildImageAssetKey,
  isAllowedImageMime,
  parseImageAssetKey,
} from "./image-asset-path.js";
import {
  assertCanReadProject,
  assertCanWriteProject,
} from "./permission-resolver.js";
import { getR2Client, type R2ClientLike } from "./r2-client.js";

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const SIGN_TTL_DEFAULT_SEC = 15 * 60;
const SIGN_TTL_MIN_SEC = 60;
const SIGN_TTL_MAX_SEC = 15 * 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 30;

type RateBucket = { windowStartMs: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

function checkRate(userId: string, nowMs: number): boolean {
  const bucket = rateBuckets.get(userId);
  if (!bucket || nowMs - bucket.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(userId, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX_PER_WINDOW;
}

/** Test seam: clear rate buckets so tests don't cross-pollute. */
export function _resetRateBucketsForTesting(): void {
  rateBuckets.clear();
}

function disabled(reply: FastifyReply): FastifyReply {
  return reply.status(501).send({
    error:
      "Image-note assets are disabled on this server (set ARCHON_FEATURE_IMAGE_NOTES=1).",
  });
}

export type RegisterMeAssetsRoutesOptions = {
  jwtSecret: string;
  /** Test injection point. Production uses {@link getR2Client}. */
  r2Client?: R2ClientLike;
};

export async function registerMeAssetsRoutes(
  app: FastifyInstance,
  opts: RegisterMeAssetsRoutesOptions,
): Promise<void> {
  const { jwtSecret } = opts;
  const featureOn = isImageNotesFeatureEnabled();

  /**
   * Register the multipart parser unconditionally so that a disabled deploy
   * returns the intended 501 from {@link disabled} instead of a confusing 415
   * from Fastify's default body parser rejecting the `multipart/form-data`
   * Content-Type before our handler runs.
   */
  await app.register(import("@fastify/multipart"), {
    limits: { fileSize: IMAGE_MAX_BYTES, files: 1, fields: 8 },
  });

  app.post("/me/assets/upload", async (request, reply) => {
    if (!featureOn) return disabled(reply);
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;

    if (!checkRate(auth.sub, Date.now())) {
      return reply
        .status(429)
        .send({ error: "Upload rate limit exceeded; try again shortly." });
    }

    if (!request.isMultipart()) {
      return reply
        .status(400)
        .send({ error: "Expected multipart/form-data upload" });
    }

    let workspaceId: string | undefined;
    let projectId: string | undefined;
    let noteId: string | undefined;
    let variant: "original" | "thumb" = "original";
    let fileBuf: Buffer | undefined;
    let mimeType: string | undefined;
    let originalFilename: string | undefined;

    const parts = request.parts();
    let truncated = false;
    for await (const part of parts) {
      if (part.type === "field") {
        const v = typeof part.value === "string" ? part.value : "";
        if (part.fieldname === "workspaceId") workspaceId = v;
        else if (part.fieldname === "projectId") projectId = v;
        else if (part.fieldname === "noteId") noteId = v;
        else if (part.fieldname === "variant") {
          if (v !== "original" && v !== "thumb") {
            return reply.status(400).send({
              error: `Invalid variant \"${v}\"; allowed values: original, thumb`,
            });
          }
          variant = v;
        }
      } else if (part.type === "file") {
        if (fileBuf) {
          return reply
            .status(400)
            .send({ error: "Only one file field is allowed" });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file) {
          total += chunk.length;
          if (total > IMAGE_MAX_BYTES) {
            truncated = true;
            break;
          }
          chunks.push(chunk as Buffer);
        }
        if (truncated || part.file.truncated) {
          return reply
            .status(413)
            .send({ error: `File exceeds ${IMAGE_MAX_BYTES} bytes` });
        }
        fileBuf = Buffer.concat(chunks);
        mimeType = part.mimetype;
        originalFilename = part.filename;
      }
    }

    if (!projectId || !workspaceId || !noteId) {
      return reply
        .status(400)
        .send({ error: "Missing required field: workspaceId, projectId, noteId" });
    }
    if (!fileBuf || !mimeType) {
      return reply.status(400).send({ error: "Missing file part" });
    }
    if (!isAllowedImageMime(mimeType)) {
      return reply.status(415).send({
        error: `Unsupported mime type: ${mimeType}`,
      });
    }

    const writeResult = await assertCanWriteProject(reply, auth, projectId);
    if (!writeResult) return;
    const { workspace, project } = writeResult;

    if (project.workspace_id !== workspaceId) {
      return reply
        .status(400)
        .send({ error: "workspaceId does not match project's workspace" });
    }
    if (!workspace.orgId || !workspace.spaceId) {
      return reply.status(400).send({
        error: "Workspace is not org/space-scoped; image uploads require both",
      });
    }

    let key: string;
    try {
      key = buildImageAssetKey({
        orgId: workspace.orgId,
        spaceId: workspace.spaceId,
        workspaceId,
        projectId,
        noteId,
        variant,
      });
    } catch (e) {
      return reply
        .status(400)
        .send({ error: e instanceof Error ? e.message : "Invalid id" });
    }

    const r2 = opts.r2Client ?? getR2Client();
    try {
      await r2.uploadObject({
        key,
        body: fileBuf,
        contentType: mimeType,
        contentLength: fileBuf.length,
      });
    } catch (e) {
      request.log.error({ err: e, key }, "R2 upload failed");
      return reply.status(502).send({ error: "Upload to object storage failed" });
    }

    return reply.send({
      r2Key: key,
      mimeType,
      sizeBytes: fileBuf.length,
      variant,
      ...(originalFilename ? { originalFilename } : {}),
    });
  });

  app.get("/me/assets/file", async (request, reply) => {
    if (!featureOn) return disabled(reply);
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const url = await signKeyForCaller(reply, auth, request, opts);
    if (!url) return;
    return reply.redirect(url, 302);
  });

  app.post("/me/assets/sign", async (request, reply) => {
    if (!featureOn) return disabled(reply);
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) return;
    const body = (request.body ?? {}) as { key?: unknown; ttlSec?: unknown };
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) {
      return reply.status(400).send({ error: "Missing key" });
    }
    const requestedTtl =
      typeof body.ttlSec === "number" && Number.isFinite(body.ttlSec)
        ? Math.floor(body.ttlSec)
        : SIGN_TTL_DEFAULT_SEC;
    const ttlSec = Math.min(
      Math.max(requestedTtl, SIGN_TTL_MIN_SEC),
      SIGN_TTL_MAX_SEC,
    );
    const url = await signKeyForCallerWithKey(reply, auth, key, ttlSec, opts);
    if (!url) return;
    return reply.send({ url, expiresAt: Date.now() + ttlSec * 1000 });
  });
}

async function signKeyForCaller(
  reply: FastifyReply,
  auth: JwtPayload,
  request: import("fastify").FastifyRequest,
  opts: RegisterMeAssetsRoutesOptions,
): Promise<string | null> {
  const q = (request.query as { key?: string }).key;
  if (typeof q !== "string" || !q.trim()) {
    await reply.status(400).send({ error: "Missing key query parameter" });
    return null;
  }
  return signKeyForCallerWithKey(reply, auth, q, SIGN_TTL_DEFAULT_SEC, opts);
}

async function signKeyForCallerWithKey(
  reply: FastifyReply,
  auth: JwtPayload,
  key: string,
  ttlSec: number,
  opts: RegisterMeAssetsRoutesOptions,
): Promise<string | null> {
  const parsed = parseImageAssetKey(key);
  if (!parsed) {
    await reply.status(400).send({ error: "Invalid asset key shape" });
    return null;
  }
  const readResult = await assertCanReadProject(reply, auth, parsed.projectId);
  if (!readResult) return null;
  if (
    readResult.workspace.orgId !== parsed.orgId ||
    readResult.workspace.spaceId !== parsed.spaceId ||
    readResult.workspace.id !== parsed.workspaceId
  ) {
    await reply
      .status(403)
      .send({ error: "Asset key scope does not match project" });
    return null;
  }
  const r2 = opts.r2Client ?? getR2Client();
  try {
    return await r2.signGetUrl({ key, ttlSec });
  } catch {
    await reply.status(502).send({ error: "Failed to sign URL" });
    return null;
  }
}
