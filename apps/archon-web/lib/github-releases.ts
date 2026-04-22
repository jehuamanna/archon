const REPO = "jehuamanna/archon";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
};

export type LatestRelease = {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  deb: ReleaseAsset | null;
  appimage: ReleaseAsset | null;
};

export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tag_name: string;
      name: string;
      html_url: string;
      published_at: string;
      assets: ReleaseAsset[];
    };
    const deb = data.assets.find((a) => a.name.endsWith(".deb")) ?? null;
    const appimage = data.assets.find((a) => a.name.endsWith(".AppImage")) ?? null;
    return {
      tag_name: data.tag_name,
      name: data.name,
      html_url: data.html_url,
      published_at: data.published_at,
      deb,
      appimage,
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
