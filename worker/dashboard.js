// The dashboard files. They live in ui/ and are served from the Workers static assets binding (ASSETS), but only after
// the Worker has checked the login, because the assets block sets run_worker_first. Every file gets a strict
// Content-Security-Policy and a content type chosen here, not guessed by the platform.
import { notFound } from "./http.js";

/** Scripts and styles only from this origin, nothing inline, no frames, no forms to other sites. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** The headers every dashboard reply carries. The etag lets a browser ask again and get a 304 when the file has not changed. */
export const uiHeaders = (type, etag) => ({
  "content-type": type,
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-cache",
  ...(etag ? { etag } : {}),
});

/** True when an If-None-Match header names this etag, in its list, weak or strong. */
export const matchesEtag = (header, etag) => {
  const weak = (t) => t.replace(/^W\//, "");
  return typeof header === "string" && header.split(",").some((t) => t.trim() === "*" || weak(t.trim()) === weak(etag));
};

/** The asset path for a request path, or null when it is not a dashboard file. */
export function assetPath(pathname) {
  if (pathname === "/" || pathname === "/ui" || pathname === "/ui/") return "/index.html";
  if (!pathname.startsWith("/ui/")) return null;
  const path = pathname.slice("/ui".length);
  return /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) && !path.includes("..") ? path : null;
}

/** GET / and GET /ui/* */
export async function serveUi({ env, url, request }) {
  const path = assetPath(url.pathname);
  const type = path ? TYPES[path.slice(path.lastIndexOf("."))] : undefined;
  if (!path || !type || !env.ASSETS) throw notFound("No such page.");
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  if (!res.ok) throw notFound("No such page.");
  const etag = res.headers.get("etag") ?? undefined;
  if (etag && matchesEtag(request?.headers.get("if-none-match"), etag)) {
    void res.body?.cancel();
    return new Response(null, { status: 304, headers: uiHeaders(type, etag) });
  }
  return new Response(res.body, { status: 200, headers: uiHeaders(type, etag) });
}
