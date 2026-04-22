"use client";

import { useEffect, useState } from "react";
import {
  fetchLatestRelease,
  formatBytes,
  type LatestRelease,
} from "../../lib/github-releases";

export default function DownloadPage() {
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLatestRelease()
      .then(setRelease)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background p-8 text-foreground">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Download Archon</h1>
        <p className="text-muted-foreground text-lg">
          Programmable Knowledge System
        </p>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading releases…</p>
      ) : release ? (
        <div className="flex flex-col items-center gap-6">
          <p className="text-sm text-muted-foreground">
            Latest release:{" "}
            <a
              href={release.html_url}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-4"
            >
              {release.tag_name}
            </a>{" "}
            &mdash;{" "}
            {new Date(release.published_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>

          <div className="flex flex-col gap-4 sm:flex-row">
            {release.deb ? (
              <a
                href={release.deb.browser_download_url}
                className="flex flex-col items-center gap-1 rounded-lg border border-border bg-card px-8 py-5 shadow-sm transition-colors hover:bg-accent"
              >
                <span className="text-lg font-semibold">
                  Download .deb
                </span>
                <span className="text-xs text-muted-foreground">
                  Debian / Ubuntu &mdash; {formatBytes(release.deb.size)}
                </span>
              </a>
            ) : null}

            {release.appimage ? (
              <a
                href={release.appimage.browser_download_url}
                className="flex flex-col items-center gap-1 rounded-lg border border-border bg-card px-8 py-5 shadow-sm transition-colors hover:bg-accent"
              >
                <span className="text-lg font-semibold">
                  Download .AppImage
                </span>
                <span className="text-xs text-muted-foreground">
                  Any Linux &mdash; {formatBytes(release.appimage.size)}
                </span>
              </a>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground">No release found.</p>
      )}
    </main>
  );
}
