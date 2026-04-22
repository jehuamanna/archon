import { getArchon } from "../../shared/archon-host-access";
import React, { useEffect, useMemo, useState } from "react";
import {
  extMatchesCategory,
  type AssetMediaCategory,
} from "../../shared/asset-media";
import PdfAssetPreview from "./PdfAssetPreview";

type Props = {
  relativePath: string;
  /** Which workspace project’s `assets/` tree (required when multiple folders are open). */
  projectRoot: string;
};

function categoryFromExt(ext: string): AssetMediaCategory | null {
  const e = ext.toLowerCase();
  if (extMatchesCategory(e, "pdf")) {
    return "pdf";
  }
  if (extMatchesCategory(e, "image")) {
    return "image";
  }
  if (extMatchesCategory(e, "video")) {
    return "video";
  }
  if (extMatchesCategory(e, "audio")) {
    return "audio";
  }
  return null;
}

export default function AssetPreview({ relativePath, projectRoot }: Props) {
  const [info, setInfo] = useState<{
    name: string;
    ext: string;
    size: number;
    relativePath: string;
  } | null>(null);
  const [loadDone, setLoadDone] = useState(false);
  const [textBody, setTextBody] = useState<string | null>(null);
  const [textErr, setTextErr] = useState<string | null>(null);

  const mediaCategory = useMemo(() => {
    if (!info) {
      return null;
    }
    return categoryFromExt(info.ext);
  }, [info]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setLoadDone(false);
    setTextBody(null);
    setTextErr(null);
    void (async () => {
      const meta = await getArchon().getAssetInfo(relativePath, projectRoot);
      if (cancelled) {
        return;
      }
      setInfo(meta);
      if (!meta) {
        setLoadDone(true);
        return;
      }
      const cat = categoryFromExt(meta.ext);
      if (cat) {
        setLoadDone(true);
        return;
      }
      const tr = await getArchon().readAssetText(relativePath, projectRoot);
      if (cancelled) {
        return;
      }
      if (tr.ok) {
        setTextBody(tr.text);
      } else {
        setTextErr(tr.error);
      }
      setLoadDone(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [relativePath, projectRoot]);

  const openExternal = () => {
    void getArchon().openAssetExternal(relativePath, projectRoot);
  };

  if (!loadDone) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
        <p className="text-[12px] text-muted-foreground">Asset not found.</p>
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-[12px] hover:bg-muted/60"
          onClick={openExternal}
        >
          Try open externally
        </button>
      </div>
    );
  }

  const assetSrc = getArchon().assetUrl(relativePath, projectRoot);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{info.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            assets/{info.relativePath}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-[12px] hover:bg-muted/60"
          onClick={openExternal}
        >
          Open externally
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {mediaCategory === "image" ? (
          <div className="flex h-full min-h-[200px] items-center justify-center">
            <img
              src={assetSrc}
              alt={info.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : mediaCategory === "pdf" ? (
          <div className="h-full min-h-[420px] w-full overflow-auto">
            <PdfAssetPreview assetSrc={assetSrc} />
          </div>
        ) : mediaCategory === "video" ? (
          <div className="flex justify-center">
            <video
              src={assetSrc}
              controls
              className="max-h-[min(100%,calc(100vh-12rem))] max-w-full rounded-md"
            />
          </div>
        ) : mediaCategory === "audio" ? (
          <div className="flex flex-col items-center justify-center gap-4 py-8">
            <audio src={assetSrc} controls className="w-full max-w-md" />
          </div>
        ) : textBody !== null ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">
            {textBody}
          </pre>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="max-w-md text-[12px] text-muted-foreground">
              {textErr
                ? textErr
                : "No built-in preview for this type. Open it in your default app."}
            </p>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-[12px] hover:bg-muted/60"
              onClick={openExternal}
            >
              Open externally
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
