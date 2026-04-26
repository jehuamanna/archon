/**
 * Public, unauthenticated endpoint that returns the Archon MDX mini-app
 * authoring contract — JSON Schema for every component plus a derived
 * system-prompt fragment for AI tools.
 *
 * Path: `GET /api/v1/mdx-sdk/spec`
 *
 * Why public: the spec describes the *shape* of authored MDX, not any user
 * data. Browser-embedded LLMs (Claude, GPT) need it to generate valid notes
 * and shouldn't have to authenticate just to fetch a static schema.
 *
 * Why served from the API at all (vs. just `npm install @archon/mdx-sdk`):
 *   - In-browser authoring tools that don't bundle the package can fetch it
 *     directly, version-pinned by the running server.
 *   - Schema rolls out atomically with the server that enforces it — no
 *     dependency-version drift between the model's spec and the validator.
 */
import type { FastifyInstance } from "fastify";
import {
  buildMdxSdkJsonSchema,
  buildArchonMdxSystemPrompt,
  sdkVersion,
  ALLOWED_FACADE_IMPORTS,
} from "@nodex-studio/mdx-sdk";

const schemaCache = buildMdxSdkJsonSchema(sdkVersion);
const promptCache = buildArchonMdxSystemPrompt(sdkVersion);
const responseCache = {
  sdkVersion,
  allowedImports: ALLOWED_FACADE_IMPORTS,
  schema: schemaCache,
  systemPrompt: promptCache,
};

export function registerMdxSdkSpecRoutes(app: FastifyInstance): void {
  app.get("/mdx-sdk/spec", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send(responseCache);
  });

  app.get("/mdx-sdk/system-prompt", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    return reply.send(promptCache);
  });
}
