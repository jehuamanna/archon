import { createSyncBaseUrlResolver } from "@archon/platform";
import {
  getAccessToken,
  getActiveOrgId,
  getActiveSpaceId,
  setAccessToken,
  setActiveOrgId,
  setActiveSpaceId,
  setActiveTeamId,
  type AuthUser,
  type AuthUserOrg,
  type AuthUserSpace,
  type OrgRole,
  type SpaceRole,
} from "./auth-session";
import {
  writeCloudSyncRefreshToken,
  writeCloudSyncToken,
} from "../cloud-sync/cloud-sync-storage";

const resolveSyncBase = createSyncBaseUrlResolver();

type AuthResponse = { token: string; user: AuthUser };

function errorMessageFromBody(status: number, text: string): string {
  const raw = text.trim();
  if (!raw) {
    return `Request failed (${status})`;
  }
  if (/<\s*!doctype/i.test(raw) || /<\s*html[\s>]/i.test(raw)) {
    return `Request failed (${status}): the server returned a web page instead of JSON. For local dev, either run the legacy headless API with Next proxying (set ARCHON_HEADLESS_API_ORIGIN or ARCHON_HEADLESS_API_ORIGIN_DEV=1), or use archon-sync-api and sign up with sync mode enabled (NEXT_PUBLIC_ARCHON_SYNC_API_URL / sync WPN env).`;
  }
  try {
    const j = JSON.parse(raw) as { error?: string };
    if (typeof j.error === "string" && j.error.trim()) {
      return j.error.trim();
    }
  } catch {
    /* plain text */
  }
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const scopeHeaders: Record<string, string> = {};
  const orgId = getActiveOrgId();
  if (orgId) {
    scopeHeaders["X-Archon-Org"] = orgId;
  }
  const spaceId = getActiveSpaceId();
  if (spaceId) {
    scopeHeaders["X-Archon-Space"] = spaceId;
  }
  // Fastify rejects bodies declared as application/json when empty
  // (FST_ERR_CTP_EMPTY_JSON_BODY), so only set the content-type when we are
  // actually sending a body.
  const bodyHeaders: Record<string, string> =
    init?.body != null ? { "Content-Type": "application/json" } : {};
  const base = resolveSyncBase().replace(/\/$/, "");
  const url = base ? `${base}${path}` : `/api/v1${path}`;
  const res = await fetch(url, {
    credentials: "include",
    ...(init ?? {}),
    headers: {
      ...bodyHeaders,
      ...scopeHeaders,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(errorMessageFromBody(res.status, text));
  }
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

// Public signup is intentionally absent — onboarding is admin-driven only.
// Use the master-invite or org-invite flow (`/auth/accept-master-invite`,
// `/auth/accept-invite`) for new accounts.

export async function authLogin(payload: {
  email: string;
  password: string;
}): Promise<AuthUser> {
  const r = await requestJson<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  setAccessToken(r.token);
  return r.user;
}

export async function authRefresh(): Promise<AuthUser> {
  const r = await requestJson<AuthResponse>("/auth/refresh", { method: "POST" });
  setAccessToken(r.token);
  return r.user;
}

export async function authLogout(): Promise<void> {
  try {
    await requestJson<{ ok: true }>("/auth/logout", { method: "POST" });
  } finally {
    setAccessToken(null);
  }
}

export async function authMe(): Promise<AuthUser> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ user: AuthUser }>("/auth/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.user;
}

/** Rotate the current user's password; clears mustSetPassword on success. */
export async function authChangePassword(payload: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: true; mustSetPassword: false }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson<{ ok: true; mustSetPassword: false }>("/auth/change-password", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

type ListOrgsResponse = {
  orgs: AuthUserOrg[];
  activeOrgId: string | null;
  defaultOrgId: string | null;
  lockedOrgId: string | null;
};

export async function createOrg(payload: {
  name: string;
  slug?: string;
}): Promise<{ orgId: string; name: string; slug: string }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson<{ orgId: string; name: string; slug: string }>("/orgs", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

export async function listMyOrgs(): Promise<ListOrgsResponse> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<ListOrgsResponse>("/orgs/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.activeOrgId) {
    setActiveOrgId(r.activeOrgId);
  } else if (r.defaultOrgId) {
    setActiveOrgId(r.defaultOrgId);
  }
  return r;
}

export async function setActiveOrgRemote(orgId: string): Promise<{
  token: string;
  activeOrgId: string;
  activeTeamId: string | null;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{
    token: string;
    activeOrgId: string;
    activeTeamId: string | null;
  }>("/orgs/active", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ orgId }),
  });
  setAccessToken(r.token);
  writeCloudSyncToken(r.token);
  setActiveOrgId(r.activeOrgId);
  // Mirror the JWT-carried activeTeamId into renderer session state so
  // explorer effects keyed on the active team refire on org switch.
  setActiveTeamId(r.activeTeamId);
  // Best-effort vestigial mirror so legacy useEffect([activeSpaceId])
  // hooks in #5-not-yet-ported components still see *something* change
  // on org switch. Removed once the explorer rewrite lands.
  setActiveSpaceId(r.activeTeamId);
  return { token: r.token, activeOrgId: r.activeOrgId, activeTeamId: r.activeTeamId };
}

/**
 * Single team grant carried on an invite. Pre-migration the field was
 * named `spaceGrants` and pointed at spaces; the org/team migration
 * renamed it `teamGrants` (sync-api commit 76d60a5 surface). The role
 * value is the team-membership role (admin/member), NOT the team→
 * project grant role.
 */
export type InviteTeamGrantInfo = {
  teamId: string;
  teamName: string;
  role: "admin" | "member";
};

export type OrgInvitePreview = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  email: string;
  role: OrgRole;
  needsPassword: boolean;
  expiresAt: string;
  inviter: {
    userId: string;
    displayName: string;
    email: string;
  };
  teamGrants: InviteTeamGrantInfo[];
};

export async function previewInvite(token: string): Promise<OrgInvitePreview> {
  return requestJson<OrgInvitePreview>(
    `/auth/invites/preview?token=${encodeURIComponent(token)}`,
    { method: "GET" },
  );
}

/**
 * Accept a master-admin invite. Auto-creates the account if needed (using the
 * supplied password as the bootstrap) and promotes to platform-wide master
 * admin. The server returns no token — the invitee is told to log in. New
 * accounts come back with `mustSetPassword=true` so the first login forces
 * the change-password screen.
 */
export async function acceptMasterInvite(payload: {
  token: string;
  password: string;
}): Promise<{
  userId: string;
  email: string;
  isMasterAdmin: true;
  createdUser: boolean;
  mustSetPassword: boolean;
}> {
  return requestJson("/auth/accept-master-invite", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function acceptInvite(payload: {
  token: string;
  password?: string;
  displayName?: string;
}): Promise<{
  token: string;
  refreshToken: string;
  userId: string;
  orgId: string;
  role: OrgRole;
  createdUser: boolean;
  teamGrants: { teamId: string; role: "admin" | "member" }[];
}> {
  const r = await requestJson<{
    token: string;
    refreshToken: string;
    userId: string;
    orgId: string;
    role: OrgRole;
    createdUser: boolean;
    teamGrants?: { teamId: string; role: "admin" | "member" }[];
  }>("/auth/accept-invite", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  setAccessToken(r.token);
  setActiveOrgId(r.orgId);
  // Persist to localStorage so the post-accept `window.location.reload()` in
  // App.tsx restores the new (invited-org-scoped) session. Without this,
  // cloudRestoreSessionThunk reads the caller's pre-accept token and rehydrates
  // the UI in the wrong org — the tree appears to "always show the inviter's
  // own notes" regardless of which org is selected.
  writeCloudSyncToken(r.token);
  writeCloudSyncRefreshToken(r.refreshToken);
  return { ...r, teamGrants: r.teamGrants ?? [] };
}

/** Decline an invite by token. Idempotent; unknown tokens return 404. */
export async function declineInvite(token: string): Promise<void> {
  await requestJson<{ ok: true }>("/auth/decline-invite", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export type OrgMember = {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
  mustSetPassword: boolean;
  joinedAt: string;
};

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ members: OrgMember[] }>(
    `/orgs/${encodeURIComponent(orgId)}/members`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.members;
}

export type OrgInviteStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "declined"
  | "expired";

export type OrgInviteRow = {
  inviteId: string;
  email: string;
  role: OrgRole;
  status: OrgInviteStatus;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  spaceGrants: { spaceId: string; role: SpaceRole }[];
};

export async function listOrgInvites(orgId: string): Promise<OrgInviteRow[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ invites: OrgInviteRow[] }>(
    `/orgs/${encodeURIComponent(orgId)}/invites`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.invites;
}

export async function createOrgInvite(payload: {
  orgId: string;
  email: string;
  role?: OrgRole;
  spaceGrants?: { spaceId: string; role: SpaceRole }[];
}): Promise<{
  inviteId: string;
  email: string;
  role: OrgRole;
  token: string;
  expiresAt: string;
  spaceGrants: { spaceId: string; role: SpaceRole }[];
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson(`/orgs/${encodeURIComponent(payload.orgId)}/invites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      email: payload.email,
      role: payload.role ?? "member",
      ...(payload.spaceGrants && payload.spaceGrants.length > 0
        ? { spaceGrants: payload.spaceGrants }
        : {}),
    }),
  });
}

export async function revokeOrgInvite(payload: {
  orgId: string;
  inviteId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/orgs/${encodeURIComponent(payload.orgId)}/invites/${encodeURIComponent(payload.inviteId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

/**
 * Rotate a pending org invite's token. Use when the original link was lost
 * or accidentally shared. Returns a fresh plaintext token (one-time);
 * compose `${origin}/invite/${token}` to share.
 */
export async function regenerateOrgInvite(payload: {
  orgId: string;
  inviteId: string;
}): Promise<{ inviteId: string; email: string; role: OrgRole; token: string; expiresAt: string }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson(
    `/orgs/${encodeURIComponent(payload.orgId)}/invites/${encodeURIComponent(payload.inviteId)}/regenerate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

/**
 * Admin creates a new user + org membership in one call with a temporary
 * password that the new user must rotate on first login.
 */
export async function createOrgMember(payload: {
  orgId: string;
  email: string;
  password: string;
  role?: OrgRole;
}): Promise<{
  userId: string;
  email: string;
  role: OrgRole;
  mustSetPassword: true;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson(`/orgs/${encodeURIComponent(payload.orgId)}/members/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      email: payload.email,
      password: payload.password,
      role: payload.role ?? "member",
    }),
  });
}

/** Admin resets a member's password. Sets mustSetPassword=true on the user. */
export async function resetOrgMemberPassword(payload: {
  orgId: string;
  userId: string;
  password: string;
}): Promise<{ userId: string; mustSetPassword: true }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson(
    `/orgs/${encodeURIComponent(payload.orgId)}/members/${encodeURIComponent(payload.userId)}/reset-password`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password: payload.password }),
    },
  );
}

export async function setOrgMemberRole(payload: {
  orgId: string;
  userId: string;
  role: OrgRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/orgs/${encodeURIComponent(payload.orgId)}/members/${encodeURIComponent(payload.userId)}/role`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function removeOrgMember(payload: {
  orgId: string;
  userId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/orgs/${encodeURIComponent(payload.orgId)}/members/${encodeURIComponent(payload.userId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

// ----- Phase 2: Spaces -----

export type SpaceRow = {
  spaceId: string;
  orgId: string;
  name: string;
  kind: "default" | "normal";
  role: SpaceRole | null;
  createdAt: string;
  hidden?: boolean;
  hiddenAt?: string | null;
  hiddenByUserId?: string | null;
};

export async function listOrgSpaces(
  orgId: string,
  opts?: { includeHidden?: boolean },
): Promise<SpaceRow[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const qs = opts?.includeHidden ? "?includeHidden=true" : "";
  const r = await requestJson<{ spaces: SpaceRow[] }>(
    `/orgs/${encodeURIComponent(orgId)}/spaces${qs}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.spaces;
}

export async function createSpace(payload: {
  orgId: string;
  name: string;
}): Promise<{ spaceId: string; orgId: string; name: string; kind: "default" | "normal"; role: SpaceRole }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson(`/orgs/${encodeURIComponent(payload.orgId)}/spaces`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: payload.name }),
  });
}

export async function renameSpace(payload: {
  spaceId: string;
  name: string;
}): Promise<SpaceRow> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson<SpaceRow>(
    `/spaces/${encodeURIComponent(payload.spaceId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: payload.name }),
    },
  );
}

export async function setSpaceHidden(payload: {
  spaceId: string;
  hidden: boolean;
}): Promise<SpaceRow> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson<SpaceRow>(
    `/spaces/${encodeURIComponent(payload.spaceId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hidden: payload.hidden }),
    },
  );
}

export async function deleteSpace(spaceId: string): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/spaces/${encodeURIComponent(spaceId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export type SpaceMember = {
  userId: string;
  email: string;
  displayName: string | null;
  role: SpaceRole;
  joinedAt: string;
};

export async function listSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ members: SpaceMember[] }>(
    `/spaces/${encodeURIComponent(spaceId)}/members`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.members;
}

export async function addSpaceMember(payload: {
  spaceId: string;
  userId: string;
  role?: SpaceRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/spaces/${encodeURIComponent(payload.spaceId)}/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId: payload.userId, role: payload.role ?? "member" }),
  });
}

export async function setSpaceMemberRole(payload: {
  spaceId: string;
  userId: string;
  role: SpaceRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/spaces/${encodeURIComponent(payload.spaceId)}/members/${encodeURIComponent(payload.userId)}/role`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function removeSpaceMember(payload: {
  spaceId: string;
  userId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/spaces/${encodeURIComponent(payload.spaceId)}/members/${encodeURIComponent(payload.userId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

// ----- Phase 4/8: Workspace + Project visibility & shares -----

export type ShareRole = "reader" | "writer";
export type ResourceVisibility = "public" | "private" | "shared";

export type WorkspaceShareRow = {
  userId: string;
  email: string;
  displayName: string | null;
  role: ShareRole;
  addedAt: string;
};

function bearer(): string {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return token;
}

export async function listWorkspaceShares(
  workspaceId: string,
): Promise<WorkspaceShareRow[]> {
  const r = await requestJson<{ shares: WorkspaceShareRow[] }>(
    `/wpn/workspaces/${encodeURIComponent(workspaceId)}/shares`,
    { method: "GET", headers: { Authorization: `Bearer ${bearer()}` } },
  );
  return r.shares;
}

export async function addWorkspaceShare(payload: {
  workspaceId: string;
  userId: string;
  role: ShareRole;
}): Promise<void> {
  await requestJson(
    `/wpn/workspaces/${encodeURIComponent(payload.workspaceId)}/shares`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ userId: payload.userId, role: payload.role }),
    },
  );
}

export async function updateWorkspaceShareRole(payload: {
  workspaceId: string;
  userId: string;
  role: ShareRole;
}): Promise<void> {
  await requestJson(
    `/wpn/workspaces/${encodeURIComponent(payload.workspaceId)}/shares/${encodeURIComponent(payload.userId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function removeWorkspaceShare(payload: {
  workspaceId: string;
  userId: string;
}): Promise<void> {
  await requestJson(
    `/wpn/workspaces/${encodeURIComponent(payload.workspaceId)}/shares/${encodeURIComponent(payload.userId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${bearer()}` } },
  );
}

export async function setWorkspaceVisibility(payload: {
  workspaceId: string;
  visibility: ResourceVisibility;
}): Promise<void> {
  await requestJson(
    `/wpn/workspaces/${encodeURIComponent(payload.workspaceId)}/visibility`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ visibility: payload.visibility }),
    },
  );
}

export type ProjectShareRow = {
  userId: string;
  email: string;
  displayName: string | null;
  role: ShareRole;
  addedAt: string;
};

export async function listProjectShares(
  projectId: string,
): Promise<ProjectShareRow[]> {
  const r = await requestJson<{ shares: ProjectShareRow[] }>(
    `/wpn/projects/${encodeURIComponent(projectId)}/shares`,
    { method: "GET", headers: { Authorization: `Bearer ${bearer()}` } },
  );
  return r.shares;
}

export async function addProjectShare(payload: {
  projectId: string;
  userId: string;
  role: ShareRole;
}): Promise<void> {
  await requestJson(
    `/wpn/projects/${encodeURIComponent(payload.projectId)}/shares`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ userId: payload.userId, role: payload.role }),
    },
  );
}

export async function updateProjectShareRole(payload: {
  projectId: string;
  userId: string;
  role: ShareRole;
}): Promise<void> {
  await requestJson(
    `/wpn/projects/${encodeURIComponent(payload.projectId)}/shares/${encodeURIComponent(payload.userId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function removeProjectShare(payload: {
  projectId: string;
  userId: string;
}): Promise<void> {
  await requestJson(
    `/wpn/projects/${encodeURIComponent(payload.projectId)}/shares/${encodeURIComponent(payload.userId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${bearer()}` } },
  );
}

export async function setProjectVisibility(payload: {
  projectId: string;
  visibility: ResourceVisibility;
}): Promise<void> {
  await requestJson(
    `/wpn/projects/${encodeURIComponent(payload.projectId)}/visibility`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ visibility: payload.visibility }),
    },
  );
}

export async function setActiveSpaceRemote(spaceId: string): Promise<{
  token: string;
  activeSpaceId: string;
  activeOrgId: string;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{
    token: string;
    activeSpaceId: string;
    activeOrgId: string;
  }>("/spaces/active", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ spaceId }),
  });
  setAccessToken(r.token);
  writeCloudSyncToken(r.token);
  setActiveSpaceId(r.activeSpaceId);
  setActiveOrgId(r.activeOrgId);
  return r;
}

// ----- Teams (post org/team migration) -----
//
// Teams sit under a department (every team has a non-null `departmentId`).
// Project access flows through `team_projects` grants — NOT through the
// pre-migration team→space grants. The legacy `TeamGrant` shape has been
// replaced with `TeamProjectGrant` below.

export type TeamMembershipRole = "admin" | "member";
export type TeamProjectRole = "owner" | "contributor" | "viewer";

export type TeamRow = {
  teamId: string;
  orgId: string;
  departmentId: string;
  name: string;
  colorToken: string | null;
  memberCount: number;
  createdAt: string;
};

export async function listOrgTeams(orgId: string): Promise<TeamRow[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ teams: TeamRow[] }>(
    `/orgs/${encodeURIComponent(orgId)}/teams`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.teams;
}

export async function createTeam(payload: {
  orgId: string;
  departmentId: string;
  name: string;
  colorToken?: string | null;
}): Promise<{
  teamId: string;
  orgId: string;
  departmentId: string;
  name: string;
  colorToken: string | null;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const body: Record<string, unknown> = {
    name: payload.name,
    departmentId: payload.departmentId,
  };
  if (payload.colorToken !== undefined) body.colorToken = payload.colorToken;
  return requestJson(`/orgs/${encodeURIComponent(payload.orgId)}/teams`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function updateTeam(payload: {
  teamId: string;
  name?: string;
  colorToken?: string | null;
  /** Move the team to a different department in the same org. */
  departmentId?: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const body: Record<string, unknown> = {};
  if (payload.name !== undefined) body.name = payload.name;
  if (payload.colorToken !== undefined) body.colorToken = payload.colorToken;
  if (payload.departmentId !== undefined) body.departmentId = payload.departmentId;
  await requestJson(`/teams/${encodeURIComponent(payload.teamId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function deleteTeam(teamId: string): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/teams/${encodeURIComponent(teamId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export type TeamMember = {
  userId: string;
  email: string;
  displayName: string | null;
  role: TeamMembershipRole;
  joinedAt: string;
};

export async function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ members: TeamMember[] }>(
    `/teams/${encodeURIComponent(teamId)}/members`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.members;
}

export async function addTeamMember(payload: {
  teamId: string;
  userId: string;
  role?: TeamMembershipRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/teams/${encodeURIComponent(payload.teamId)}/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      userId: payload.userId,
      ...(payload.role ? { role: payload.role } : {}),
    }),
  });
}

export async function setTeamMemberRole(payload: {
  teamId: string;
  userId: string;
  role: TeamMembershipRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/teams/${encodeURIComponent(payload.teamId)}/members/${encodeURIComponent(payload.userId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function removeTeamMember(payload: {
  teamId: string;
  userId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/teams/${encodeURIComponent(payload.teamId)}/members/${encodeURIComponent(payload.userId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

/** A team's grant on a single project (m2m via `team_projects`). */
export type TeamProjectGrant = {
  projectId: string;
  projectName: string;
  role: TeamProjectRole;
  grantedAt: string;
};

export async function listTeamProjects(
  teamId: string,
): Promise<TeamProjectGrant[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ grants: TeamProjectGrant[] }>(
    `/teams/${encodeURIComponent(teamId)}/projects`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.grants;
}

export async function grantTeamProject(payload: {
  teamId: string;
  projectId: string;
  role: TeamProjectRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/teams/${encodeURIComponent(payload.teamId)}/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId: payload.projectId,
      role: payload.role,
    }),
  });
}

export async function setTeamProjectRole(payload: {
  teamId: string;
  projectId: string;
  role: TeamProjectRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/teams/${encodeURIComponent(payload.teamId)}/projects/${encodeURIComponent(payload.projectId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function revokeTeamProject(payload: {
  teamId: string;
  projectId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/teams/${encodeURIComponent(payload.teamId)}/projects/${encodeURIComponent(payload.projectId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

// ----- Departments -----

export type DepartmentMembershipRole = "admin" | "member";

export type DepartmentRow = {
  departmentId: string;
  orgId: string;
  name: string;
  colorToken: string | null;
  teamCount: number;
  memberCount: number;
  createdAt: string;
};

export async function listOrgDepartments(
  orgId: string,
): Promise<DepartmentRow[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ departments: DepartmentRow[] }>(
    `/orgs/${encodeURIComponent(orgId)}/departments`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.departments;
}

export async function createDepartment(payload: {
  orgId: string;
  name: string;
  colorToken?: string | null;
}): Promise<{
  departmentId: string;
  orgId: string;
  name: string;
  colorToken: string | null;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const body: Record<string, unknown> = { name: payload.name };
  if (payload.colorToken !== undefined) body.colorToken = payload.colorToken;
  return requestJson(
    `/orgs/${encodeURIComponent(payload.orgId)}/departments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
  );
}

export async function updateDepartment(payload: {
  departmentId: string;
  name?: string;
  colorToken?: string | null;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const body: Record<string, unknown> = {};
  if (payload.name !== undefined) body.name = payload.name;
  if (payload.colorToken !== undefined) body.colorToken = payload.colorToken;
  await requestJson(
    `/departments/${encodeURIComponent(payload.departmentId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
  );
}

export async function deleteDepartment(departmentId: string): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/departments/${encodeURIComponent(departmentId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export type DepartmentMember = {
  userId: string;
  email: string;
  displayName: string | null;
  role: DepartmentMembershipRole;
  joinedAt: string;
};

export async function listDepartmentMembers(
  departmentId: string,
): Promise<DepartmentMember[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ members: DepartmentMember[] }>(
    `/departments/${encodeURIComponent(departmentId)}/members`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.members;
}

export async function addDepartmentMember(payload: {
  departmentId: string;
  userId: string;
  role?: DepartmentMembershipRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/departments/${encodeURIComponent(payload.departmentId)}/members`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: payload.userId,
        ...(payload.role ? { role: payload.role } : {}),
      }),
    },
  );
}

export async function setDepartmentMemberRole(payload: {
  departmentId: string;
  userId: string;
  role: DepartmentMembershipRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/departments/${encodeURIComponent(payload.departmentId)}/members/${encodeURIComponent(payload.userId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: payload.role }),
    },
  );
}

export async function removeDepartmentMember(payload: {
  departmentId: string;
  userId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/departments/${encodeURIComponent(payload.departmentId)}/members/${encodeURIComponent(payload.userId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function listDepartmentTeams(
  departmentId: string,
): Promise<TeamRow[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ teams: TeamRow[] }>(
    `/departments/${encodeURIComponent(departmentId)}/teams`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.teams;
}

// ----- Phase 7: Audit log -----

export type AuditEvent = {
  eventId: string;
  orgId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown> | null;
  ts: string;
};

export async function listOrgAudit(payload: {
  orgId: string;
  before?: number;
  limit?: number;
}): Promise<{ events: AuditEvent[]; nextBefore: number | null }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const params = new URLSearchParams();
  if (payload.before) params.set("before", String(payload.before));
  if (payload.limit) params.set("limit", String(payload.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return requestJson<{ events: AuditEvent[]; nextBefore: number | null }>(
    `/orgs/${encodeURIComponent(payload.orgId)}/audit${qs}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

export async function listMySpaces(): Promise<{
  spaces: AuthUserSpace[];
  activeSpaceId: string | null;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{
    spaces: AuthUserSpace[];
    activeSpaceId: string | null;
  }>("/spaces/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.activeSpaceId) {
    setActiveSpaceId(r.activeSpaceId);
  }
  return r;
}

// ----- Master admin (platform) -----

export type MasterAdminRow = {
  userId: string;
  email: string;
  displayName: string | null;
};

export type OrgAdminRow = {
  userId: string;
  email: string;
  displayName: string | null;
  joinedAt: string;
};

function masterHeaders(): Record<string, string> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return { Authorization: `Bearer ${token}` };
}

export type MasterOrgRow = {
  orgId: string;
  name: string;
  slug: string;
  createdAt: string;
};

export async function listAllOrgs(): Promise<MasterOrgRow[]> {
  const r = await requestJson<{ orgs: MasterOrgRow[] }>("/master/orgs", {
    method: "GET",
    headers: masterHeaders(),
  });
  return r.orgs;
}

export async function listMasterAdmins(): Promise<MasterAdminRow[]> {
  const r = await requestJson<{ admins: MasterAdminRow[] }>("/master/admins", {
    method: "GET",
    headers: masterHeaders(),
  });
  return r.admins;
}

/**
 * Create a new master admin. Pass `userId` to promote an existing account, or
 * `email` (+ optional `password`) to mint a brand-new one. The response
 * includes a `password` field only when the server generated it.
 */
export async function createMasterAdmin(payload: {
  email?: string;
  userId?: string;
  password?: string;
}): Promise<{
  userId: string;
  email: string;
  isMasterAdmin: true;
  createdUser: boolean;
  password?: string;
}> {
  return requestJson("/master/admins", {
    method: "POST",
    headers: masterHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function removeMasterAdmin(userId: string): Promise<void> {
  await requestJson(`/master/admins/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: masterHeaders(),
  });
}

export async function listOrgAdmins(orgId: string): Promise<OrgAdminRow[]> {
  const r = await requestJson<{ admins: OrgAdminRow[] }>(
    `/master/orgs/${encodeURIComponent(orgId)}/admins`,
    { method: "GET", headers: masterHeaders() },
  );
  return r.admins;
}

export async function createOrgAdmin(payload: {
  orgId: string;
  email?: string;
  userId?: string;
  password?: string;
}): Promise<{
  userId: string;
  email: string;
  role: "admin";
  createdUser: boolean;
  password?: string;
}> {
  const { orgId, ...body } = payload;
  return requestJson(`/master/orgs/${encodeURIComponent(orgId)}/admins`, {
    method: "POST",
    headers: masterHeaders(),
    body: JSON.stringify(body),
  });
}

export async function demoteOrgAdmin(payload: {
  orgId: string;
  userId: string;
}): Promise<void> {
  await requestJson(
    `/master/orgs/${encodeURIComponent(payload.orgId)}/admins/${encodeURIComponent(payload.userId)}`,
    { method: "DELETE", headers: masterHeaders() },
  );
}

export type MasterUserRow = {
  userId: string;
  email: string;
  displayName: string | null;
  isMasterAdmin: boolean;
  lockedOrgId: string | null;
  disabled: boolean;
  mustSetPassword: boolean;
  orgCount: number;
};

export async function listAllUsers(params?: {
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ users: MasterUserRow[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.limit) qs.set("limit", String(params.limit));
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  return requestJson(`/master/users${tail}`, {
    method: "GET",
    headers: masterHeaders(),
  });
}

export async function disableUser(userId: string): Promise<void> {
  await requestJson(`/master/users/${encodeURIComponent(userId)}/disable`, {
    method: "POST",
    headers: masterHeaders(),
  });
}

export async function enableUser(userId: string): Promise<void> {
  await requestJson(`/master/users/${encodeURIComponent(userId)}/enable`, {
    method: "POST",
    headers: masterHeaders(),
  });
}

export async function deleteUser(userId: string): Promise<{
  userId: string;
  deleted: true;
  reassignedSpaces: number;
  deletedWorkspaces: number;
}> {
  return requestJson(`/master/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: masterHeaders(),
  });
}

/**
 * Master-only: reset any user's password. Pass `password` to set a specific
 * one, or omit to mint a temp password (returned in `password` field of the
 * response). Sets `mustSetPassword=true` and clears refresh sessions so the
 * target re-authenticates and is forced through the change-password flow on
 * next login.
 */
export async function resetMasterUserPassword(payload: {
  userId: string;
  password?: string;
}): Promise<{
  userId: string;
  mustSetPassword: true;
  password?: string;
}> {
  return requestJson(
    `/master/users/${encodeURIComponent(payload.userId)}/reset-password`,
    {
      method: "POST",
      headers: { ...masterHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(
        payload.password ? { password: payload.password } : {},
      ),
    },
  );
}

// ----- Master invites -----

export type MasterInviteRow = {
  inviteId: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

export async function listMasterInvites(
  status: MasterInviteRow["status"] = "pending",
): Promise<MasterInviteRow[]> {
  const r = await requestJson<{ invites: MasterInviteRow[] }>(
    `/master/invites?status=${encodeURIComponent(status)}`,
    { method: "GET", headers: masterHeaders() },
  );
  return r.invites;
}

/** Returns the plaintext token once — compose the URL `${origin}/invite/master/${token}` to share. */
export async function createMasterInvite(payload: {
  email: string;
}): Promise<{
  inviteId: string;
  email: string;
  token: string;
  expiresAt: string;
}> {
  return requestJson("/master/invites", {
    method: "POST",
    headers: { ...masterHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ email: payload.email }),
  });
}

export async function revokeMasterInvite(inviteId: string): Promise<void> {
  await requestJson(`/master/invites/${encodeURIComponent(inviteId)}`, {
    method: "DELETE",
    headers: masterHeaders(),
  });
}

export async function regenerateMasterInvite(inviteId: string): Promise<{
  inviteId: string;
  email: string;
  token: string;
  expiresAt: string;
}> {
  return requestJson(
    `/master/invites/${encodeURIComponent(inviteId)}/regenerate`,
    {
      method: "POST",
      headers: masterHeaders(),
    },
  );
}

// ----- Phase 8: Notifications -----

export type NotificationEntity = {
  id: string;
  userId: string;
  type: "org_invite";
  payload: Record<string, unknown>;
  link: string;
  status: "unread" | "read" | "consumed" | "dismissed";
  createdAt: string;
  readAt: string | null;
  consumedAt: string | null;
  dismissedAt: string | null;
};

export type OrgInviteNotificationPayload = {
  inviteId: string;
  orgId: string;
  orgName: string;
  inviterUserId: string;
  inviterDisplayName: string;
  inviterEmail: string;
  role: OrgRole;
  teamGrants: InviteTeamGrantInfo[];
  expiresAt: string;
};

export type ListNotificationsResponse = {
  notifications: NotificationEntity[];
  unreadCount: number;
  cursor: string | null;
};

export async function listNotifications(params?: {
  since?: string;
  unread?: boolean;
  limit?: number;
}): Promise<ListNotificationsResponse> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const qs = new URLSearchParams();
  if (params?.since) qs.set("since", params.since);
  if (params?.unread) qs.set("unread", "1");
  if (params?.limit) qs.set("limit", String(params.limit));
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  return requestJson<ListNotificationsResponse>(`/me/notifications${tail}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function markNotificationsRead(
  ids: string[],
): Promise<{ updated: number }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  if (ids.length === 0) {
    return { updated: 0 };
  }
  return requestJson<{ updated: number }>("/me/notifications/read", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ids }),
  });
}

export async function dismissNotification(id: string): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson<{ ok: true }>(
    `/me/notifications/${encodeURIComponent(id)}/dismiss`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
}

