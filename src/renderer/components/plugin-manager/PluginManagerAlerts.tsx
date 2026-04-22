import React from "react";
import type { UserMessage } from "./plugin-manager-types";

type Props = {
  message: UserMessage;
  loadIssues: { folder: string; error: string }[];
  showProgress: boolean;
  progressLines: string[];
  onToggleProgress: () => void;
};

export function PluginManagerAlerts({
  message,
  loadIssues,
  showProgress,
  progressLines,
  onToggleProgress,
}: Props): React.ReactElement {
  return (
    <>
      {message && (
        <div
          className={`mb-4 p-4 rounded-lg whitespace-pre-wrap border border-border ${
            message.type === "success"
              ? "bg-muted/50 text-foreground"
              : message.type === "info"
                ? "bg-muted/40 text-foreground"
                : "bg-muted/70 text-foreground"
          }`}
        >
          {message.text}
        </div>
      )}

      {loadIssues.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-muted/50 p-4">
          <p className="mb-2 font-medium text-foreground">
            Plugin load / validation issues
          </p>
          <ul className="space-y-1 text-sm text-foreground/90">
            {loadIssues.map((row) => (
              <li key={row.folder}>
                <strong>{row.folder}</strong>: {row.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4">
        <button
          type="button"
          onClick={onToggleProgress}
          className="mr-4 text-sm text-foreground underline underline-offset-2"
        >
          {showProgress ? "Hide" : "Show"} operation log (
          {progressLines.length} lines)
        </button>
        {showProgress && (
          <div className="mt-2 max-h-48 overflow-auto rounded border border-border bg-card p-2 font-mono text-xs text-card-foreground">
            {progressLines.length === 0 ? (
              <span className="text-muted-foreground">No events yet.</span>
            ) : (
              progressLines.map((line, i) => <div key={i}>{line}</div>)
            )}
          </div>
        )}
      </div>
    </>
  );
}
