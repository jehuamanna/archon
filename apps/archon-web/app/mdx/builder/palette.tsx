"use client";

import * as React from "react";
import { EDITABLE_TAGS } from "./ast.js";

export interface PaletteProps {
  onPick: (component: string) => void;
}

const GROUPS: Array<{ label: string; items: string[] }> = [
  { label: "Form", items: ["Input", "Select", "Checkbox", "Button", "PushButton", "Form"] },
  { label: "Display", items: ["Value", "List", "Table", "Chart", "NoteEmbed", "Markdown"] },
];

export function Palette({ onPick }: PaletteProps): React.ReactElement {
  return (
    <aside
      aria-label="Component palette"
      style={{
        borderRight: "1px solid #e4e4e7",
        padding: 12,
        minWidth: 180,
        fontFamily: "system-ui,sans-serif",
        fontSize: 13,
      }}
    >
      {GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 16 }}>
          <div style={{ textTransform: "uppercase", color: "#71717a", fontSize: 11 }}>
            {group.label}
          </div>
          {group.items
            .filter((c) => EDITABLE_TAGS.has(c))
            .map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onPick(c)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  margin: "4px 0",
                  background: "#fafafa",
                  border: "1px solid #e4e4e7",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {c}
              </button>
            ))}
        </div>
      ))}
    </aside>
  );
}
