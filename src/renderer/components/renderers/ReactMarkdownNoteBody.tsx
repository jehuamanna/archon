import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Note } from "@archon/ui-types";
import type { WelcomeShellUrlSegment } from "../../shell/shellWelcomeUrlRoutes";
import type { InternalMarkdownNoteLink } from "../../utils/markdown-internal-note-href";
import {
  markdownShellClass,
  useArchonMarkdownUiComponents,
} from "./useArchonMarkdownUiComponents";

export interface MarkdownRendererProps {
  note: Note;
  onSamePageHeadingClick?: (slug: string) => void;
  onInternalNoteNavigate?: (link: InternalMarkdownNoteLink) => void;
  onArchonCmdLink?: (commandId: string) => void;
  onWelcomeShellSegmentClick?: (segment: "" | WelcomeShellUrlSegment) => void;
  /** When provided, internal note links whose target is invalid render with broken-link styling. */
  isLinkTargetValid?: (link: InternalMarkdownNoteLink) => boolean;
}

/**
 * Plain markdown body (react-markdown). Shared with MDX doc embeds for non-MDX notes.
 */
export function ReactMarkdownNoteBody({
  note,
  onSamePageHeadingClick,
  onInternalNoteNavigate,
  onArchonCmdLink,
  onWelcomeShellSegmentClick,
  isLinkTargetValid,
}: MarkdownRendererProps): React.ReactElement {
  const rehypeSanitizeSchema = useMemo(() => {
    if (!onArchonCmdLink) return defaultSchema;
    const hrefProtocols = [...(defaultSchema.protocols?.href ?? []), "archon-cmd"];
    return {
      ...defaultSchema,
      protocols: {
        ...defaultSchema.protocols,
        href: hrefProtocols,
      },
    };
  }, [onArchonCmdLink]);

  const { components } = useArchonMarkdownUiComponents({
    onSamePageHeadingClick,
    onInternalNoteNavigate,
    onArchonCmdLink,
    onWelcomeShellSegmentClick,
    isLinkTargetValid,
    currentNote: note,
  });

  return (
    <div className={`p-4 archon-typography max-w-none min-w-0 ${markdownShellClass}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, rehypeSanitizeSchema]]}
        components={components}
      >
        {note.content}
      </ReactMarkdown>
    </div>
  );
}
