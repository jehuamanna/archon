import videojs from "video.js";

/**
 * Exposes Video.js in plugin iframes (same pattern as react-bridge).
 * Skin CSS is inlined into the legacy iframe document (see VIDEO_JS_IFRAME_CSS); note UI is moving to React hosts.
 */
export function attachVideoJsToPluginWindow(w: Window): void {
  const target = w as Window & {
    Archon?: Record<string, unknown>;
    videojs?: typeof videojs;
  };

  target.Archon = target.Archon ?? {};
  target.Archon.VideoJS = videojs;
  target.videojs = videojs;
}
