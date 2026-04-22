import React, { useEffect } from "react";
import { useArchonContributionRegistry } from "../ArchonContributionContext";
import { useShellViewRegistry } from "./ShellViewContext";
import type { ShellRegionId } from "./ShellViewRegistry";

/** Accepts legacy `secondaryArea` from saved command args / older docs. */
function normalizeShellRegionId(raw: string): ShellRegionId | undefined {
  if (raw === "secondaryArea") return "companion";
  if (
    raw === "primarySidebar" ||
    raw === "mainArea" ||
    raw === "companion" ||
    raw === "bottomArea"
  ) {
    return raw;
  }
  return undefined;
}

/**
 * Registers shell view commands that need access to the view registry.
 * Keeps `registerArchonCoreContributions` pure and non-React.
 */
export function ShellViewCommandContributions(): null {
  const commands = useArchonContributionRegistry();
  const views = useShellViewRegistry();

  useEffect(() => {
    const disposers: Array<() => void> = [];

    disposers.push(
      commands.registerCommand({
        id: "archon.shell.views.list",
        title: "Shell: List registered views (log)",
        category: "Shell",
        doc: "Logs registered shell views to the console.",
        api: {
          summary: "Log every ShellViewDescriptor to the devtools console.",
          args: [],
          exampleInvoke: {},
          returns: { type: "void", description: "Writes to console.info." },
        },
        handler: () => {
          // eslint-disable-next-line no-console
          console.info("[Archon] Shell views:", views.listViews());
        },
      }),
    );

    disposers.push(
      commands.registerCommand({
        id: "archon.shell.openView",
        title: "Shell: Open view…",
        category: "Shell",
        doc: "Open a view by id. args: { viewId, regionId? }",
        api: {
          summary: "Mount a registered shell view in a layout region.",
          details:
            "regionId must be one of the ShellRegionId values; if omitted, the view descriptor defaultRegion is used.",
          args: [
            {
              name: "viewId",
              type: "string",
              required: true,
              description: "Registered view id (see archon.shell.views.list).",
            },
            {
              name: "regionId",
              type: "ShellRegionId",
              required: false,
              description: "Target region; omit to use the view's defaultRegion.",
              schema: {
                type: "string",
                enum: ["primarySidebar", "mainArea", "companion", "bottomArea"],
              },
            },
          ],
          exampleInvoke: { viewId: "shell.welcome", regionId: "mainArea" },
          returns: { type: "void", description: "Updates ShellViewRegistry open state." },
        },
        handler: (args) => {
          const viewId = String(args?.viewId ?? "").trim();
          const regionIdRaw = String(args?.regionId ?? "").trim();
          if (!viewId) {
            throw new Error("Missing args.viewId");
          }
          const regionId = normalizeShellRegionId(regionIdRaw);
          views.openView(viewId, regionId);
        },
      }),
    );

    disposers.push(
      commands.registerCommand({
        id: "archon.shell.closeRegion",
        title: "Shell: Close region view…",
        category: "Shell",
        doc: "Close the currently open view in a region. args: { regionId }",
        api: {
          summary: "Clear the open view for a single layout region.",
          args: [
            {
              name: "regionId",
              type: "ShellRegionId",
              required: true,
              description: "Which region to clear.",
              schema: {
                type: "string",
                enum: ["primarySidebar", "mainArea", "companion", "bottomArea"],
              },
            },
          ],
          exampleInvoke: { regionId: "companion" },
          returns: { type: "void", description: "Removes region entry from ShellViewRegistry." },
        },
        handler: (args) => {
          const regionIdRaw = String(args?.regionId ?? "").trim();
          const regionId = normalizeShellRegionId(regionIdRaw);
          if (!regionId) {
            throw new Error("Invalid args.regionId");
          }
          views.closeRegion(regionId);
        },
      }),
    );

    return () => {
      for (const d of disposers) d();
    };
  }, [commands, views]);

  return null;
}

