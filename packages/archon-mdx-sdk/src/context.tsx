import * as React from "react";

export interface SDKProject {
  id: string;
  name: string;
  workspaceId: string;
}

export interface SDKUser {
  id: string;
  email: string;
  displayName?: string;
}

export interface SDKTransport {
  /** HTTP base URL for sync-api (e.g., "https://api.archon.local/v1"). */
  apiBaseUrl: string;
  /** Short-lived bearer for HTTP + WS. */
  getAuthToken: () => Promise<string>;
  /** WebSocket endpoint for live state updates. */
  wsUrl: string;
  /** Same-origin check; cross-origin calls use credentials:"omit". */
  isSameOrigin?: (url: string) => boolean;
}

export interface SDKContextValue {
  project: SDKProject;
  user: SDKUser;
  transport: SDKTransport;
  /** Set by host to indicate this mount is read-only (imported-by-non-owner). */
  readOnly: boolean;
}

const SDKContext = React.createContext<SDKContextValue | null>(null);

export interface SDKProviderProps {
  value: SDKContextValue;
  children: React.ReactNode;
}

export function SDKProvider({ value, children }: SDKProviderProps): React.ReactElement {
  return React.createElement(SDKContext.Provider, { value }, children);
}

export function useSDKContext(): SDKContextValue {
  const ctx = React.useContext(SDKContext);
  if (!ctx) {
    throw new Error(
      "useSDKContext must be used inside <SDKProvider> — did you forget to wrap the MDX root?",
    );
  }
  return ctx;
}
