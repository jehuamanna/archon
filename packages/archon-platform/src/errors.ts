export type SessionExpiredReason =
  | "refresh_failed_server"
  | "refresh_failed_network"
  | "retry_still_401"
  | "no_refresh_token"
  | "malformed_server_response"
  | "refresh_internal_error";

/**
 * Thrown by the auth-retry wrapper when an authenticated request could not be
 * recovered by a single refresh attempt. Phase 3's session-termination path is
 * the only legitimate catch site — individual callers should let it propagate.
 */
export class SessionExpiredError extends Error {
  readonly reason: SessionExpiredReason;
  constructor(reason: SessionExpiredReason, message?: string) {
    super(message ?? `Session expired: ${reason}`);
    this.name = "SessionExpiredError";
    this.reason = reason;
  }
}

/**
 * Thrown when the original request cannot be safely replayed after a refresh
 * (streaming body, one-shot multipart upload, etc). Callers decide whether to
 * re-materialize the request or surface the failure to the user.
 */
export class RetriableAfterLoginError extends Error {
  constructor(message?: string) {
    super(message ?? "Request cannot be replayed after token refresh");
    this.name = "RetriableAfterLoginError";
  }
}
