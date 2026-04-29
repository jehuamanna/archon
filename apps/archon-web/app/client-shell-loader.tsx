"use client";

import "../lib/crypto-uuid-polyfill";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { PwaServiceWorkerRegister } from "./pwa-register";

const ClientShell = dynamic(() => import("./client-shell"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-background text-muted-foreground text-sm">
      Loading…
    </div>
  ),
});

export default function ClientShellLoader({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <PwaServiceWorkerRegister />
      <ClientShell>{children}</ClientShell>
    </>
  );
}
