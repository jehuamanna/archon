/**
 * ADR-016 P2: when `ARCHON_LOCAL_RXDB_WPN` is on, prefer WPN reads from the local RxDB mirror
 * (fed by main debounced push + pull on project-root changes). Writes still use IPC + JSON persist.
 *
 * When switching to cloud WPN, `writeElectronRunMode("cloud")` runs before
 * `syncElectronCloudWpnOverlayFromRunMode()`; during that gap {@link getArchon} can still resolve to
 * this overlay, which must not fall through to file-vault IPC while main already treats the window
 * as cloud.
 */
import { getWpnOwnerId } from "../../core/wpn/wpn-owner";
import type { ArchonRendererApi } from "../../shared/archon-renderer-api";
import { readElectronRunMode } from "../auth/electron-run-mode";
import { createWebArchonApi } from "../archon-web-shim";
import { isLocalRxdbWpnMirrorEnabled } from "./flags";
import {
  tryWpnGetExplorerStateFromLocalRxdb,
  tryWpnGetNoteFromLocalRxdb,
  tryWpnListAllNotesWithContextFromLocalRxdb,
  tryWpnListBacklinksFromLocalRxdb,
  tryWpnListNotesFromLocalRxdb,
  tryWpnListProjectsFromLocalRxdb,
  tryWpnListWorkspacesFromLocalRxdb,
} from "./wpn-local-rxdb-mirror";
import { getOpenWorkspaceWpnRxDb } from "./workspace-wpn-rxdb";

let httpWpnForCloudRace: ArchonRendererApi | null = null;

function shouldUseHttpWpnInsteadOfVaultIpc(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (readElectronRunMode() === "cloud") {
    return true;
  }
  return window.__ARCHON_ELECTRON_WPN_BACKEND__ === "cloud";
}

function getHttpWpnApiForRxdbCloudRace(): ArchonRendererApi {
  if (!httpWpnForCloudRace) {
    httpWpnForCloudRace = createWebArchonApi("");
  }
  return httpWpnForCloudRace;
}

async function rxdbWpnReadFallback(
  prop: keyof ArchonRendererApi,
  target: ArchonRendererApi,
  receiver: unknown,
  args: unknown[],
): Promise<unknown> {
  if (shouldUseHttpWpnInsteadOfVaultIpc()) {
    const http = getHttpWpnApiForRxdbCloudRace();
    const fn = Reflect.get(http, prop, http);
    if (typeof fn === "function") {
      return await (fn as (...a: unknown[]) => Promise<unknown>).apply(http, args);
    }
  }
  const orig = Reflect.get(target, prop, receiver);
  if (typeof orig === "function") {
    return await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
  }
  throw new Error(`Missing ${String(prop)}`);
}

export function createElectronWorkspaceRxdbArchonOverlay(base: ArchonRendererApi): ArchonRendererApi {
  if (!isLocalRxdbWpnMirrorEnabled()) {
    return base;
  }
  const ownerId = getWpnOwnerId();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return undefined;
      }
      const db = getOpenWorkspaceWpnRxDb();
      if (prop === "wpnListWorkspaces") {
        return async () => {
          const local = db ? await tryWpnListWorkspacesFromLocalRxdb(db, ownerId) : null;
          if (local) {
            return { workspaces: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, []);
        };
      }
      if (prop === "wpnListProjects") {
        return async (workspaceId: string) => {
          const local = db ? await tryWpnListProjectsFromLocalRxdb(db, workspaceId) : null;
          if (local) {
            return { projects: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, [workspaceId]);
        };
      }
      if (prop === "wpnListNotes") {
        return async (projectId: string) => {
          const local = db ? await tryWpnListNotesFromLocalRxdb(db, projectId) : null;
          if (local) {
            return { notes: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, [projectId]);
        };
      }
      if (prop === "wpnGetNote") {
        return async (noteId: string) => {
          const local = db ? await tryWpnGetNoteFromLocalRxdb(db, noteId) : null;
          if (local) {
            return { note: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, [noteId]);
        };
      }
      if (prop === "wpnGetExplorerState") {
        return async (projectId: string) => {
          const local = db ? await tryWpnGetExplorerStateFromLocalRxdb(db, projectId) : null;
          if (local) {
            return { expanded_ids: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, [projectId]);
        };
      }
      if (prop === "wpnListAllNotesWithContext") {
        return async () => {
          const local = db ? await tryWpnListAllNotesWithContextFromLocalRxdb(db) : null;
          if (local) {
            return { notes: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, []);
        };
      }
      if (prop === "wpnListBacklinksToNote") {
        return async (targetNoteId: string) => {
          const local = db ? await tryWpnListBacklinksFromLocalRxdb(db, targetNoteId) : null;
          if (local) {
            return { sources: local };
          }
          return rxdbWpnReadFallback(prop, target, receiver, [targetNoteId]);
        };
      }
      const v = Reflect.get(target, prop, target);
      if (typeof v === "function") {
        return v.bind(target);
      }
      return v;
    },
  }) as ArchonRendererApi;
}
