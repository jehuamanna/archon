import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { marked } from "marked";
import { requireAuth } from "./auth.js";

const noteShape = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const renderBody = z.object({
  type: z.string().min(1),
  note: noteShape,
});

const BUILTIN = new Set(["markdown", "mdx", "text", "code", "root"]);

function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderBuiltin(type: string, note: z.infer<typeof noteShape>): string {
  const content = note.content ?? "";
  const title = note.title ?? "";
  switch (type) {
    case "markdown":
    case "root":
      return `<div class="archon-builtin-markdown">${marked.parse(content, { async: false }) as string}</div>`;
    case "mdx":
      return `<div class="archon-builtin-mdx"><p><strong>MDX</strong> — live preview is limited on sync-api. Raw source:</p><pre>${escHtml(content)}</pre></div>`;
    case "text":
      return `<div class="archon-builtin-text prose">${content}</div>`;
    case "code":
      return `<div class="archon-builtin-code"><pre><code>${escHtml(content)}</code></pre></div>`;
    default:
      return `<pre>${escHtml(content)}</pre>`;
  }
}

export function registerBuiltinPluginRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): void {
  const { jwtSecret } = opts;

  app.post("/plugins/builtin-render", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const parsed = renderBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { type, note } = parsed.data;
    if (!BUILTIN.has(type)) {
      return reply.status(404).send({
        error: `No built-in renderer for type "${type}" on sync-api. Use the desktop app for marketplace plugins.`,
      });
    }
    try {
      const html = renderBuiltin(type, note);
      return reply.send({ html });
    } catch (e) {
      return reply.status(500).send({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.get("/plugins/builtin-renderer-meta", async (request, reply) => {
    const auth = await requireAuth(request, reply, jwtSecret);
    if (!auth) {
      return;
    }
    const q = request.query as { type?: string };
    const type = typeof q.type === "string" ? q.type : "";
    if (!BUILTIN.has(type)) {
      return reply.send(null);
    }
    return reply.send({
      theme: "inherit",
      deferDisplayUntilContentReady: type === "mdx",
      designSystemVersion: null as string | null,
    });
  });
}
