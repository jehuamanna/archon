import { createSlice, createAsyncThunk, type PayloadAction } from "@reduxjs/toolkit";
import {
  dismissNotification,
  listNotifications,
  markNotificationsRead,
  type NotificationEntity,
} from "../auth/auth-client";
import type { RootState } from "./index";

// Using `unknown` state generic on the thunk so dispatch from other slices
// that declare their own extra-argument doesn't fight TS's generic inference.
// Selectors below still use the authoritative `RootState`.

export type NotificationsState = {
  byId: Record<string, NotificationEntity>;
  order: string[];
  unreadCount: number;
  cursor: string | null;
  lastFetchedAt: number | null;
  status: "idle" | "loading" | "error";
  error: string | null;
};

const initialState: NotificationsState = {
  byId: {},
  order: [],
  unreadCount: 0,
  cursor: null,
  lastFetchedAt: null,
  status: "idle",
  error: null,
};

/**
 * Fetch notifications since the stored cursor (or from the top if absent).
 * Merges new rows into `byId` / `order` and updates `unreadCount` from the
 * server-returned total (authoritative).
 */
export const fetchNotificationsThunk = createAsyncThunk<
  { notifications: NotificationEntity[]; unreadCount: number; cursor: string | null },
  { since?: string; unread?: boolean; limit?: number } | undefined
>("notifications/fetch", async (arg) => {
  const res = await listNotifications({
    since: arg?.since,
    unread: arg?.unread,
    limit: arg?.limit,
  });
  return res;
});

export const markNotificationsReadThunk = createAsyncThunk<
  { ids: string[]; updated: number },
  string[]
>("notifications/markRead", async (ids) => {
  const { updated } = await markNotificationsRead(ids);
  return { ids, updated };
});

export const dismissNotificationThunk = createAsyncThunk<
  { id: string },
  string
>("notifications/dismiss", async (id) => {
  await dismissNotification(id);
  return { id };
});

const slice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    resetNotifications(): NotificationsState {
      return initialState;
    },
    /** Local-only: stamp a notification as consumed (e.g. after invite accepted). */
    locallyConsumeByDedupeLink(
      state,
      action: PayloadAction<{ link: string }>,
    ): void {
      for (const id of state.order) {
        const n = state.byId[id];
        if (n && n.link === action.payload.link && n.status !== "consumed") {
          if (n.status === "unread") state.unreadCount = Math.max(0, state.unreadCount - 1);
          state.byId[id] = { ...n, status: "consumed", consumedAt: new Date().toISOString() };
        }
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotificationsThunk.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchNotificationsThunk.fulfilled, (state, action) => {
        state.status = "idle";
        state.unreadCount = action.payload.unreadCount;
        state.lastFetchedAt = Date.now();
        if (action.payload.cursor) {
          state.cursor = action.payload.cursor;
        }
        for (const n of action.payload.notifications) {
          if (!state.byId[n.id]) {
            state.order.push(n.id);
          }
          state.byId[n.id] = n;
        }
        state.order.sort((a, b) => {
          const aAt = state.byId[a]?.createdAt ?? "";
          const bAt = state.byId[b]?.createdAt ?? "";
          return bAt.localeCompare(aAt);
        });
      })
      .addCase(fetchNotificationsThunk.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Failed to load notifications";
      })
      .addCase(markNotificationsReadThunk.fulfilled, (state, action) => {
        const nowIso = new Date().toISOString();
        let decremented = 0;
        for (const id of action.payload.ids) {
          const n = state.byId[id];
          if (n && n.status === "unread") {
            state.byId[id] = { ...n, status: "read", readAt: nowIso };
            decremented += 1;
          }
        }
        state.unreadCount = Math.max(0, state.unreadCount - decremented);
      })
      .addCase(dismissNotificationThunk.fulfilled, (state, action) => {
        const n = state.byId[action.payload.id];
        if (n) {
          if (n.status === "unread") {
            state.unreadCount = Math.max(0, state.unreadCount - 1);
          }
          state.byId[action.payload.id] = {
            ...n,
            status: "dismissed",
            dismissedAt: new Date().toISOString(),
          };
        }
      });
  },
});

export const { resetNotifications, locallyConsumeByDedupeLink } = slice.actions;

export default slice.reducer;

// ----- Selectors -----

export const selectNotificationsState = (state: RootState): NotificationsState =>
  state.notifications;

export const selectUnreadNotificationCount = (state: RootState): number =>
  state.notifications.unreadCount;

export const selectNotifications = (state: RootState): NotificationEntity[] =>
  state.notifications.order
    .map((id) => state.notifications.byId[id])
    .filter(
      (n): n is NotificationEntity =>
        !!n && n.status !== "consumed" && n.status !== "dismissed",
    );
