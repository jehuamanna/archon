import { ARCHON_POST_AUTH_REDIRECT_KEY } from "@archon/platform";
import { useEffect, useRef } from "react";
import { isElectronUserAgent } from "../archon-web-shim";
import { useAuth } from "./AuthContext";
import { captureArchonPostAuthRedirectQueryParam } from "./post-auth-redirect";

/**
 * Web only: `/?archon_post_auth=%2Fmcp-auth%3Fuser_code%3D…` stashes return path, opens login when anon,
 * or redirects when already signed in (session restore).
 */
export function WebPostAuthRedirectBootstrap(): null {
  const { state, openWebAuth } = useAuth();
  const openedLoginForRedirectRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || isElectronUserAgent()) {
      return;
    }
    captureArchonPostAuthRedirectQueryParam();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || isElectronUserAgent()) {
      return;
    }
    try {
      const pending = sessionStorage.getItem(ARCHON_POST_AUTH_REDIRECT_KEY);
      if (!pending) {
        return;
      }
      if (state.status === "loading") {
        return;
      }
      if (state.status === "authed") {
        sessionStorage.removeItem(ARCHON_POST_AUTH_REDIRECT_KEY);
        window.location.assign(pending);
        return;
      }
      if (state.status === "anon" && !openedLoginForRedirectRef.current) {
        openedLoginForRedirectRef.current = true;
        openWebAuth("login");
      }
    } catch {
      /* ignore */
    }
  }, [state.status, openWebAuth]);

  return null;
}
