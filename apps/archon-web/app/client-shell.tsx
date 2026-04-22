"use client";

import "../../../src/renderer/bootstrap/electron-archon-idb-scratch-run";

import React from "react";
import * as ReactDOM from "react-dom";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Provider } from "react-redux";
import { ArchonContributionProvider } from "../../../src/renderer/shell/ArchonContributionContext";
import { ShellLayoutProvider } from "../../../src/renderer/shell/layout/ShellLayoutContext";
import { ShellProjectWorkspaceProvider } from "../../../src/renderer/shell/useShellProjectWorkspace";
import { ShellViewProvider } from "../../../src/renderer/shell/views/ShellViewContext";
import { ShellRegistriesProvider } from "../../../src/renderer/shell/registries/ShellRegistriesContext";
import { ArchonDialogProvider } from "../../../src/renderer/dialog/ArchonDialogProvider";
import { ThemeProvider } from "../../../src/renderer/theme/ThemeContext";
import { ToastProvider } from "../../../src/renderer/toast/ToastContext";
import { initCloudSyncRuntime } from "../../../src/renderer/cloud-sync/initCloudSyncRuntime";
import { platformDeps, store } from "../../../src/renderer/store";
import { ensureSesLockdown } from "../../../src/renderer/shell/sandbox/sesLockdown";

function runClientBootstrap(): void {
  if (typeof window === "undefined") {
    return;
  }
  initCloudSyncRuntime(platformDeps, store.dispatch);
  ensureSesLockdown();
  loader.config({ monaco });
  (window as unknown as { React?: typeof React }).React = React;
  (window as unknown as { ReactDOM?: typeof ReactDOM }).ReactDOM = ReactDOM;
  if (process.env.NODE_ENV !== "production") {
    const RO_LOOP_RE = /ResizeObserver loop (completed|limit exceeded)/i;
    window.addEventListener(
      "error",
      (e) => {
        const msg = (e as ErrorEvent).message || "";
        if (RO_LOOP_RE.test(msg)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }
}

runClientBootstrap();

export default function ClientShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ArchonDialogProvider>
          <Provider store={store}>
            <ShellLayoutProvider>
              <ShellProjectWorkspaceProvider>
                <ShellViewProvider>
                  <ShellRegistriesProvider>
                    <ArchonContributionProvider>{children}</ArchonContributionProvider>
                  </ShellRegistriesProvider>
                </ShellViewProvider>
              </ShellProjectWorkspaceProvider>
            </ShellLayoutProvider>
          </Provider>
        </ArchonDialogProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
