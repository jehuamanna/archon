import * as https from "https";

/**
 * Epic 3.5 — lightweight HEAD check against registry.npmjs.org (best-effort, no auth).
 */
export function npmPackageExistsOnRegistry(
  packageName: string,
): Promise<boolean> {
  const pathName = `/${encodeURIComponent(packageName)}`;

  return new Promise((resolve) => {
    const req = https.request(
      {
        method: "HEAD",
        hostname: "registry.npmjs.org",
        path: pathName,
        timeout: 8000,
      },
      (res) => {
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}
