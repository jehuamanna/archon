export type OrgRole = "admin" | "member";

export type AuthUserOrg = {
  orgId: string;
  name: string;
  slug: string;
  role: OrgRole;
  isDefault: boolean;
};

export type SpaceRole = "owner" | "member" | "viewer";

export type AuthUserSpace = {
  spaceId: string;
  orgId: string;
  name: string;
  kind: "default" | "normal";
  role: SpaceRole;
};

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  isAdmin?: boolean;
  /** Platform-wide master admin — distinct from per-org admin. */
  isMasterAdmin?: boolean;
  orgs?: AuthUserOrg[];
  activeOrgId?: string | null;
};

let accessToken: string | null = null;
let activeOrgId: string | null = null;
let activeSpaceId: string | null = null;
let activeTeamId: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token && token.trim().length > 0 ? token.trim() : null;
}

export function getActiveOrgId(): string | null {
  return activeOrgId;
}

export function setActiveOrgId(orgId: string | null): void {
  activeOrgId = orgId && orgId.trim().length > 0 ? orgId.trim() : null;
}

/**
 * Vestigial after the org/team migration. The sync-api dropped the
 * `spaces` table and stopped reading the `X-Archon-Space` request
 * header; `getActiveSpaceId` returns whatever was last set by legacy
 * code paths but is no longer authoritative. New code should use
 * `getActiveTeamId` instead.
 *
 * @deprecated remove once #5 (frontend explorer) ports its last consumer.
 */
export function getActiveSpaceId(): string | null {
  return activeSpaceId;
}

/** @deprecated see `getActiveSpaceId`. */
export function setActiveSpaceId(spaceId: string | null): void {
  activeSpaceId = spaceId && spaceId.trim().length > 0 ? spaceId.trim() : null;
}

/**
 * Active team id for the current org (mirrored from the JWT after
 * `POST /orgs/active`). Tracked so renderer-side UI can show the
 * active-team hint; the sync-api reads the team claim from the JWT,
 * not from a request header.
 */
export function getActiveTeamId(): string | null {
  return activeTeamId;
}

export function setActiveTeamId(teamId: string | null): void {
  activeTeamId = teamId && teamId.trim().length > 0 ? teamId.trim() : null;
}

