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
