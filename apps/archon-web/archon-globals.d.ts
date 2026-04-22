import type { ArchonRendererApi } from "../../src/shared/archon-renderer-api";

export {};

declare global {
  interface Window {
    Archon: ArchonRendererApi;
    __ARCHON_WEB_API_BASE__?: string;
  }
}

