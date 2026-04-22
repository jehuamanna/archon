/** MCP tool handler return shape (subset of CallToolResult). */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolReturn = {
  content: ToolContentBlock[];
  isError?: boolean;
};

export function jsonResult(obj: unknown): ToolReturn {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(obj, null, 2),
      },
    ],
  };
}

export function errorResult(message: string): ToolReturn {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/** Metadata JSON block followed by a native MCP image block. */
export function imageAndJsonResult(
  meta: unknown,
  image: { data: string; mimeType: string },
): ToolReturn {
  return {
    content: [
      { type: "text", text: JSON.stringify(meta, null, 2) },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
  };
}
