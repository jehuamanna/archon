import React, { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  OutputScale,
  RenderingCancelledException,
  TextLayer,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import { PDFJS_GET_DOCUMENT_BASE } from "../../shared/pdfjs-document-options";
import { PDFJS_TEXT_LAYER_INLINE_CSS } from "../../shared/pdfjs-text-layer-inline-css";
import { ARCHON_PDF_WORKER_PROTOCOL_URL } from "../../shared/archon-pdf-worker-url";

let workerConfigured = false;

function ensurePdfWorker(): void {
  if (workerConfigured || typeof document === "undefined") {
    return;
  }
  workerConfigured = true;
  // Prefer the app-served pdf.js worker URL (works in packaged builds where `app.asar` streaming can break).
  GlobalWorkerOptions.workerSrc = ARCHON_PDF_WORKER_PROTOCOL_URL;
}

type Props = {
  assetSrc: string;
};

const PREVIEW_PAGE_SCALE = 1.35;

/**
 * Renders PDF with pdf.js (canvas + text layer + CMaps). Avoids Chromium’s built-in PDF extension.
 */
export default function PdfAssetPreview({ assetSrc }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  useEffect(() => {
    ensurePdfWorker();
    let cancelled = false;

    setLoading(true);
    setErr(null);
    setPdf(null);

    void (async () => {
      try {
        const res = await fetch(assetSrc);
        if (!res.ok) {
          throw new Error(`Could not load PDF (${res.status})`);
        }
        const buf = await res.arrayBuffer();
        const task = getDocument({
          data: new Uint8Array(buf),
          ...PDFJS_GET_DOCUMENT_BASE,
        });
        const loaded = await task.promise;
        if (cancelled) {
          await loaded.destroy();
          return;
        }
        docRef.current = loaded;
        setPdf(loaded);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Failed to load PDF");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      const d = docRef.current;
      docRef.current = null;
      void d?.destroy().catch(() => {
        /* ignore */
      });
    };
  }, [assetSrc]);

  if (err) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-[12px] text-destructive">
        {err}
      </div>
    );
  }

  if (loading || !pdf) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-[12px] text-muted-foreground">
        Loading PDF…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <style dangerouslySetInnerHTML={{ __html: PDFJS_TEXT_LAYER_INLINE_CSS }} />
      {Array.from({ length: pdf.numPages }, (_, i) => (
        <PdfPage key={i + 1} pdf={pdf} pageNumber={i + 1} />
      ))}
    </div>
  );
}

function PdfPage({
  pdf,
  pageNumber,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageBoxRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const textLayerInstRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const page = await pdf.getPage(pageNumber);
      const canvas = canvasRef.current;
      const textLayerDiv = textLayerRef.current;
      const pageBox = pageBoxRef.current;
      if (!canvas || !textLayerDiv || !pageBox || cancelled) {
        return;
      }

      const viewport = page.getViewport({ scale: PREVIEW_PAGE_SCALE });
      const outputScale = new OutputScale();
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) {
        return;
      }

      const w = viewport.width;
      const h = viewport.height;
      const sx = outputScale.sx;
      const sy = outputScale.sy;
      canvas.width = Math.floor(w * sx);
      canvas.height = Math.floor(h * sy);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      pageBox.style.width = `${w}px`;
      pageBox.style.height = `${h}px`;
      pageBox.style.setProperty("--scale-factor", String(viewport.scale));

      const transform: number[] | undefined = outputScale.scaled
        ? [sx, 0, 0, sy, 0, 0]
        : undefined;

      textLayerDiv.innerHTML = "";
      textLayerInstRef.current?.cancel?.();
      textLayerInstRef.current = null;

      renderTaskRef.current?.cancel?.();
      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        ...(transform !== undefined ? { transform } : {}),
      });
      renderTaskRef.current = renderTask;

      try {
        await renderTask.promise;
      } catch (e) {
        if (e instanceof RenderingCancelledException) {
          return;
        }
        console.error("[PdfAssetPreview] canvas render", pageNumber, e);
        return;
      } finally {
        if (renderTaskRef.current === renderTask) {
          renderTaskRef.current = null;
        }
      }

      if (cancelled) {
        return;
      }

      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        }),
        container: textLayerDiv,
        viewport,
      });
      textLayerInstRef.current = textLayer;

      try {
        await textLayer.render();
      } catch (e: unknown) {
        const name =
          e && typeof e === "object" && "name" in e
            ? String((e as Error).name)
            : "";
        if (name === "AbortException" || name === "RenderingCancelledException") {
          return;
        }
        console.error("[PdfAssetPreview] text layer", pageNumber, e);
      }
    };

    void run();

    return () => {
      cancelled = true;
      try {
        renderTaskRef.current?.cancel?.();
      } catch {
        /* ignore */
      }
      renderTaskRef.current = null;
      try {
        textLayerInstRef.current?.cancel?.();
      } catch {
        /* ignore */
      }
      textLayerInstRef.current = null;
    };
  }, [pdf, pageNumber]);

  return (
    <div className="archon-pdf-pageRoot flex justify-center overflow-auto">
      <div ref={pageBoxRef} className="relative">
        <canvas
          ref={canvasRef}
          className="rounded border border-border shadow-sm"
        />
        <div ref={textLayerRef} className="textLayer" />
      </div>
    </div>
  );
}
