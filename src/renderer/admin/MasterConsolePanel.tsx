import React from "react";
import { useSelector } from "react-redux";
import {
  createMasterAdmin,
  createMasterInvite,
  createOrgAdmin,
  demoteOrgAdmin,
  disableUser,
  enableUser,
  listAllOrgs,
  listAllUsers,
  listMasterAdmins,
  listMasterInvites,
  listOrgAdmins,
  regenerateMasterInvite,
  removeMasterAdmin,
  resetMasterUserPassword,
  revokeMasterInvite,
  type MasterAdminRow,
  type MasterInviteRow,
  type MasterOrgRow,
  type MasterUserRow,
  type OrgAdminRow,
} from "../auth/auth-client";
import type { RootState } from "../store";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading = "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const row =
  "flex items-center justify-between gap-2 border-b border-border/40 py-2 last:border-b-0";
const muted = "text-xs text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";
const btnDanger =
  "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 hover:bg-red-500/20 dark:text-red-200";
const input =
  "flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";
const selectC =
  "rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";

function CredentialCallout({
  label,
  email,
  password,
}: {
  label: string;
  email: string;
  password: string;
}): React.ReactElement {
  return (
    <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">
      <div className="font-semibold">{label}</div>
      <div>
        <span className={muted}>Email:</span>{" "}
        <code className="font-mono">{email}</code>
      </div>
      <div>
        <span className={muted}>Temp password:</span>{" "}
        <code className="font-mono">{password}</code>
      </div>
      <div className={muted}>Copy now — this is shown once.</div>
    </div>
  );
}

function MasterAdminsSection(): React.ReactElement {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [admins, setAdmins] = React.useState<MasterAdminRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addEmail, setAddEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [created, setCreated] = React.useState<
    { email: string; password: string } | null
  >(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAdmins(await listMasterAdmins());
    } catch (err) {
      setError((err as Error).message ?? "Failed to load master admins");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const email = addEmail.trim();
    if (!email) return;
    setSubmitting(true);
    setError(null);
    setCreated(null);
    try {
      const r = await createMasterAdmin({ email });
      if (r.password) {
        setCreated({ email: r.email, password: r.password });
      }
      setAddEmail("");
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to create master admin");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDemote(userId: string): Promise<void> {
    setError(null);
    try {
      await removeMasterAdmin(userId);
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to demote master admin");
    }
  }

  return (
    <section className={card}>
      <h2 className={heading}>Master admins</h2>
      {loading ? <p className={muted}>Loading…</p> : null}
      <ul>
        {admins.map((a) => {
          const isSelf = a.userId === cloudAuth.userId;
          return (
            <li key={a.userId} className={row}>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12px]">
                  {a.displayName ?? a.email}
                </span>
                <span className={muted}>
                  {a.email}
                  {isSelf ? " · you" : ""}
                </span>
              </div>
              {admins.length > 1 && !isSelf ? (
                <button
                  type="button"
                  className={btnDanger}
                  onClick={() => void handleDemote(a.userId)}
                >
                  Demote
                </button>
              ) : (
                <span className={muted}>
                  {admins.length <= 1 ? "Last master" : "Cannot demote self"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <form className="mt-3 flex items-center gap-2" onSubmit={handleCreate}>
        <input
          type="email"
          className={input}
          placeholder="new-master@example.com"
          value={addEmail}
          onChange={(e) => setAddEmail(e.target.value)}
          disabled={submitting}
        />
        <button
          type="submit"
          className={btn}
          disabled={submitting || !addEmail.trim()}
        >
          {submitting ? "Creating…" : "Create master admin"}
        </button>
      </form>
      {created ? (
        <CredentialCallout
          label="Master admin created"
          email={created.email}
          password={created.password}
        />
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">{error}</p>
      ) : null}
    </section>
  );
}

function OrgAdminsSection(): React.ReactElement {
  const [orgs, setOrgs] = React.useState<MasterOrgRow[]>([]);
  const [selectedOrgId, setSelectedOrgId] = React.useState<string>("");
  const [admins, setAdmins] = React.useState<OrgAdminRow[]>([]);
  const [loadingOrgs, setLoadingOrgs] = React.useState(false);
  const [loadingAdmins, setLoadingAdmins] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addEmail, setAddEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [created, setCreated] = React.useState<
    { email: string; password: string } | null
  >(null);

  React.useEffect(() => {
    setLoadingOrgs(true);
    setError(null);
    void (async () => {
      try {
        const r = await listAllOrgs();
        setOrgs(r);
        if (r.length > 0 && !selectedOrgId) {
          setSelectedOrgId(r[0].orgId);
        }
      } catch (err) {
        setError((err as Error).message ?? "Failed to load orgs");
      } finally {
        setLoadingOrgs(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshAdmins = React.useCallback(async () => {
    if (!selectedOrgId) {
      setAdmins([]);
      return;
    }
    setLoadingAdmins(true);
    setError(null);
    try {
      setAdmins(await listOrgAdmins(selectedOrgId));
    } catch (err) {
      setError((err as Error).message ?? "Failed to load org admins");
    } finally {
      setLoadingAdmins(false);
    }
  }, [selectedOrgId]);

  React.useEffect(() => {
    void refreshAdmins();
  }, [refreshAdmins]);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const email = addEmail.trim();
    if (!email || !selectedOrgId) return;
    setSubmitting(true);
    setError(null);
    setCreated(null);
    try {
      const r = await createOrgAdmin({ orgId: selectedOrgId, email });
      if (r.password) {
        setCreated({ email: r.email, password: r.password });
      }
      setAddEmail("");
      await refreshAdmins();
    } catch (err) {
      setError((err as Error).message ?? "Failed to create org admin");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDemote(userId: string): Promise<void> {
    if (!selectedOrgId) return;
    setError(null);
    try {
      await demoteOrgAdmin({ orgId: selectedOrgId, userId });
      await refreshAdmins();
    } catch (err) {
      setError((err as Error).message ?? "Failed to demote org admin");
    }
  }

  return (
    <section className={card}>
      <h2 className={heading}>Org admins</h2>
      {loadingOrgs ? (
        <p className={muted}>Loading organizations…</p>
      ) : orgs.length === 0 ? (
        <p className={muted}>No organizations yet.</p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2">
            <span className={muted}>Organization:</span>
            <select
              className={selectC + " flex-1"}
              value={selectedOrgId}
              onChange={(e) => setSelectedOrgId(e.target.value)}
            >
              {orgs.map((o) => (
                <option key={o.orgId} value={o.orgId}>
                  {o.name} ({o.slug})
                </option>
              ))}
            </select>
          </div>
          {loadingAdmins ? <p className={muted}>Loading admins…</p> : null}
          {!loadingAdmins && admins.length === 0 ? (
            <p className={muted}>No admins yet in this org.</p>
          ) : null}
          <ul>
            {admins.map((a) => (
              <li key={a.userId} className={row}>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[12px]">
                    {a.displayName ?? a.email}
                  </span>
                  <span className={muted}>{a.email}</span>
                </div>
                <button
                  type="button"
                  className={btnDanger}
                  onClick={() => void handleDemote(a.userId)}
                >
                  Demote
                </button>
              </li>
            ))}
          </ul>
          <form className="mt-3 flex items-center gap-2" onSubmit={handleCreate}>
            <input
              type="email"
              className={input}
              placeholder="new-admin@example.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              disabled={submitting}
            />
            <button
              type="submit"
              className={btn}
              disabled={submitting || !addEmail.trim() || !selectedOrgId}
            >
              {submitting ? "Creating…" : "Create org admin"}
            </button>
          </form>
        </>
      )}
      {created ? (
        <CredentialCallout
          label="Org admin created"
          email={created.email}
          password={created.password}
        />
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">{error}</p>
      ) : null}
    </section>
  );
}

function UsersSection(): React.ReactElement {
  const cloudAuth = useSelector((s: RootState) => s.cloudAuth);
  const [users, setUsers] = React.useState<MasterUserRow[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busyUserId, setBusyUserId] = React.useState<string | null>(null);
  const [resetCredential, setResetCredential] = React.useState<
    { email: string; password: string } | null
  >(null);

  const runSearch = React.useCallback(
    async (opts?: { append?: boolean; cursor?: string | null }) => {
      setLoading(true);
      setError(null);
      try {
        const r = await listAllUsers({
          q: query.trim() || undefined,
          cursor: opts?.cursor ?? undefined,
          limit: 50,
        });
        setUsers((prev) => (opts?.append ? [...prev, ...r.users] : r.users));
        setNextCursor(r.nextCursor);
      } catch (err) {
        setError((err as Error).message ?? "Failed to load users");
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  React.useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDisable(u: MasterUserRow): Promise<void> {
    if (!window.confirm(`Disable ${u.email}? They will lose access immediately.`)) {
      return;
    }
    setBusyUserId(u.userId);
    setError(null);
    try {
      await disableUser(u.userId);
      await runSearch();
    } catch (err) {
      setError((err as Error).message ?? "Failed to disable user");
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleEnable(u: MasterUserRow): Promise<void> {
    setBusyUserId(u.userId);
    setError(null);
    try {
      await enableUser(u.userId);
      await runSearch();
    } catch (err) {
      setError((err as Error).message ?? "Failed to enable user");
    } finally {
      setBusyUserId(null);
    }
  }

  /**
   * Hard delete is intentionally unsupported by the API (returns 410 Gone)
   * because every privileged FK uses ON DELETE RESTRICT to preserve
   * "[Deleted user]" attribution on creator/granter columns. Use Disable
   * (soft-delete) instead — it clears refresh sessions so the target loses
   * access immediately and the audit trail keeps their row.
   */

  async function handleReset(u: MasterUserRow): Promise<void> {
    if (!window.confirm(`Mint a temp password for ${u.email}? They will be forced to change it on next login.`)) {
      return;
    }
    setBusyUserId(u.userId);
    setError(null);
    try {
      const r = await resetMasterUserPassword({ userId: u.userId });
      if (r.password) {
        setResetCredential({ email: u.email, password: r.password });
      } else {
        setError("Password reset, but the server did not return a temp password. Did you pass an explicit one?");
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to reset password");
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <section className={card}>
      <h2 className={heading}>All users</h2>
      <form
        className="mb-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <input
          type="search"
          className={input}
          placeholder="Search by email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className={btn} disabled={loading}>
          {loading ? "…" : "Search"}
        </button>
      </form>
      {loading && users.length === 0 ? <p className={muted}>Loading…</p> : null}
      {!loading && users.length === 0 ? (
        <p className={muted}>No users match.</p>
      ) : null}
      <ul>
        {users.map((u) => {
          const isSelf = u.userId === cloudAuth.userId;
          const busy = busyUserId === u.userId;
          return (
            <li key={u.userId} className={row}>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12px]">
                  {u.displayName ?? u.email}
                  {u.isMasterAdmin ? (
                    <span className="ml-2 rounded bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-200">
                      master
                    </span>
                  ) : null}
                  {u.disabled ? (
                    <span className="ml-2 rounded bg-red-500/20 px-1 text-[10px] text-red-700 dark:text-red-200">
                      disabled
                    </span>
                  ) : null}
                  {u.lockedOrgId ? (
                    <span className="ml-2 rounded bg-muted/60 px-1 text-[10px] text-muted-foreground">
                      locked
                    </span>
                  ) : null}
                </span>
                <span className={muted}>
                  {u.email} · {u.orgCount} org{u.orgCount === 1 ? "" : "s"}
                  {isSelf ? " · you" : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {isSelf || u.isMasterAdmin ? (
                  <span className={muted}>
                    {isSelf ? "Cannot modify self" : "Demote master first"}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className={btn}
                      disabled={busy}
                      onClick={() => void handleReset(u)}
                    >
                      Reset password
                    </button>
                    {u.disabled ? (
                      <button
                        type="button"
                        className={btn}
                        disabled={busy}
                        onClick={() => void handleEnable(u)}
                      >
                        Enable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={btnDanger}
                        disabled={busy}
                        onClick={() => void handleDisable(u)}
                      >
                        Disable
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {nextCursor ? (
        <button
          type="button"
          className={btn + " mt-3"}
          disabled={loading}
          onClick={() => void runSearch({ append: true, cursor: nextCursor })}
        >
          Load more
        </button>
      ) : null}
      {resetCredential ? (
        <CredentialCallout
          label="Temp password (one-time)"
          email={resetCredential.email}
          password={resetCredential.password}
        />
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">{error}</p>
      ) : null}
    </section>
  );
}

/**
 * Pending master-admin invites. Once an invitee accepts and logs in, the
 * invite moves out of `pending` so it no longer appears here. Show the
 * one-time link callout right after creation; if lost, "Regenerate" mints
 * a fresh token (the old link instantly stops working).
 */
function MasterInvitesSection(): React.ReactElement {
  const [invites, setInvites] = React.useState<MasterInviteRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addEmail, setAddEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [shareLink, setShareLink] = React.useState<{
    email: string;
    link: string;
    expiresAt: string;
  } | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInvites(await listMasterInvites("pending"));
    } catch (err) {
      setError((err as Error).message ?? "Failed to load invites");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  function buildLink(token: string): string {
    return typeof window !== "undefined"
      ? `${window.location.origin}/invite/master/${encodeURIComponent(token)}`
      : `/invite/master/${encodeURIComponent(token)}`;
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const email = addEmail.trim();
    if (!email) return;
    setSubmitting(true);
    setError(null);
    setShareLink(null);
    try {
      const r = await createMasterInvite({ email });
      setShareLink({
        email: r.email,
        link: buildLink(r.token),
        expiresAt: r.expiresAt,
      });
      setAddEmail("");
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to create invite");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegenerate(inviteId: string): Promise<void> {
    setError(null);
    try {
      const r = await regenerateMasterInvite(inviteId);
      setShareLink({
        email: r.email,
        link: buildLink(r.token),
        expiresAt: r.expiresAt,
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to regenerate invite");
    }
  }

  async function handleRevoke(inviteId: string): Promise<void> {
    setError(null);
    try {
      await revokeMasterInvite(inviteId);
      await refresh();
    } catch (err) {
      setError((err as Error).message ?? "Failed to revoke invite");
    }
  }

  return (
    <section className={card}>
      <h2 className={heading}>Master invites (pending)</h2>
      <form className="mb-3 flex items-center gap-2" onSubmit={handleCreate}>
        <input
          type="email"
          autoComplete="email"
          className={input}
          placeholder="invitee@example.com"
          value={addEmail}
          onChange={(e) => setAddEmail(e.target.value)}
        />
        <button type="submit" className={btn} disabled={submitting}>
          {submitting ? "…" : "Send invite"}
        </button>
      </form>
      {loading ? <p className={muted}>Loading…</p> : null}
      {invites.length === 0 && !loading ? (
        <p className={muted}>No pending master invites.</p>
      ) : null}
      <ul>
        {invites.map((i) => (
          <li key={i.inviteId} className={row}>
            <div className="min-w-0">
              <span className="truncate text-[12px]">{i.email}</span>
              <div className={muted}>
                expires {new Date(i.expiresAt).toLocaleString()}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={btn}
                onClick={() => void handleRegenerate(i.inviteId)}
              >
                Regenerate link
              </button>
              <button
                type="button"
                className={btnDanger}
                onClick={() => void handleRevoke(i.inviteId)}
              >
                Revoke
              </button>
            </div>
          </li>
        ))}
      </ul>
      {shareLink ? (
        <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px]">
          <div className="font-semibold">Invite link for {shareLink.email}</div>
          <code className="mt-1 block break-all rounded bg-background/50 px-1 py-0.5 font-mono text-[10px]">
            {shareLink.link}
          </code>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className={btn}
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(shareLink.link);
                }
              }}
            >
              Copy
            </button>
            <span className={muted}>
              expires {new Date(shareLink.expiresAt).toLocaleString()} —
              shown once; regenerate if lost.
            </span>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-red-600 dark:text-red-300">{error}</p>
      ) : null}
    </section>
  );
}

export function MasterConsolePanel(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <MasterAdminsSection />
      <MasterInvitesSection />
      <OrgAdminsSection />
      <UsersSection />
    </div>
  );
}
