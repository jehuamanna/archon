import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { buildContentSecurityPolicy } from "../lib/csp";
import { resolveMetadataBase } from "../lib/metadata-base";
import "./globals.css";
import ClientShellLoader from "./client-shell-loader";

const csp = buildContentSecurityPolicy();

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: "Archon",
  description: "Programmable Knowledge System",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Archon" },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={csp} />
      </head>
      <body className="h-full min-h-0" suppressHydrationWarning>
        <ClientShellLoader>
          <div id="root" className="h-full min-h-0">
            {children}
          </div>
        </ClientShellLoader>
      </body>
    </html>
  );
}
