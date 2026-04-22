import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Plan 04: pan + zoom surface wrapping the `<img>` rendered by
 * {@link ImageNoteEditor}. Single CSS transform on an inner wrapper;
 * `pointerdown/move/up` drives pan; `wheel` drives zoom anchored on
 * the cursor. Does not `preventDefault` on Ctrl/Cmd + wheel so browser
 * page-zoom continues to work; treats trackpad pinch (W3C's
 * `wheel` + `ctrlKey` quirk) as in-viewer zoom.
 *
 * Clamped to `[fitScale, 8 × fitScale]`. Snaps back to fit when
 * released within 5 % of fit.
 */

const MAX_ZOOM_MULTIPLIER = 8;
const SNAP_TO_FIT_RATIO = 0.05;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const KEY_ZOOM_STEP = 1.2;

type Transform = { scale: number; tx: number; ty: number };

export function computeCursorAnchoredTransform(
  prev: Transform,
  cursorX: number,
  cursorY: number,
  newScale: number,
): Transform {
  const { scale, tx, ty } = prev;
  const ratio = newScale / scale;
  return {
    scale: newScale,
    tx: cursorX + (tx - cursorX) * ratio,
    ty: cursorY + (ty - cursorY) * ratio,
  };
}

export function clampScale(
  requested: number,
  fitScale: number,
): number {
  const lo = fitScale;
  const hi = fitScale * MAX_ZOOM_MULTIPLIER;
  return Math.max(lo, Math.min(hi, requested));
}

export function shouldSnapToFit(
  scale: number,
  fitScale: number,
): boolean {
  if (scale >= fitScale * MAX_ZOOM_MULTIPLIER) return false;
  return Math.abs(scale - fitScale) / fitScale < SNAP_TO_FIT_RATIO;
}

function computeFitScale(
  containerW: number,
  containerH: number,
  imgW: number,
  imgH: number,
): number {
  if (imgW <= 0 || imgH <= 0 || containerW <= 0 || containerH <= 0) return 1;
  return Math.min(containerW / imgW, containerH / imgH, 1);
}

export function ImageViewerSurface({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [transform, setTransform] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const panState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  const applyFit = useCallback(
    (imgW: number, imgH: number) => {
      const el = containerRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const s = computeFitScale(width, height, imgW, imgH);
      setFitScale(s);
      setTransform({
        scale: s,
        tx: (width - imgW * s) / 2,
        ty: (height - imgH * s) / 2,
      });
    },
    [],
  );

  const handleLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w <= 0 || h <= 0) return;
    setImgSize({ w, h });
    applyFit(w, h);
  }, [applyFit]);

  useLayoutEffect(() => {
    if (!imgSize) return;
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      applyFit(imgSize.w, imgSize.h);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [imgSize, applyFit]);

  const zoomAt = useCallback(
    (cursorX: number, cursorY: number, requestedScale: number) => {
      setTransform((prev) => {
        const clamped = clampScale(requestedScale, fitScale);
        return computeCursorAnchoredTransform(prev, cursorX, cursorY, clamped);
      });
    },
    [fitScale],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // Keyboard Ctrl/Cmd + wheel = browser page-zoom; let it through.
      // Trackpad pinch also arrives as wheel + ctrlKey but with very
      // small deltaY at deltaMode=0. Treat large ctrlKey deltas as
      // browser zoom (pass-through); small ones as pinch (consume).
      const isKeyboardPageZoom =
        (e.ctrlKey || e.metaKey) &&
        (e.deltaMode !== 0 || Math.abs(e.deltaY) > 40);
      if (isKeyboardPageZoom) {
        return;
      }
      e.preventDefault();
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      setTransform((prev) => {
        const clamped = clampScale(prev.scale * factor, fitScale);
        return computeCursorAnchoredTransform(prev, e.clientX - rect.left, e.clientY - rect.top, clamped);
      });
    },
    [fitScale],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    panState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTx: transform.tx,
      startTy: transform.ty,
    };
  }, [transform.tx, transform.ty]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = panState.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    setTransform((prev) => ({ ...prev, tx: p.startTx + dx, ty: p.startTy + dy }));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = panState.current;
    if (!p || p.pointerId !== e.pointerId) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture?.(e.pointerId);
    panState.current = null;
    // Snap-to-fit on release.
    setTransform((prev) => {
      if (!shouldSnapToFit(prev.scale, fitScale)) return prev;
      if (!imgSize) return prev;
      const el = containerRef.current;
      if (!el) return prev;
      const { width, height } = el.getBoundingClientRect();
      return {
        scale: fitScale,
        tx: (width - imgSize.w * fitScale) / 2,
        ty: (height - imgSize.h * fitScale) / 2,
      };
    });
  }, [fitScale, imgSize]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!imgSize) return;
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const cx = width / 2;
    const cy = height / 2;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAt(cx, cy, transform.scale * KEY_ZOOM_STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomAt(cx, cy, transform.scale / KEY_ZOOM_STEP);
    } else if (e.key === "0") {
      e.preventDefault();
      applyFit(imgSize.w, imgSize.h);
    }
  }, [applyFit, imgSize, transform.scale, zoomAt]);

  const fitNow = useCallback(() => {
    if (imgSize) applyFit(imgSize.w, imgSize.h);
  }, [applyFit, imgSize]);

  const oneToOne = useCallback(() => {
    if (!imgSize) return;
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setTransform({
      scale: 1,
      tx: (width - imgSize.w) / 2,
      ty: (height - imgSize.h) / 2,
    });
  }, [imgSize]);

  useEffect(() => {
    // Focus the surface on mount so keyboard shortcuts work without an
    // explicit click first.
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="relative h-full w-full bg-muted/20">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden outline-none"
        role="application"
        aria-label={`Image viewer: ${alt}`}
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        style={{ cursor: panState.current ? "grabbing" : "grab", touchAction: "none" }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          onLoad={handleLoad}
          draggable={false}
          style={{
            transform: `translate3d(${transform.tx}px, ${transform.ty}px, 0) scale(${transform.scale})`,
            transformOrigin: "0 0",
            userSelect: "none",
            pointerEvents: "none",
            maxWidth: "none",
            maxHeight: "none",
          }}
        />
      </div>
      <div className="pointer-events-none absolute bottom-2 right-2 flex gap-1">
        <button
          type="button"
          className="pointer-events-auto rounded-sm border border-border bg-background/80 px-2 py-0.5 text-[11px] hover:bg-muted"
          onClick={fitNow}
          title="Fit to view (F)"
        >
          Fit
        </button>
        <button
          type="button"
          className="pointer-events-auto rounded-sm border border-border bg-background/80 px-2 py-0.5 text-[11px] hover:bg-muted"
          onClick={oneToOne}
          title="Actual size (1:1)"
        >
          1:1
        </button>
        <span className="pointer-events-auto rounded-sm border border-border bg-background/80 px-2 py-0.5 text-[11px] tabular-nums">
          {Math.round((transform.scale / (fitScale || 1)) * 100)}%
        </span>
      </div>
    </div>
  );
}
