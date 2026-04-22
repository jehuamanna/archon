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

export function getActiveSpaceId(): string | null {
  return activeSpaceId;
}

export function setActiveSpaceId(spaceId: string | null): void {
  activeSpaceId = spaceId && spaceId.trim().length > 0 ? spaceId.trim() : null;
}

