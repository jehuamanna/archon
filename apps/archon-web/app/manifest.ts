import type { MetadataRoute } from "next";

export const dynamic = "force-static";

/** PWA installability (with `public/sw.js` + HTTPS in production). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Archon",
    short_name: "Archon",
    description: "Programmable Knowledge System",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/favicon.svg",
        type: "image/svg+xml",
        sizes: "any",
      },
    ],
  };
}
