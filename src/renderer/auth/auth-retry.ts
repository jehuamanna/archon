import {
  withAuthRetry,
  type AuthRequestDescriptor,
  type WithAuthRetryOptions,
} from "@archon/platform";
import { readCloudSyncToken } from "../cloud-sync/cloud-sync-storage";
import { refreshSessionOnce } from "./refresh-session";

/**
 * Renderer-side binding of the generic withAuthRetry to our token storage and
 * single-flight refresh primitive. Every Authorization: Bearer-bearing callsite
 * in the renderer routes through this so 401s are recovered transparently.
 */
export async function authedFetch(
  req: AuthRequestDescriptor,
  opts: WithAuthRetryOptions = {},
): Promise<Response> {
  return withAuthRetry(req, opts, {
    getAccessToken: readCloudSyncToken,
    refreshSessionOnce,
  });
}
