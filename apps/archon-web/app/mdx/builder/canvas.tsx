"use client";

import * as React from "react";
import type { BuilderNode } from "./ast.js";

export interface CanvasProps {
  nodes: BuilderNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
}

export function Canvas(props: CanvasProps): React.ReactElement {
  const [dragIdx, setDragIdx] = React.useState<number | null>(null);
  return (
    <div
      role="list"
      aria-label="Canvas"
      onClick={() => props.onSelect(null)}
      style={{
        flex: 1,
        padding: 12,
        overflowY: "auto",
        fontFamily: "system-ui,sans-serif",
        fontSize: 13,
        minWidth: 360,
      }}
    >
      {props.nodes.map((node, idx) => (
        <div
          key={node.id}
          role="listitem"
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setDragIdx(idx);
          }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dragIdx !== null && dragIdx !== idx) {
              props.onReorder(dragIdx, idx);
            }
            setDragIdx(null);
          }}
          onClick={(e) => {
            e.stopPropagation();
            props.onSelect(node.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              props.onDelete(node.id);
            }
          }}
          tabIndex={0}
          aria-selected={props.selectedId === node.id}
          style={{
            padding: 8,
            margin: "6px 0",
            border:
              props.selectedId === node.id
                ? "2px solid #3b82f6"
                : "1px solid #e4e4e7",
            borderRadius: 4,
            background:
              node.kind === "advanced"
                ? "#f4f4f5"
                : node.kind === "markdown"
                  ? "#fffbeb"
                  : "white",
            cursor: "pointer",
          }}
        >
          {node.kind === "editable" && (
            <div>
              <strong>{node.component}</strong>
              <pre
                style={{
                  margin: 0,
                  fontSize: 11,
                  fontFamily: "ui-monospace,monospace",
                }}
              >
                {JSON.stringify(node.props, null, 0)}
              </pre>
            </div>
          )}
          {node.kind === "advanced" && (
            <div style={{ color: "#52525b", fontFamily: "ui-monospace,monospace" }}>
              <em>advanced:</em> {node.preview}
            </div>
          )}
          {node.kind === "markdown" && (
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                fontFamily: "system-ui,sans-serif",
              }}
            >
              {node.source.trim() || "(empty)"}
            </pre>
          )}
        </div>
      ))}
      {props.nodes.length === 0 && (
        <div style={{ color: "#71717a", padding: 24, textAlign: "center" }}>
          Drop components from the palette.
        </div>
      )}
    </div>
  );
}
