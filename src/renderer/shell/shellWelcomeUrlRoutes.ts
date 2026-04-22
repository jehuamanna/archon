/** Welcome tab deep links: `#/welcome` and `#/welcome/<segment>` → shell commands. */

export const WELCOME_SHELL_URL_COMMANDS = {
  "scratch-markdown": "archon.notes.openScratchMarkdownTab",
  "js-notebook": "archon.jsNotebook.open",
  documentation: "archon.docs.open",
  "notes-explorer": "archon.notesExplorer.open",
} as const;

export type WelcomeShellUrlSegment = keyof typeof WELCOME_SHELL_URL_COMMANDS;

export function isWelcomeShellUrlSegment(s: string): s is WelcomeShellUrlSegment {
  return s in WELCOME_SHELL_URL_COMMANDS;
}

/** Optional state on the welcome tab instance for stable URLs (`#/welcome/notes-explorer`). */
export type ShellWelcomeTabState = {
  welcomeHashSegment?: WelcomeShellUrlSegment;
};

export type ParsedWelcomeShellHash = { kind: "welcome"; segment: "" | WelcomeShellUrlSegment };

/**
 * Parse a markdown link `href` that targets the welcome shell routes (`#/welcome`, `#/welcome/...`).
 * Only considers the URL fragment (requires `#` in `href`).
 */
export function parseMarkdownWelcomeShellHref(href: string): ParsedWelcomeShellHash | null | undefined {
  const t = href.trim();
  if (t.length === 0) return undefined;
  const hashIdx = t.indexOf("#");
  if (hashIdx < 0) return undefined;
  const frag = t.slice(hashIdx + 1).trim();
  if (frag.length === 0) return undefined;
  const normalized = frag.startsWith("/") ? frag : `/${frag}`;
  return tryParseWelcomeShellHash(normalized);
}

/**
 * Parse the hash body (no leading `#`) for welcome routes.
 * @returns parsed welcome hash, `null` if the path is under `/welcome/` but invalid, or `undefined` if not a welcome route.
 */
export function tryParseWelcomeShellHash(raw: string): ParsedWelcomeShellHash | null | undefined {
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (!(withSlash === "/welcome" || withSlash.startsWith("/welcome/"))) {
    return undefined;
  }
  if (withSlash === "/welcome" || withSlash === "/welcome/") {
    return { kind: "welcome", segment: "" };
  }
  const rest = withSlash.slice("/welcome/".length);
  const seg = rest
    .split("/")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!seg) return { kind: "welcome", segment: "" };
  if (/^[a-z0-9-]+$/i.test(seg) && isWelcomeShellUrlSegment(seg)) {
    return { kind: "welcome", segment: seg };
  }
  return null;
}
