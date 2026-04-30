import React from "react";
import { useSelector } from "react-redux";
import {
  createDepartment,
  deleteDepartment,
  listOrgDepartments,
  updateDepartment,
  type DepartmentRow,
} from "../auth/auth-client";
import type { RootState } from "../store";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading =
  "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";
const btnDanger =
  "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 hover:bg-red-500/20 dark:text-red-200";
const input =
  "flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";

const COLOR_TOKENS = [
  "#7C3AED",
  "#EC4899",
  "#F59E0B",
  "#10B981",
  "#0EA5E9",
  "#A855F7",
  "#EF4444",
  "#64748B",
];

function deptChipStyle(colorToken: string | null): React.CSSProperties {
  return {
    backgroundColor: `${colorToken ?? "#64748B"}1F`,
    borderColor: `${colorToken ?? "#64748B"}66`,
    color: colorToken ?? "#64748B",
  };
}

/**
 * Admin-only Departments console: create, rename, recolor, and delete
 * departments within the active org. Departments group teams (each
 * `team` has a NOT NULL `departmentId` FK), so a department with
 * teams cannot be deleted — the server enforces this and surfaces the
 * error inline.
 */
export function DepartmentsPanel(): React.ReactElement | null {
  const orgState = useSelector((s: RootState) => s.orgMembership);
  const activeOrg = orgState.orgs.find((o) => o.orgId === orgState.activeOrgId);
  const orgId = orgState.activeOrgId;

  const [departments, setDepartments] = React.useState<DepartmentRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState("");
  const [newColor, setNewColor] = React.useState<string>(COLOR_TOKENS[0]!);
  const [submitting, setSubmitting] = React.useState(false);
  const [activeDeptId, setActiveDeptId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editColor, setEditColor] = React.useState<string>(COLOR_TOKENS[0]!);
  const [savingEdit, setSavingEdit] = React.useState(false);

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const d = await listOrgDepartments(orgId);
      setDepartments(d);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeDept =
    departments.find((d) => d.departmentId === activeDeptId) ?? null;

  React.useEffect(() => {
    if (activeDept) {
      setEditName(activeDept.name);
      setEditColor(activeDept.colorToken ?? COLOR_TOKENS[0]!);
    }
  }, [activeDept]);

  if (!orgId || !activeOrg) {
    return (
      <div className={card}>
        <p className={muted}>No active organization.</p>
      </div>
    );
  }
  if (activeOrg.role !== "admin") {
    return (
      <div className={card}>
        <p className={muted}>Admin access required to manage departments.</p>
      </div>
    );
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!orgId) return;
    if (!newName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createDepartment({
        orgId,
        name: newName.trim(),
        colorToken: newColor,
      });
      setNewName("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(): Promise<void> {
    if (!activeDept) return;
    const trimmed = editName.trim();
    if (!trimmed) return;
    setSavingEdit(true);
    setError(null);
    try {
      await updateDepartment({
        departmentId: activeDept.departmentId,
        name: trimmed,
        colorToken: editColor,
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!activeDept) return;
    if (activeDept.teamCount > 0) {
      setError(
        `Cannot delete "${activeDept.name}" — it still has ${activeDept.teamCount} team(s). Move or delete those teams first.`,
      );
      return;
    }
    setError(null);
    try {
      await deleteDepartment(activeDept.departmentId);
      setActiveDeptId(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className={card} aria-labelledby="departments-list">
        <h2 id="departments-list" className={heading}>
          Departments ({departments.length})
        </h2>
        <form
          className="mb-3 flex flex-wrap items-center gap-2"
          onSubmit={handleCreate}
        >
          <input
            type="text"
            required
            placeholder="Department name (e.g. Engineering)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={input}
          />
          <select
            aria-label="Color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className={btn}
          >
            {COLOR_TOKENS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="submit" disabled={submitting} className={btn}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </form>
        {loading ? <p className={muted}>Loading…</p> : null}
        {!loading && departments.length === 0 ? (
          <p className={muted}>
            No departments yet. Create one to start grouping teams.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {departments.map((d) => {
            const selected = d.departmentId === activeDeptId;
            return (
              <button
                type="button"
                key={d.departmentId}
                onClick={() => setActiveDeptId(d.departmentId)}
                style={deptChipStyle(d.colorToken)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${
                  selected
                    ? "ring-2 ring-offset-1 ring-offset-background"
                    : ""
                }`}
                title={`${d.teamCount} team(s) · ${d.memberCount} member(s)`}
              >
                {d.name}
                <span className="opacity-70">· {d.teamCount}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className={card} aria-labelledby="department-detail">
        <h2 id="department-detail" className={heading}>
          {activeDept ? activeDept.name : "Select a department"}
        </h2>
        {!activeDept ? (
          <p className={muted}>
            Pick a department chip on the left to rename, recolor, or delete it.
          </p>
        ) : (
          <>
            <p className={muted}>
              {activeDept.teamCount} team(s) · {activeDept.memberCount}{" "}
              direct member(s)
            </p>
            <div className="my-3 flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="Department name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className={input}
              />
              <select
                aria-label="Department color"
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                className={btn}
              >
                {COLOR_TOKENS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={btn}
                disabled={
                  savingEdit ||
                  !editName.trim() ||
                  (editName.trim() === activeDept.name &&
                    editColor === (activeDept.colorToken ?? COLOR_TOKENS[0]!))
                }
                onClick={() => {
                  void handleSaveEdit();
                }}
              >
                {savingEdit ? "Saving…" : "Save"}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className={muted}>
                Deleting requires the department to be empty.
              </span>
              <button
                type="button"
                className={btnDanger}
                disabled={activeDept.teamCount > 0}
                onClick={() => {
                  void handleDelete();
                }}
              >
                Delete department
              </button>
            </div>
          </>
        )}
      </section>

      {error ? (
        <div className="lg:col-span-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[12px] text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}
