import React from "react";
import type { ShellViewComponentProps } from "../../../views/ShellViewRegistry";
import { adminSelectionStore } from "./adminSelectionStore";

const wrap = "flex h-full min-h-0 flex-col gap-3 p-3 text-[12px]";
const card = "rounded-md border border-border bg-background p-3";
const title = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const row = "flex items-baseline justify-between gap-2 py-1";
const label = "text-[11px] text-muted-foreground";
const value = "text-foreground/90";
const muted = "text-xs text-muted-foreground";

export function AdminCompanionView(
  _props: ShellViewComponentProps,
): React.ReactElement {
  const state = React.useSyncExternalStore(
    (cb) => adminSelectionStore.subscribe(cb),
    () => adminSelectionStore.get(),
    () => adminSelectionStore.get(),
  );
  const { selection, companionFocus: focus } = state;

  if (focus.kind === "none") {
    return (
      <div className={wrap}>
        <header>
          <h3 className={title}>Details</h3>
        </header>
        <div className={card}>
          <p className={muted}>
            {selection.kind === "none"
              ? "Select something in the sidebar to get started."
              : "Pick a row in the main panel to see details here."}
          </p>
        </div>
      </div>
    );
  }

  if (focus.kind === "org-member" || focus.kind === "space-member") {
    return (
      <div className={wrap}>
        <header>
          <h3 className={title}>
            {focus.kind === "org-member" ? "Organization member" : "Space member"}
          </h3>
        </header>
        <div className={card}>
          <div className={row}>
            <span className={label}>User id</span>
            <span className={`${value} font-mono text-[11px]`}>{focus.userId}</span>
          </div>
          {focus.displayName ? (
            <div className={row}>
              <span className={label}>Name</span>
              <span className={value}>{focus.displayName}</span>
            </div>
          ) : null}
          {focus.role ? (
            <div className={row}>
              <span className={label}>Role</span>
              <span className={value}>{focus.role}</span>
            </div>
          ) : null}
          {focus.kind === "space-member" ? (
            <div className={row}>
              <span className={label}>Space</span>
              <span className={`${value} font-mono text-[11px]`}>
                {focus.spaceId}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (focus.kind === "share") {
    return (
      <div className={wrap}>
        <header>
          <h3 className={title}>
            {focus.resourceKind === "workspace" ? "Workspace share" : "Project share"}
          </h3>
        </header>
        <div className={card}>
          <div className={row}>
            <span className={label}>Resource id</span>
            <span className={`${value} font-mono text-[11px]`}>
              {focus.resourceId}
            </span>
          </div>
          <div className={row}>
            <span className={label}>User id</span>
            <span className={`${value} font-mono text-[11px]`}>{focus.userId}</span>
          </div>
          {focus.role ? (
            <div className={row}>
              <span className={label}>Role</span>
              <span className={value}>{focus.role}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const _exhaustive: never = focus;
  return <div className={wrap} />;
}
