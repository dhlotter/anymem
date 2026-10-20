// Helpers for the dashboard tests. A fake of the static assets binding that reads worker/ui, and a raw request helper.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));

/** Behaves like the ASSETS binding with html_handling none: the exact file or a 404, with an etag of its bytes. */
export const fakeAssets = {
  async fetch(request) {
    const path = normalize(join(UI_DIR, new URL(request.url).pathname));
    if (!path.startsWith(UI_DIR)) return new Response("no", { status: 404 });
    try {
      const bytes = await readFile(path);
      const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}"`;
      return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", etag } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

/** A request that returns the raw Response. headers override the defaults. */
export async function raw(app, path, { method = "GET", jwt, token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (jwt) h["cf-access-jwt-assertion"] = jwt;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) (init.body = JSON.stringify(body)), (h["content-type"] = "application/json");
  const res = await app.worker.fetch(new Request(`https://anymem-worker.test${path}`, init), app.env, app.ctx);
  await app.settle();
  return res;
}

/** The headers a dashboard page sends with every write. */
export const UI_HEADERS = { origin: "https://anymem-worker.test", "sec-fetch-site": "same-origin", "x-anymem-ui": "1" };

/** A dashboard read as a browser login by default, with its status and parsed body. */
export async function api(app, path, { jwt, token } = {}) {
  const res = await raw(app, path, { jwt: jwt ?? app.browserJwt("me@example.com"), token });
  return { status: res.status, json: await res.json() };
}
