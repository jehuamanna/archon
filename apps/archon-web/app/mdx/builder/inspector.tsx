"use client";

import * as React from "react";
import { PROP_SPECS } from "@archon/mdx-sdk";
import type { BuilderNode, EditableNode } from "./ast.js";

export interface InspectorProps {
  selected: BuilderNode | null;
  onUpdateProps: (id: string, props: EditableNode["props"]) => void;
  /** All state keys used by other notes in this project — for collision lint. */
  usedKeys: Array<{ key: string; noteTitle: string }>;
}

export function Inspector(props: InspectorProps): React.ReactElement {
  const node = props.selected;
  return (
    <aside
      aria-label="Inspector"
      style={{
        borderLeft: "1px solid #e4e4e7",
        padding: 12,
        minWidth: 220,
        fontFamily: "system-ui,sans-serif",
        fontSize: 13,
      }}
    >
      {!node && <div style={{ color: "#71717a" }}>Select an element.</div>}
      {node?.kind === "advanced" && (
        <div>
          <div style={{ fontWeight: 600 }}>Advanced node</div>
          <pre
            style={{
              background: "#f4f4f5",
              padding: 8,
              borderRadius: 4,
              overflow: "auto",
              fontSize: 11,
            }}
          >
            {node.source}
          </pre>
          <p style={{ color: "#71717a" }}>
            Not editable in the inspector — open Code view to edit.
          </p>
        </div>
      )}
      {node?.kind === "markdown" && (
        <div>
          <div style={{ fontWeight: 600 }}>Markdown</div>
          <textarea
            defaultValue={node.source}
            style={{ width: "100%", minHeight: 120, fontFamily: "ui-monospace,monospace" }}
            readOnly
          />
        </div>
      )}
      {node?.kind === "editable" && (
        <EditableInspector
          node={node}
          onUpdate={(nextProps) => props.onUpdateProps(node.id, nextProps)}
          usedKeys={props.usedKeys}
        />
      )}
    </aside>
  );
}

function EditableInspector(p: {
  node: EditableNode;
  onUpdate: (next: EditableNode["props"]) => void;
  usedKeys: Array<{ key: string; noteTitle: string }>;
}): React.ReactElement {
  const spec = PROP_SPECS[p.node.component];
  if (!spec) {
    return <div>Unknown component: {p.node.component}</div>;
  }
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.node.component}</div>
      {Object.entries(spec).map(([propName, propSpec]) => {
        const raw = p.node.props[propName];
        const valueStr =
          raw === undefined || raw === null
            ? ""
            : typeof raw === "boolean"
              ? raw.toString()
              : String(raw);
        const setValue = (next: string): void => {
          let parsed: string | number | boolean | null = next;
          if (propSpec.type === "number") parsed = next === "" ? 0 : Number(next);
          else if (propSpec.type === "boolean")
            parsed = next === "true" ? true : next === "false" ? false : next;
          p.onUpdate({ ...p.node.props, [propName]: parsed });
        };
        const collision =
          propSpec.type === "stateKey" && typeof raw === "string"
            ? p.usedKeys.find((u) => u.key === raw)
            : null;
        return (
          <div key={propName} style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 11, color: "#71717a" }}>
              {propName}
              {propSpec.required ? " *" : ""}
              {propSpec.semantic ? ` — ${propSpec.semantic}` : ""}
            </label>
            <input
              type={propSpec.type === "number" ? "number" : "text"}
              value={valueStr}
              onChange={(e) => setValue(e.target.value)}
              style={{
                width: "100%",
                padding: 4,
                border: "1px solid #e4e4e7",
                borderRadius: 3,
              }}
            />
            {collision && (
              <div style={{ color: "#b45309", fontSize: 11, marginTop: 2 }}>
                ⚠ key <code>{collision.key}</code> also used by note{" "}
                <em>{collision.noteTitle}</em>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
