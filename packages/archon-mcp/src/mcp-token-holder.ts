/** Mutable access + refresh tokens for cloud MCP (session or env). */
export class McpTokenHolder {
  accessToken = "";
  refreshToken: string | null = null;
  /** Active organization context (Phase 1); sent as `X-Archon-Org` on every WPN call. */
  activeOrgId: string | null = null;
  /** Active space context (Phase 2); sent as `X-Archon-Space` on every WPN call. */
  activeSpaceId: string | null = null;

  setTokens(access: string, refresh: string | null): void {
    this.accessToken = access.trim();
    this.refreshToken = refresh?.trim() ? refresh.trim() : null;
  }

  setActiveOrg(orgId: string | null): void {
    this.activeOrgId = orgId && orgId.trim() ? orgId.trim() : null;
  }

  setActiveSpace(spaceId: string | null): void {
    this.activeSpaceId = spaceId && spaceId.trim() ? spaceId.trim() : null;
  }

  clear(): void {
    this.accessToken = "";
    this.refreshToken = null;
    this.activeOrgId = null;
    this.activeSpaceId = null;
  }

  hasAccess(): boolean {
    return this.accessToken.length > 0;
  }
}
