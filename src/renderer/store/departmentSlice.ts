import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import {
  createDepartment,
  deleteDepartment,
  listOrgDepartments,
  updateDepartment,
  type DepartmentRow,
} from "../auth/auth-client";

const STALE_AFTER_MS = 60_000;

export type DepartmentState = {
  /** Departments in the active org (org members see all). */
  departments: DepartmentRow[];
  /** orgId the cached `departments` list belongs to — invalidated on org switch. */
  loadedForOrgId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  loadedAt: number | null;
  error: string | null;
};

const initialState: DepartmentState = {
  departments: [],
  loadedForOrgId: null,
  status: "idle",
  loadedAt: null,
  error: null,
};

export const loadOrgDepartmentsThunk = createAsyncThunk<
  { orgId: string; departments: DepartmentRow[] },
  { orgId: string }
>("department/loadForOrg", async ({ orgId }) => {
  const departments = await listOrgDepartments(orgId);
  return { orgId, departments };
});

export const createDepartmentThunk = createAsyncThunk<
  { departmentId: string; orgId: string; name: string },
  { orgId: string; name: string; colorToken?: string | null }
>(
  "department/create",
  async ({ orgId, name, colorToken }, { dispatch }) => {
    const r = await createDepartment({
      orgId,
      name,
      ...(colorToken !== undefined ? { colorToken } : {}),
    });
    await dispatch(loadOrgDepartmentsThunk({ orgId }));
    return { departmentId: r.departmentId, orgId: r.orgId, name: r.name };
  },
);

export const updateDepartmentThunk = createAsyncThunk<
  void,
  { orgId: string; departmentId: string; name?: string; colorToken?: string | null }
>(
  "department/update",
  async ({ orgId, departmentId, name, colorToken }, { dispatch }) => {
    await updateDepartment({
      departmentId,
      ...(name !== undefined ? { name } : {}),
      ...(colorToken !== undefined ? { colorToken } : {}),
    });
    await dispatch(loadOrgDepartmentsThunk({ orgId }));
  },
);

export const deleteDepartmentThunk = createAsyncThunk<
  { departmentId: string },
  { orgId: string; departmentId: string }
>(
  "department/delete",
  async ({ orgId, departmentId }, { dispatch }) => {
    await deleteDepartment(departmentId);
    await dispatch(loadOrgDepartmentsThunk({ orgId }));
    return { departmentId };
  },
);

const slice = createSlice({
  name: "department",
  initialState,
  reducers: {
    clearDepartment(): DepartmentState {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadOrgDepartmentsThunk.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(loadOrgDepartmentsThunk.fulfilled, (state, action) => {
        state.status = "ready";
        state.loadedAt = Date.now();
        state.departments = action.payload.departments;
        state.loadedForOrgId = action.payload.orgId;
      })
      .addCase(loadOrgDepartmentsThunk.rejected, (state, action) => {
        state.status = "error";
        state.error = action.error.message ?? "Failed to load departments";
        state.loadedForOrgId = action.meta.arg.orgId;
      });
  },
});

export const { clearDepartment } = slice.actions;
export default slice.reducer;

export function isDepartmentStateStale(
  state: DepartmentState,
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
