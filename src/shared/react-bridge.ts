import React from "react";
import ReactDOM from "react-dom";
import { createRoot, hydrateRoot } from "react-dom/client";

/**
 * React bridge for plugin iframes (Epic 1.3).
 * The parent attaches the real React / ReactDOM modules after a short postMessage
 * handshake so plugin code never reads `window.parent` (CSP / isolation friendly).
 *
 * Must expose the **full** `react` default export: libraries such as `@tiptap/react`
 * ship code that imports `react/jsx-runtime`, which reads
 * `React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`.
 * A hand-picked subset of APIs breaks with "Cannot read properties of undefined
 * (reading 'recentlyCreatedOwnerStacks')".
 */
export function attachReactToPluginWindow(w: Window): void {
  const target = w as Window & {
    Archon?: Record<string, unknown>;
    React?: unknown;
    ReactDOM?: unknown;
  };

  target.Archon = target.Archon ?? {};

  const reactDomForPlugins = {
    ...(ReactDOM as Record<string, unknown>),
    createRoot,
    hydrateRoot,
  };

  target.Archon.React = React;
  target.Archon.ReactDOM = reactDomForPlugins;

  target.React = React;
  target.ReactDOM = reactDomForPlugins;
}

/** @deprecated Legacy iframe bootstrap used postMessage + attachReactToPluginWindow; prefer NoteTypeReactRenderer. */
export function generateReactBridge(): string {
  return "/* deprecated: use attachReactToPluginWindow from parent */";
}

export const reactBridgeTypes = `
declare global {
  interface Window {
    Archon: {
      React: typeof import("react");
      ReactDOM: typeof import("react-dom") & import("react-dom/client");
    };
    React: typeof Archon.React;
    ReactDOM: typeof Archon.ReactDOM;
  }
}
export {};
`;
