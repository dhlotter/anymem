// The optional host name check. ALLOWED_HOSTS is a comma list of host names. When it is set, a request for any other
// host name is a plain 404 before authentication runs and before anything is written. When it is not set, nothing changes.
import { HttpError, notFound } from "./http.js";

const HOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * Throws a 404 when ALLOWED_HOSTS is set and the request host is not in it. Throws a 500 when the setting is unusable.
 * @param {Record<string, any>} env
 * @param {URL} url
 */
export function checkHost(env, url) {
  const raw = env.ALLOWED_HOSTS;
  if (raw === undefined) return;
  const hosts = String(raw).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length || !hosts.every((h) => HOST_NAME.test(h))) {
    throw new HttpError(500, "misconfigured", "ALLOWED_HOSTS must be a comma list of host names, for example memory.example.com.");
  }
  if (!hosts.includes(url.hostname.toLowerCase().replace(/\.$/, ""))) throw notFound("No such route.");
}
