import {
  getAccessToken,
  getActiveOrgId,
  getActiveSpaceId,
  setAccessToken,
  setActiveOrgId,
  setActiveSpaceId,
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
  const res = await fetch(`/api/v1${path}`, {
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

export async function authSignup(payload: {
  email: string;
  username: string;
  password: string;
}): Promise<AuthUser> {
  const r = await requestJson<AuthResponse>("/auth/signup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  setAccessToken(r.token);
  return r.user;
}

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
  activeSpaceId: string | null;
}> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{
    token: string;
    activeOrgId: string;
    activeSpaceId: string | null;
  }>("/orgs/active", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ orgId }),
  });
  setAccessToken(r.token);
  writeCloudSyncToken(r.token);
  setActiveOrgId(r.activeOrgId);
  // The server's JWT carries both activeOrgId and activeSpaceId; without this
  // mirror write, WpnExplorer's useEffect([activeSpaceId]) won't refire on org
  // switch and the tree goes stale.
  if (r.activeSpaceId) {
    setActiveSpaceId(r.activeSpaceId);
  }
  return { token: r.token, activeOrgId: r.activeOrgId, activeSpaceId: r.activeSpaceId };
}

export type InviteSpaceGrantInfo = {
  spaceId: string;
  spaceName: string;
  role: SpaceRole;
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
  spaceGrants: InviteSpaceGrantInfo[];
};

export async function previewInvite(token: string): Promise<OrgInvitePreview> {
  return requestJson<OrgInvitePreview>(
    `/auth/invites/preview?token=${encodeURIComponent(token)}`,
    { method: "GET" },
  );
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
  spaceGrants: { spaceId: string; role: SpaceRole }[];
}> {
  const r = await requestJson<{
    token: string;
    refreshToken: string;
    userId: string;
    orgId: string;
    role: OrgRole;
    createdUser: boolean;
    spaceGrants?: { spaceId: string; role: SpaceRole }[];
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
  return { ...r, spaceGrants: r.spaceGrants ?? [] };
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
};

export async function listOrgSpaces(orgId: string): Promise<SpaceRow[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ spaces: SpaceRow[] }>(
    `/orgs/${encodeURIComponent(orgId)}/spaces`,
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
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/spaces/${encodeURIComponent(payload.spaceId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: payload.name }),
  });
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

// ----- Phase 3: Teams -----

export type TeamRow = {
  teamId: string;
  orgId: string;
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
  name: string;
  colorToken?: string;
}): Promise<{ teamId: string; orgId: string; name: string; colorToken: string | null }> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  return requestJson(`/orgs/${encodeURIComponent(payload.orgId)}/teams`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: payload.name,
      ...(payload.colorToken ? { colorToken: payload.colorToken } : {}),
    }),
  });
}

export async function updateTeam(payload: {
  teamId: string;
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
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/teams/${encodeURIComponent(payload.teamId)}/members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId: payload.userId }),
  });
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

export type TeamGrant = {
  spaceId: string;
  spaceName: string;
  role: SpaceRole;
  grantedAt: string;
};

export async function listTeamGrants(teamId: string): Promise<TeamGrant[]> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  const r = await requestJson<{ grants: TeamGrant[] }>(
    `/teams/${encodeURIComponent(teamId)}/grants`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return r.grants;
}

export async function grantTeamSpace(payload: {
  teamId: string;
  spaceId: string;
  role: SpaceRole;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(`/teams/${encodeURIComponent(payload.teamId)}/grants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ spaceId: payload.spaceId, role: payload.role }),
  });
}

export async function revokeTeamGrant(payload: {
  teamId: string;
  spaceId: string;
}): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    throw new Error("Unauthorized");
  }
  await requestJson(
    `/teams/${encodeURIComponent(payload.teamId)}/grants/${encodeURIComponent(payload.spaceId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
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
  spaceGrants: InviteSpaceGrantInfo[];
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

