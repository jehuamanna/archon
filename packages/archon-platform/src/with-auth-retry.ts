import { RetriableAfterLoginError, SessionExpiredError } from "./errors";

export type AuthRequestDescriptor = {
  method: string;
  url: string;
  /** All headers except Authorization; the wrapper attaches the bearer itself. */
  headersWithoutAuth: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  /** Opt-out of replay-after-refresh — use for streaming or one-shot bodies. */
  streamingBody?: boolean;
};

export type WithAuthRetryOptions = {
  /** Defaults to true. When false, a 401 causes RetriableAfterLoginError without replay. */
  replay?: boolean;
};

export type RefreshOnceFn = () => Promise<
  { ok: true; accessToken: string } | { ok: false; reason: string }
>;

export type WithAuthRetryDeps = {
  getAccessToken: () => string | null;
  refreshSessionOnce: RefreshOnceFn;
  fetch?: typeof fetch;
};

function buildInit(
  req: AuthRequestDescriptor,
  token: string | null,
): RequestInit {
  const headers: Record<string, string> = { ...req.headersWithoutAuth };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const init: RequestInit = {
    method: req.method,
    headers,
    signal: req.signal,
  };
  if (req.credentials !== undefined) {
    init.credentials = req.credentials;
  }
  if (req.body != null) {
    init.body = req.body;
  }
  return init;
}

export async function withAuthRetry(
  req: AuthRequestDescriptor,
  opts: WithAuthRetryOptions = {},
  deps: WithAuthRetryDeps,
): Promise<Response> {
  const replay = opts.replay !== false;
  const doFetch = deps.fetch ?? fetch;

  const firstToken = deps.getAccessToken();
  const firstRes = await doFetch(req.url, buildInit(req, firstToken));
  if (firstRes.status !== 401) {
    return firstRes;
  }

  // Drain the 401 body so the underlying response is closed. Callers never need it.
  try {
    await firstRes.text();
  } catch {
    /* ignore */
  }

  if (!replay || req.streamingBody === true) {
    throw new RetriableAfterLoginError();
  }

  let refreshResult: Awaited<ReturnType<RefreshOnceFn>>;
  try {
    refreshResult = await deps.refreshSessionOnce();
  } catch (err) {
    throw new SessionExpiredError("refresh_internal_error", String(err));
  }
  if (!refreshResult.ok) {
    const reason = refreshResult.reason;
    if (reason === "no_refresh_token") {
      throw new SessionExpiredError("no_refresh_token");
    }
    if (reason === "refresh_failed_network") {
      throw new SessionExpiredError("refresh_failed_network");
    }
    if (reason === "malformed_server_response") {
      throw new SessionExpiredError("malformed_server_response");
    }
    throw new SessionExpiredError("refresh_failed_server");
  }

  const secondRes = await doFetch(req.url, buildInit(req, refreshResult.accessToken));
  if (secondRes.status === 401) {
    try {
      await secondRes.text();
    } catch {
      /* ignore */
    }
    throw new SessionExpiredError("retry_still_401");
  }
  return secondRes;
}
