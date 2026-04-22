"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Archon] route error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-center text-slate-100">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-slate-400">
        The app hit an unexpected error. You can try again, or reload the page.
      </p>
      {process.env.NODE_ENV === "development" && error?.message ? (
        <pre className="max-h-40 max-w-full overflow-auto rounded-md bg-slate-900 p-3 text-left text-xs text-amber-200/90">
          {error.message}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          onClick={() => reset()}
        >
          Try again
        </button>
        <button
          type="button"
          className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          onClick={() => {
            window.location.href = "/";
          }}
        >
          Go home
        </button>
      </div>
    </div>
  );
}
