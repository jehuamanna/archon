import React from "react";

const block = "animate-pulse rounded-md bg-muted/40";

/** Phase 6 — shimmer placeholder shown while note detail is in flight. */
export function NoteSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4 p-4" aria-busy="true" aria-label="Loading note">
      <div className={`${block} h-6 w-2/3`} />
      <div className={`${block} h-4 w-1/3`} />
      <div className="space-y-2">
        <div className={`${block} h-3 w-full`} />
        <div className={`${block} h-3 w-11/12`} />
        <div className={`${block} h-3 w-9/12`} />
        <div className={`${block} h-3 w-10/12`} />
      </div>
      <div className="space-y-2">
        <div className={`${block} h-3 w-full`} />
        <div className={`${block} h-3 w-11/12`} />
        <div className={`${block} h-3 w-7/12`} />
      </div>
    </div>
  );
}
