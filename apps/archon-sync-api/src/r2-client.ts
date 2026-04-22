import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { envString } from "./server-env.js";

/**
 * Cloudflare R2 client for image-note assets (Plan 01).
 *
 * R2 exposes an S3-compatible endpoint at
 *   https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com
 * which is what our `R2_PUBLIC_BASE` should point to.
 *
 * Credentials are read once at first call. The instance is cached
 * per-process — fine because env is process-static.
 */

export type R2Env = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
};

/** Read & validate the five R2 vars; throws if any are missing. */
export function readR2Env(): R2Env {
  const accountId = envString("R2_ACCOUNT_ID");
  const accessKeyId = envString("R2_ACCESS_KEY_ID");
  const secretAccessKey = envString("R2_SECRET_ACCESS_KEY");
  const bucket = envString("R2_BUCKET");
  const explicitBase = envString("R2_PUBLIC_BASE");
  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!bucket) missing.push("R2_BUCKET");
  if (missing.length > 0) {
    throw new Error(
      `R2 env vars missing: ${missing.join(", ")}. Required when ARCHON_FEATURE_IMAGE_NOTES=1.`,
    );
  }
  const endpoint =
    explicitBase || `https://${accountId}.r2.cloudflarestorage.com`;
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint };
}

/**
 * Minimal interface routes call. Lets tests pass a fake without spinning up
 * a real S3Client.
 */
export type R2ClientLike = {
  uploadObject(args: {
    key: string;
    body: Buffer;
    contentType: string;
    contentLength: number;
  }): Promise<void>;
  signGetUrl(args: { key: string; ttlSec: number }): Promise<string>;
  bucket: string;
};

let cachedClient: R2ClientLike | null = null;

export function getR2Client(): R2ClientLike {
  if (cachedClient) return cachedClient;
  const env = readR2Env();
  const s3 = new S3Client({
    region: "auto",
    endpoint: env.endpoint,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
  });
  cachedClient = {
    bucket: env.bucket,
    async uploadObject({ key, body, contentType, contentLength }) {
      await s3.send(
        new PutObjectCommand({
          Bucket: env.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: contentLength,
          CacheControl: "private, max-age=0",
        }),
      );
    },
    async signGetUrl({ key, ttlSec }) {
      return getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: env.bucket, Key: key }),
        { expiresIn: ttlSec },
      );
    },
  };
  return cachedClient;
}

/** Test-only: inject a fake client. Production callers must not use this. */
export function _setR2ClientForTesting(fake: R2ClientLike | null): void {
  cachedClient = fake;
}
