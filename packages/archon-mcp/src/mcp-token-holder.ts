/** Mutable access + refresh tokens for cloud MCP (session or env). */
export class McpTokenHolder {
  accessToken = "";
  refreshToken: string | null = null;
  /** Active organization context; sent as `X-Archon-Org` on every WPN call. */
  activeOrgId: string | null = null;
  /**
   * Active team context. Carried in the JWT (`activeTeamId`) and refreshed
   * by `POST /orgs/active`. Not sent as a header — the server reads it from
   * the JWT — but tracked here so callers can show the active-team UI hint.
   */
  activeTeamId: string | null = null;

  setTokens(access: string, refresh: string | null): void {
    this.accessToken = access.trim();
    this.refreshToken = refresh?.trim() ? refresh.trim() : null;
  }

  setActiveOrg(orgId: string | null): void {
    this.activeOrgId = orgId && orgId.trim() ? orgId.trim() : null;
  }

  setActiveTeam(teamId: string | null): void {
    this.activeTeamId = teamId && teamId.trim() ? teamId.trim() : null;
  }

  clear(): void {
    this.accessToken = "";
    this.refreshToken = null;
    this.activeOrgId = null;
    this.activeTeamId = null;
  }

  hasAccess(): boolean {
    return this.accessToken.length > 0;
  }
}
