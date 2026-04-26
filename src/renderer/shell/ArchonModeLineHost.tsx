import React, { useMemo } from "react";
import { useArchonModeLineSegment } from "./ArchonContributionContext";

function joinSegment(items: { text: string }[]): string {
  return items.map((i) => i.text).filter(Boolean).join(" · ");
}

/**
 * Thin shell view: renders stacked mode-line segments from the contribution registry.
 * Host segments use flex; plugin segments truncate with title tooltips.
 */
export function ArchonModeLineHost(): React.ReactElement {
  const left = useArchonModeLineSegment("host.left");
  const center = useArchonModeLineSegment("host.center");
  const right = useArchonModeLineSegment("host.right");
  const pluginPri = useArchonModeLineSegment("plugin.primary");
  const pluginSec = useArchonModeLineSegment("plugin.secondary");

  // Single-row mode line. Plugin segments fold into the right cluster after
  // host-right; the second row was visually noisy and rarely populated, so
  // we merge into one strip and let truncation handle overflow.
  const leftText = useMemo(() => joinSegment(left), [left]);
  const centerText = useMemo(
    () => [joinSegment(center), joinSegment(pluginPri)].filter(Boolean).join(" · "),
    [center, pluginPri],
  );
  const rightText = useMemo(
    () => [joinSegment(right), joinSegment(pluginSec)].filter(Boolean).join(" · "),
    [right, pluginSec],
  );

  return (
    <div
      className="archon-mode-line-host shrink-0 border-t border-border bg-muted/30 text-muted-foreground"
      data-testid="archon-mode-line"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-h-[22px] items-center gap-2 px-2 py-0.5 text-[11px] leading-tight">
        <span
          className="min-w-0 shrink truncate font-medium"
          title={leftText || undefined}
        >
          {leftText}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-center"
          title={centerText || undefined}
        >
          {centerText}
        </span>
        <span
          className="min-w-0 shrink truncate text-right tabular-nums"
          title={rightText || undefined}
        >
          {rightText}
        </span>
      </div>
    </div>
  );
}
