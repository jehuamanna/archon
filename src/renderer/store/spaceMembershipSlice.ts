import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import {
  createSpace,
  deleteSpace,
  listOrgSpaces,
  renameSpace,
  setActiveSpaceRemote,
  setSpaceHidden,
  type SpaceRow,
} from "../auth/auth-client";
import { setActiveSpaceId } from "../auth/auth-session";

const STALE_AFTER_MS = 60_000;

export type SpaceMembershipState = {
  /** Spaces in the active org the caller can see (admin or member). */
  spaces: SpaceRow[];
  activeSpaceId: string | null;
  /** orgId the cached `spaces` list belongs to — invalidated when org switches. */
  loadedForOrgId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadedAt: number | null;
  error: string | null;
};

const initialState: SpaceMembershipState = {
  spaces: [],
  activeSpaceId: null,
  loadedForOrgId: null,
  status: "idle",
  loadedAt: null,
  error: null,
};

export const loadOrgSpacesThunk = createAsyncThunk<
  { orgId: string; spaces: SpaceRow[] },
  { orgId: string; includeHidden?: boolean }
>("spaceMembership/loadForOrg", async ({ orgId, includeHidden }) => {
  const spaces = await listOrgSpaces(
    orgId,
    includeHidden ? { includeHidden: true } : undefined,
  );
  return { orgId, spaces };
});

export const switchActiveSpaceThunk = createAsyncThunk<
  { activeSpaceId: string; activeOrgId: string },
  { spaceId: string }
>("spaceMembership/switch", async ({ spaceId }) => {
  const r = await setActiveSpaceRemote(spaceId);
  return { activeSpaceId: r.activeSpaceId, activeOrgId: r.activeOrgId };
});

export const createSpaceThunk = createAsyncThunk<
  { spaceId: string; orgId: string; name: string },
  { orgId: string; name: string }
>("spaceMembership/create", async ({ orgId, name }, { dispatch }) => {
  const r = await createSpace({ orgId, name });
  await dispatch(loadOrgSpacesThunk({ orgId }));
  return { spaceId: r.spaceId, orgId: r.orgId, name: r.name };
});

export const renameSpaceThunk = createAsyncThunk<
  SpaceRow,
  { orgId: string; spaceId: string; name: string; includeHidden?: boolean }
>(
  "spaceMembership/rename",
  async ({ orgId, spaceId, name, includeHidden }, { dispatch }) => {
    const updated = await renameSpace({ spaceId, name });
    await dispatch(loadOrgSpacesThunk({ orgId, includeHidden }));
    return updated;
  },
);

export const setSpaceHiddenThunk = createAsyncThunk<
  SpaceRow,
  { orgId: string; spaceId: string; hidden: boolean; includeHidden?: boolean }
>(
  "spaceMembership/setHidden",
  async ({ orgId, spaceId, hidden, includeHidden }, { dispatch }) => {
    const updated = await setSpaceHidden({ spaceId, hidden });
    await dispatch(loadOrgSpacesThunk({ orgId, includeHidden }));
    return updated;
  },
);

export const deleteSpaceThunk = createAsyncThunk<
  { spaceId: string },
  { orgId: string; spaceId: string; includeHidden?: boolean }
>(
  "spaceMembership/delete",
  async ({ orgId, spaceId, includeHidden }, { dispatch }) => {
    await deleteSpace(spaceId);
    await dispatch(loadOrgSpacesThunk({ orgId, includeHidden }));
    return { spaceId };
  },
);

const slice = createSlice({
  name: "spaceMembership",
  initialState,
  reducers: {
    clearSpaceMembership(): SpaceMembershipState {
      return initialState;
    },
    setLocalActiveSpace(
      state,
      action: PayloadAction<{ spaceId: string }>,
    ): void {
      state.activeSpaceId = action.payload.spaceId;
      setActiveSpaceId(action.payload.spaceId);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadOrgSpacesThunk.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(loadOrgSpacesThunk.fulfilled, (state, action) => {
        state.status = "ready";
        state.loadedAt = Date.now();
        state.spaces = action.payload.spaces;
        state.loadedForOrgId = action.payload.orgId;
        if (
          state.activeSpaceId &&
          !action.payload.spaces.some((s) => s.spaceId === state.activeSpaceId)
        ) {
          state.activeSpaceId = null;
          setActiveSpaceId(null);
        }
        if (!state.activeSpaceId) {
          const def =
            action.payload.spaces.find((s) => s.kind === "default") ??
            action.payload.spaces[0];
          if (def) {
            state.activeSpaceId = def.spaceId;
            setActiveSpaceId(def.spaceId);
          }
        }
      })
      .addCase(loadOrgSpacesThunk.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Failed to load spaces";
        state.loadedForOrgId = action.meta.arg.orgId;
      })
      .addCase(switchActiveSpaceThunk.fulfilled, (state, action) => {
        state.activeSpaceId = action.payload.activeSpaceId;
      });
  },
});

export const { clearSpaceMembership, setLocalActiveSpace } = slice.actions;
export default slice.reducer;

export function isSpaceMembershipStale(
  state: SpaceMembershipState,
  forOrgId: string | null,
): boolean {
  if (state.loadedForOrgId !== forOrgId) {
    return true;
  }
  if (state.status !== "ready" || state.loadedAt === null) {
    return true;
  }
  return Date.now() - state.loadedAt > STALE_AFTER_MS;
}
