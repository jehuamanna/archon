import React, { useMemo, useRef } from "react";
import type { Components } from "react-markdown";
import type { MDXComponents } from "mdx/types";
import type { Note } from "@archon/ui-types";
import { baseSlug } from "../../utils/markdown-heading-slugs";
import {
  parseMarkdownWelcomeShellHref,
  type WelcomeShellUrlSegment,
} from "../../shell/shellWelcomeUrlRoutes";
import {
  markdownInternalNoteHref,
  markdownVfsNoteHref,
  parseInternalMarkdownNoteLink,
  type InternalMarkdownNoteLink,
} from "../../utils/markdown-internal-note-href";
import { WpnVfsImage } from "../../shell/first-party/plugins/image-notes/WpnVfsImage";

/** Fragment only, matches heading `id`s from this renderer (`baseSlug` + optional `-n`). */
export const SAME_PAGE_HEADING_HASH = /^#([a-z0-9-]+)$/;

/** Shell command links in markdown, e.g. `[Open](archon-cmd:archon.docs.open)`. */
export const ARCHON_CMD_HREF = /^archon-cmd:([\w.]+)$/;

export type MarkdownUiLinkCallbacks = {
  onSamePageHeadingClick?: (slug: string) => void;
  onInternalNoteNavigate?: (link: InternalMarkdownNoteLink) => void;
  onArchonCmdLink?: (commandId: string) => void;
  onWelcomeShellSegmentClick?: (segment: "" | WelcomeShellUrlSegment) => void;
  /** When provided, internal note links whose target is invalid render with broken-link styling. */
  isLinkTargetValid?: (link: InternalMarkdownNoteLink) => boolean;
  /**
   * The note this markdown body is being rendered for. Lets the `<img>`
   * override resolve same-project-relative `#/w/./…` image-note hrefs
   * by scoping title lookups to that note's project.
   */
  currentNote?: Note;
};

type MarkdownHeading = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return extractText(node.props.children);
  return "";
}

export const markdownShellClass =
  "text-foreground max-w-none min-w-0 text-[16px] leading-[1.55] " +
  "[&_h1]:text-[16px] [&_h1]:font-semibold [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:scroll-mt-4 " +
  "[&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:scroll-mt-4 " +
  "[&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:scroll-mt-4 " +
  "[&_h4]:text-[13px] [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:scroll-mt-4 " +
  "[&_h5]:text-[12px] [&_h5]:font-semibold [&_h5]:mt-3 [&_h5]:mb-1.5 [&_h5]:scroll-mt-4 " +
  "[&_h6]:text-[12px] [&_h6]:font-semibold [&_h6]:mt-3 [&_h6]:mb-1.5 [&_h6]:scroll-mt-4 " +
  "[&_p]:mb-3 [&_p]:text-[16px] [&_p]:leading-[1.55] " +
  "[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6 " +
  "[&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-6 " +
  "[&_li]:my-1 [&_li]:text-[16px] [&_li]:leading-[1.55] " +
  "[&_strong]:font-semibold " +
  "[&_a]:text-primary [&_a]:underline underline-offset-2 " +
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[14px] [&_table]:my-3 " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top " +
  "[&_tr:nth-child(even)_td]:bg-muted/15 " +
  "[&_code]:rounded-sm [&_code]:bg-muted/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[14px] " +
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/35 [&_pre]:p-3 " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[14px] " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground";

/**
 * Shared heading ids and link click handlers for react-markdown and MDX so TOC / doc hash stay aligned.
 */
export function useArchonMarkdownUiComponents(
  callbacks: MarkdownUiLinkCallbacks,
): { components: Components; mdxComponents: MDXComponents } {
  const {
    onSamePageHeadingClick,
    onInternalNoteNavigate,
    onArchonCmdLink,
    onWelcomeShellSegmentClick,
    isLinkTargetValid,
    currentNote,
  } = callbacks;

  const slugCountsRef = useRef<Map<string, number>>(new Map());
  slugCountsRef.current = new Map();

  const components = useMemo(() => {
    const make =
      (Tag: MarkdownHeading) =>
      ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement> & { children?: React.ReactNode }) => {
        const text = extractText(children);
        const slugBase = baseSlug(text);
        const map = slugCountsRef.current;
        const prev = map.get(slugBase) ?? 0;
        const nextCount = prev + 1;
        map.set(slugBase, nextCount);
        const id = nextCount === 1 ? slugBase : `${slugBase}-${nextCount}`;
        return (
          <Tag id={id} {...props}>
            {children}
          </Tag>
        );
      };

    const InternalOrExternalLink = ({
      href,
      children,
      ...rest
    }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      if (typeof href === "string" && onArchonCmdLink) {
        const cmd = href.match(ARCHON_CMD_HREF);
        if (cmd?.[1]) {
          const commandId = cmd[1];
          return (
            <a
              {...rest}
              href={href}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                  return;
                }
                e.preventDefault();
                onArchonCmdLink(commandId);
              }}
            >
              {children}
            </a>
          );
        }
      }
      if (typeof href === "string" && onWelcomeShellSegmentClick) {
        const welcome = parseMarkdownWelcomeShellHref(href);
        if (welcome !== undefined && welcome !== null) {
          const segment = welcome.segment;
          return (
            <a
              {...rest}
              href={href}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                  return;
                }
                e.preventDefault();
                onWelcomeShellSegmentClick(segment);
              }}
            >
              {children}
            </a>
          );
        }
      }
      const internal = typeof href === "string" ? parseInternalMarkdownNoteLink(href) : null;
      if (internal) {
        const canonical =
          internal.kind === "vfs"
            ? markdownVfsNoteHref(internal.vfsPath, internal.markdownHeadingSlug)
            : markdownInternalNoteHref(internal.noteId, internal.markdownHeadingSlug);
        const isBroken = isLinkTargetValid ? !isLinkTargetValid(internal) : false;
        return (
          <a
            {...rest}
            href={canonical}
            className={isBroken ? "line-through opacity-60 text-destructive" : rest.className}
            title={isBroken ? "This note no longer exists" : rest.title}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                return;
              }
              e.preventDefault();
              if (onInternalNoteNavigate) {
                onInternalNoteNavigate(internal);
                return;
              }
              if (typeof window !== "undefined" && window.location.hash !== canonical) {
                window.location.hash = canonical;
              }
            }}
          >
            {children}
          </a>
        );
      }
      if (typeof href === "string" && onSamePageHeadingClick) {
        const hm = href.match(SAME_PAGE_HEADING_HASH);
        if (hm?.[1]) {
          const slug = hm[1];
          return (
            <a
              {...rest}
              href={href}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                  return;
                }
                e.preventDefault();
                onSamePageHeadingClick(slug);
              }}
            >
              {children}
            </a>
          );
        }
      }
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    };

    const ImgOverride = currentNote
      ? (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
          <WpnVfsImage {...props} currentNote={currentNote} />
        )
      : undefined;

    const base: Record<string, unknown> = {
      h1: make("h1"),
      h2: make("h2"),
      h3: make("h3"),
      h4: make("h4"),
      h5: make("h5"),
      h6: make("h6"),
      a: InternalOrExternalLink,
    };
    if (ImgOverride) {
      base.img = ImgOverride;
    }

    return base;
  }, [onInternalNoteNavigate, onArchonCmdLink, onSamePageHeadingClick, onWelcomeShellSegmentClick, isLinkTargetValid, currentNote]);

  return { components, mdxComponents: components as unknown as MDXComponents };
}
