import React from "react";
import { shouldRenderMdx } from "../../utils/note-mdx-format";
import { MdxRenderer } from "./MdxRenderer";
import { ReactMarkdownNoteBody, type MarkdownRendererProps } from "./ReactMarkdownNoteBody";

export type { MarkdownRendererProps };

/**
 * Renders markdown or MDX note content (MDX when type/metadata/sourceFile indicates MDX).
 */
const MarkdownRenderer: React.FC<MarkdownRendererProps> = (props) => {
  const { note } = props;
  if (shouldRenderMdx(note)) {
    return <MdxRenderer {...props} />;
  }
  return <ReactMarkdownNoteBody {...props} />;
};

export default MarkdownRenderer;
