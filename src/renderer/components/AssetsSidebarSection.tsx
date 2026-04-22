import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useState } from "react";

const ASSETS_EXPANDED_KEY = "archon.assetsSidebarExpanded";

function readStoredExpanded(): boolean {
  try {
    return localStorage.getItem(ASSETS_EXPANDED_KEY) !== "0";
  } catch {
    return true;
  }
}

type Props = {
  /** When this changes (e.g. new project), browsing resets to the assets root. */
  projectRoot: string;
  onOpenFile: (relativePath: string) => void;
};

export default function AssetsSidebarSection({
  projectRoot,
  onOpenFile,
}: Props) {
  const [expanded, setExpanded] = useState(readStoredExpanded);
  const [relDir, setRelDir] = useState("");
  const [entries, setEntries] = useState<
    { name: string; isDirectory: boolean }[]
  >([]);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setRelDir("");
  }, [projectRoot]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await getArchon().listAssets(relDir, projectRoot);
      if (cancelled) {
        return;
      }
      if (!r.ok) {
        setErr(r.error);
        setEntries([]);
        return;
      }
      setErr(null);
      setEntries(r.entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [relDir, projectRoot, tick]);

  useEffect(() => {
    try {
      localStorage.setItem(ASSETS_EXPANDED_KEY, expanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [expanded]);

  const pathJoin = (dir: string, name: string) =>
    dir ? `${dir}/${name}` : name;

  const goUp = () => {
    if (!relDir) {
      return;
    }
    const i = relDir.lastIndexOf("/");
    setRelDir(i === -1 ? "" : relDir.slice(0, i));
  };

  return (
    <div
      style={expanded ? { minHeight: 140 } : undefined}
      className={
        expanded
          ? "flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border bg-sidebar/25"
          : "flex shrink-0 flex-col overflow-hidden border-t border-border bg-sidebar/25"
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-sidebar-accent/40"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-controls="archon-assets-file-list"
          id="archon-assets-section-label"
        >
          <span
            className="w-4 shrink-0 text-center text-[10px] text-muted-foreground"
            aria-hidden
          >
            {expanded ? "▾" : "▸"}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Assets
            </span>
            <span
              className="truncate font-normal normal-case text-[10px] text-muted-foreground/80"
              title={projectRoot}
            >
              {projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? projectRoot}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-foreground/80 hover:bg-sidebar-accent"
          onClick={() => setTick((t) => t + 1)}
        >
          Refresh
        </button>
      </div>
      {expanded ? (
        <div
          id="archon-assets-file-list"
          role="region"
          aria-labelledby="archon-assets-section-label"
          className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
        >
          {relDir ? (
            <button
              type="button"
              className="mb-1 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-sidebar-accent/50"
              onClick={goUp}
            >
              <span className="opacity-70">↑</span> ..
            </button>
          ) : null}
          {err ? (
            <div className="px-2 py-1 text-[11px] text-foreground/85">{err}</div>
          ) : entries.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              Empty folder
            </div>
          ) : (
            <ul className="space-y-0.5">
              {entries.map((e) => (
                <li key={e.name}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-sidebar-accent/60"
                    onClick={() => {
                      const p = pathJoin(relDir, e.name);
                      if (e.isDirectory) {
                        setRelDir(p);
                      } else {
                        onOpenFile(p);
                      }
                    }}
                  >
                    <span className="w-4 shrink-0 text-center text-[10px] text-muted-foreground">
                      {e.isDirectory ? "▸" : "·"}
                    </span>
                    <span className="min-w-0 truncate">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
