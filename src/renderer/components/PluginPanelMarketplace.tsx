import { getArchon } from "../../shared/archon-host-access";
import React, { useCallback, useEffect, useState } from "react";
import type { MarketplaceListResponse } from "@archon/ui-types";
import { WebHeadlessApiMarketplaceSection } from "./WebHeadlessApiMarketplaceSection";

interface PluginPanelMarketplaceProps {
  onPluginsChanged?: () => void;
}

function webApiBase(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const b = window.__ARCHON_WEB_API_BASE__?.trim();
  return b ? b.replace(/\/$/, "") : undefined;
}

const PluginPanelMarketplace: React.FC<PluginPanelMarketplaceProps> = ({
  onPluginsChanged,
}) => {
  const [data, setData] = useState<MarketplaceListResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const refresh = useCallback(() => {
    setLoadErr(null);
    void getArchon()
      .listMarketplacePlugins()
      .then(setData)
      .catch((e) => {
        setData(null);
        setLoadErr(e instanceof Error ? e.message : "Failed to load marketplace");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    return getArchon().onPluginsChanged(refresh);
  }, [refresh]);

  const apiBase = webApiBase();
  const readmeHttpBase =
    Boolean(apiBase) &&
    Boolean(data?.filesBasePath && data.filesBasePath.length > 0);

  const handleInstall = async (packageFile: string) => {
    setInstalling(packageFile);
    setMessage(null);
    try {
      const r = await getArchon().installMarketplacePlugin(packageFile);
      if (!r.success) {
        setMessage({
          type: "error",
          text: r.error ?? "Install failed",
        });
        return;
      }
      const w =
        r.warnings?.length && r.warnings.length > 0
          ? `\nWarnings:\n${r.warnings.join("\n")}`
          : "";
      setMessage({ type: "success", text: `Installed ${packageFile}.${w}` });
      onPluginsChanged?.();
    } catch (e) {
      setMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Install failed",
      });
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto bg-background px-4 py-4 text-foreground">
      <header className="mb-4 border-b border-border pb-3">
        <h2 className="text-[13px] font-semibold">Market</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Local packages from{" "}
          <code className="rounded bg-muted px-1">dist/plugins</code> (run{" "}
          <code className="rounded bg-muted px-1">npm run build:plugins</code>
          ). In the browser, the Market tab connects to the same origin as the UI (via nginx/rewrites).
        </p>
      </header>

      <WebHeadlessApiMarketplaceSection />

      {data?.marketplaceDir ? (
        <p className="mb-3 break-all font-mono text-[10px] text-muted-foreground">
          {data.marketplaceDir}
        </p>
      ) : null}

      {loadErr ? (
        <div className="mb-3 rounded-lg border border-border bg-muted/50 p-3 text-[12px] text-foreground">
          {loadErr}
        </div>
      ) : null}

      {data?.indexError ? (
        <div className="mb-3 rounded-lg border border-border bg-muted/50 p-3 text-[12px] text-foreground">
          {data.indexError}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Run <code className="rounded bg-muted px-1">npm run build:plugins</code>{" "}
            to create <code className="rounded bg-muted px-1">marketplace-index.json</code>{" "}
            and plugin zips.
          </p>
        </div>
      ) : null}

      {message ? (
        <div
          className={`mb-3 rounded-lg border p-3 text-[12px] ${
            message.type === "success"
              ? "border-border bg-muted/40"
              : "border-border bg-muted/70"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {!data && !loadErr ? (
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      ) : null}

      {data && data.plugins.length === 0 && !data.indexError && !loadErr ? (
        <p className="text-[12px] text-muted-foreground">No marketplace plugins.</p>
      ) : null}

      <ul className="space-y-3">
        {data?.plugins.map((p) => {
          const title = p.displayName?.trim() || p.name;
          const mdUrl =
            readmeHttpBase && apiBase && data && p.markdownFile
              ? `${apiBase}${data.filesBasePath}/${encodeURIComponent(p.markdownFile)}`
              : null;
          return (
            <li
              key={`${p.name}-${p.version}-${p.packageFile}`}
              className="rounded-lg border border-border bg-muted/20 p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">{title}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {p.name} v{p.version}
                </span>
              </div>
              {p.description ? (
                <p className="mt-1 text-[11px] text-muted-foreground">{p.description}</p>
              ) : null}
              {p.readmeSnippet ? (
                <p className="mt-2 line-clamp-4 text-[11px] leading-snug text-foreground/90">
                  {p.readmeSnippet}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={installing !== null}
                  className="archon-btn-neutral rounded-md px-3 py-1.5 text-[12px] font-semibold"
                  onClick={() => void handleInstall(p.packageFile)}
                >
                  {installing === p.packageFile ? "Installing…" : "Install"}
                </button>
                {mdUrl ? (
                  <a
                    href={mdUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="archon-btn-neutral inline-flex rounded-md px-3 py-1.5 text-[12px] font-semibold no-underline"
                  >
                    View README
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PluginPanelMarketplace;
