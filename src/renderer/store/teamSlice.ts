import {
  createAsyncThunk,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";
import {
  createTeam,
  deleteTeam,
  listOrgTeams,
  updateTeam,
  type TeamRow,
} from "../auth/auth-client";
import { setActiveTeamId } from "../auth/auth-session";

const STALE_AFTER_MS = 60_000;

export type TeamState = {
  /** Teams in the active org the caller can see (org members see all). */
  teams: TeamRow[];
  /**
   * The team the JWT pins for this session (`activeTeamId` claim from
   * `POST /orgs/active`). Surfaced for UI hints; routing and read-side
   * scoping flow through the JWT-carried `activeOrgId`, not the team.
   */
  activeTeamId: string | null;
  /** orgId the cached `teams` list belongs to — invalidated on org switch. */
  loadedForOrgId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadedAt: number | null;
  error: string | null;
};

const initialState: TeamState = {
  teams: [],
  activeTeamId: null,
  loadedForOrgId: null,
  status: "idle",
  loadedAt: null,
  error: null,
};

export const loadOrgTeamsThunk = createAsyncThunk<
  { orgId: string; teams: TeamRow[] },
  { orgId: string }
>("team/loadForOrg", async ({ orgId }) => {
  const teams = await listOrgTeams(orgId);
  return { orgId, teams };
});

export const createTeamThunk = createAsyncThunk<
  { teamId: string; orgId: string; name: string },
  {
    orgId: string;
    departmentId: string;
    name: string;
    colorToken?: string | null;
  }
>(
  "team/create",
  async ({ orgId, departmentId, name, colorToken }, { dispatch }) => {
    const r = await createTeam({
      orgId,
      departmentId,
      name,
      ...(colorToken !== undefined ? { colorToken } : {}),
    });
    await dispatch(loadOrgTeamsThunk({ orgId }));
    return { teamId: r.teamId, orgId: r.orgId, name: r.name };
  },
);

export const updateTeamThunk = createAsyncThunk<
  void,
  {
    orgId: string;
    teamId: string;
    name?: string;
    colorToken?: string | null;
    departmentId?: string;
  }
>(
  "team/update",
  async ({ orgId, teamId, name, colorToken, departmentId }, { dispatch }) => {
    await updateTeam({
      teamId,
      ...(name !== undefined ? { name } : {}),
      ...(colorToken !== undefined ? { colorToken } : {}),
      ...(departmentId !== undefined ? { departmentId } : {}),
    });
    await dispatch(loadOrgTeamsThunk({ orgId }));
  },
);

export const deleteTeamThunk = createAsyncThunk<
  { teamId: string },
  { orgId: string; teamId: string }
>("team/delete", async ({ orgId, teamId }, { dispatch }) => {
  await deleteTeam(teamId);
  await dispatch(loadOrgTeamsThunk({ orgId }));
  return { teamId };
});

const slice = createSlice({
  name: "team",
  initialState,
  reducers: {
    clearTeam(): TeamState {
      return initialState;
    },
    /**
     * Local-only set of the active team id (JWT mirror after `/orgs/active`
     * fires). The sync-api derives team scope from the JWT, not from a
     * request header — this is purely for UI bookkeeping.
     */
    setLocalActiveTeam(
      state,
      action: PayloadAction<{ teamId: string | null }>,
    ): void {
      state.activeTeamId = action.payload.teamId;
      setActiveTeamId(action.payload.teamId);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadOrgTeamsThunk.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(loadOrgTeamsThunk.fulfilled, (state, action) => {
        state.status = "ready";
        state.loadedAt = Date.now();
        state.teams = action.payload.teams;
        state.loadedForOrgId = action.payload.orgId;
        // Drop activeTeamId if the JWT-pinned team isn't visible to this
        // user in the loaded org (membership change since the JWT was
        // minted).
        if (
          state.activeTeamId &&
          !action.payload.teams.some((t) => t.teamId === state.activeTeamId)
        ) {
          state.activeTeamId = null;
          setActiveTeamId(null);
        }
      })
      .addCase(loadOrgTeamsThunk.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Failed to load teams";
        state.loadedForOrgId = action.meta.arg.orgId;
      });
  },
});

export const { clearTeam, setLocalActiveTeam } = slice.actions;
export default slice.reducer;

export function isTeamStateStale(
  state: TeamState,
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
