// Every network call the dashboard makes goes through here. Each one is same origin, carries the login cookie the browser
// already has, and sends X-Anymem-UI: 1, which the Worker needs before it accepts a write. No token is ever read or stored.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A route that this Worker does not have (yet). The screen shows a plain notice instead of an error. */
export const isMissingRoute = (err) => err instanceof ApiError && (err.status === 404 || err.status === 405) && (err.code === "not_found" || err.code === "method_not_allowed");

/**
 * @param {string} path a path on this site, with its query string
 * @param {{method?: string, body?: any}} [opts]
 * @param {typeof fetch} [fetchFn] replaced in tests
 */
export async function request(path, { method = "GET", body } = {}, fetchFn = (...a) => fetch(...a)) {
  const headers = { "X-Anymem-UI": "1", "X-Anymem-Harness": "dashboard", accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetchFn(path, { method, headers, credentials: "same-origin", cache: "no-store", redirect: "manual", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network", "Could not reach the Worker. Check your connection, and reload the page if your login has expired.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new ApiError(res.status, "not_json", "The Worker did not answer with data. Your login may have expired, reload the page.");
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.code ?? "error", data.error ?? `Request failed with status ${res.status}.`);
  return data;
}

/** The text to show for a failed call. A lost race on an edit gets its own wording. */
export function describeError(err) {
  if (!(err instanceof ApiError)) return "Something went wrong in the page.";
  if (err.code === "stale_update" || err.code === "lost_race") return `Someone else changed this memory first. Nothing was saved. Reload the memory to see the newer version, then redo your change. (${err.message})`;
  if (err.code === "csrf_rejected") return "The Worker refused this change because it did not look like it came from this page. Reload and try again.";
  return err.message;
}
