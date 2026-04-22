import React from "react";
import {
  createOrgInvite,
  listOrgSpaces,
  type SpaceRow,
} from "../auth/auth-client";
import type { OrgRole, SpaceRole } from "../auth/auth-session";

const card = "rounded-md border border-border bg-background p-4 text-sm";
const heading = "mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
const btn =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] hover:bg-muted/30";
const input =
  "flex-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring";
const muted = "text-xs text-muted-foreground";

type GrantRow = {
  spaceId: string;
  role: SpaceRole;
};

export function InviteDialog(props: {
  orgId: string;
  onClose: () => void;
  onInvited: () => void;
}): React.ReactElement {
  const { orgId, onClose, onInvited } = props;
  const [spaces, setSpaces] = React.useState<SpaceRow[]>([]);
  const [loadingSpaces, setLoadingSpaces] = React.useState(true);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<OrgRole>("member");
  const [grants, setGrants] = React.useState<GrantRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [createdToken, setCreatedToken] = React.useState<{
    token: string;
    link: string;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listOrgSpaces(orgId);
        if (!cancelled) setSpaces(rows);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoadingSpaces(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const available = spaces.filter(
    (s) => !grants.some((g) => g.spaceId === s.spaceId),
  );

  const addGrant = (spaceId: string): void => {
    if (!spaceId) return;
    setGrants((prev) => [...prev, { spaceId, role: "member" }]);
  };

  const updateGrant = (idx: number, role: SpaceRole): void => {
    setGrants((prev) =>
      prev.map((g, i) => (i === idx ? { ...g, role } : g)),
    );
  };

  const removeGrant = (idx: number): void => {
    setGrants((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createOrgInvite({
        orgId,
        email: email.trim().toLowerCase(),
        role,
        spaceGrants: grants.length > 0 ? grants : undefined,
      });
      const link =
        typeof window !== "undefined"
          ? `${window.location.origin}/invite/${encodeURIComponent(res.token)}`
          : `/invite/${encodeURIComponent(res.token)}`;
      setCreatedToken({ token: res.token, link });
      onInvited();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* silent */
    }
  };

  if (createdToken) {
    return (
      <div className={card}>
        <h2 className={heading}>Invite sent</h2>
        <p className="mb-3 text-[11px] text-muted-foreground">
          {email} will see this invite in their Notifications plugin. You can
          also share the link out-of-band:
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate font-mono text-[11px]">
            {createdToken.link}
          </code>
          <button
            type="button"
            className={btn}
            onClick={() => void copy(createdToken.link)}
          >
            Copy link
          </button>
        </div>
        <div className="mt-3">
          <button type="button" className={btn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={card}>
      <h2 className={heading}>Invite member</h2>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Works for brand-new users and existing archon accounts. Existing users
        will see the invite in their Notifications plugin.
      </p>
      <form className="space-y-2" onSubmit={submit}>
        <input
          type="email"
          required
          placeholder="email@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`${input} w-full`}
        />
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground">Org role:</label>
          <select
            aria-label="Org role"
            value={role}
            onChange={(e) => setRole(e.target.value as OrgRole)}
            className={btn}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </div>

        <fieldset className="space-y-1 border-t border-border/60 pt-2">
          <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Space grants
          </legend>
          {loadingSpaces ? (
            <p className={muted}>Loading spaces…</p>
          ) : null}
          {grants.length === 0 ? (
            <p className={muted}>
              No spaces yet — invitee will only access spaces shared with
              everyone. Add a row below to grant specific space access.
            </p>
          ) : null}
          {grants.map((g, idx) => {
            const s = spaces.find((x) => x.spaceId === g.spaceId);
            return (
              <div
                key={g.spaceId}
                className="flex items-center gap-2 rounded border border-border/60 px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {s?.name ?? g.spaceId}
                </span>
                <select
                  aria-label="Space role"
                  value={g.role}
                  onChange={(e) => updateGrant(idx, e.target.value as SpaceRole)}
                  className={btn}
                >
                  <option value="viewer">viewer</option>
                  <option value="member">member</option>
                  <option value="owner">owner</option>
                </select>
                <button
                  type="button"
                  className={btn}
                  onClick={() => removeGrant(idx)}
                  aria-label="Remove grant"
                >
                  ×
                </button>
              </div>
            );
          })}
          {available.length > 0 ? (
            <div className="flex items-center gap-2">
              <select
                aria-label="Add space"
                value=""
                onChange={(e) => {
                  addGrant(e.target.value);
                  e.target.value = "";
                }}
                className={`${btn} flex-1`}
              >
                <option value="">Add space…</option>
                {available.map((s) => (
                  <option key={s.spaceId} value={s.spaceId}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </fieldset>

        <div className="flex items-center gap-2 border-t border-border/60 pt-2">
          <button type="submit" disabled={submitting} className={btn}>
            {submitting ? "Sending…" : "Send invite"}
          </button>
          <button type="button" className={btn} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
        </div>
      </form>
      {error ? (
        <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}
