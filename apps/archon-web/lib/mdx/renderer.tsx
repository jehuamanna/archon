"use client";

import * as React from "react";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { compileMdxCached } from "./compile.js";
import { evaluateMdxModule } from "./sandbox.js";
import {
  SDKProvider,
  sdkVersion,
  type SDKContextValue,
} from "@archon/mdx-sdk-runtime";
import * as sdk from "@archon/mdx-sdk-runtime";

export interface MdxRendererProps {
  source: string;
  context: SDKContextValue;
  fallback?: React.ReactNode;
}

interface MdxErrorBoundaryState {
  error: Error | null;
}

class MdxErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  MdxErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): MdxErrorBoundaryState {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.warn("[mdx] render error:", error.message, info.componentStack);
  }
  render(): React.ReactNode {
    if (this.state.error) return this.props.fallback;
    return this.props.children;
  }
}

export function MdxRenderer(props: MdxRendererProps): React.ReactElement {
  const [state, setState] = React.useState<
    | { status: "loading" }
    | { status: "ready"; Component: React.ComponentType }
    | { status: "error"; error: Error }
  >({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const compiled = await compileMdxCached(props.source, sdkVersion);
        const mod = evaluateMdxModule(
          compiled,
          { jsx: _jsx, jsxs: _jsxs, Fragment: _Fragment },
          sdk as unknown as Record<string, unknown>,
        );
        const Component = (mod as { default?: React.ComponentType })?.default;
        if (!Component) {
          throw new Error("MDX module produced no default export");
        }
        if (!cancelled) setState({ status: "ready", Component });
      } catch (err) {
        if (!cancelled) setState({ status: "error", error: err as Error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.source]);

  const fallback = props.fallback ?? (
    <div role="alert" style={{ padding: 8, border: "1px solid #c00", color: "#c00" }}>
      This MDX note failed to render. Open it in Code view to see the source.
    </div>
  );

  if (state.status === "loading") {
    return <div style={{ opacity: 0.6 }}>Compiling…</div>;
  }
  if (state.status === "error") {
    return (
      <div role="alert" style={{ padding: 8, border: "1px solid #c00", color: "#c00" }}>
        <strong>MDX error:</strong> {state.error.message}
      </div>
    );
  }
  const Component = state.Component;
  return (
    <SDKProvider value={props.context}>
      <MdxErrorBoundary fallback={fallback}>
        <Component />
      </MdxErrorBoundary>
    </SDKProvider>
  );
}
