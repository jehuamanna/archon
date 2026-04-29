/**
 * Realtime feature barrel — single import point for the wiring layer
 * (`routes.ts`, `build-app.ts`). Phases 2/3/4 add module exports here.
 */
export { registerSpaceWsRoutes } from "./ws-skeleton.js";
export { registerRealtimeRoutes } from "./routes.js";
export {
  acquireChannel,
  getChannelDiagnostics,
} from "./listen-pool.js";
export {
  registerYjsWsRoutes,
  getYjsAdapter,
  applyContentToYjsDoc,
} from "./yjs-ws.js";
export { createYjsPgAdapter, type YjsPgAdapter } from "./yjs-pg-adapter.js";
export { registerRealtimeDiagnosticsRoute } from "./diagnostics.js";
export { notifyRealtime, clientOpStore } from "./notify.js";
export { channelForOrg, type RealtimeEvent } from "./events.js";
export {
  setPresence,
  dropPresence,
  snapshotPresence,
  onPresenceChange,
  startPresenceReaper,
  stopPresenceReaper,
  type PresenceState,
} from "./presence.js";
