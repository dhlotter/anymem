// Helpers for tests that go through the routes and wait for the background indexing.
import { createApp } from "./app.js";

/** An app with memories stored through POST /capture. Each item is a content string or {content, tags, origin, ...}. Returns the ids in order. */
export async function appWith(items, appOptions) {
  const app = await createApp(appOptions);
  const ids = [];
  for (const item of items) {
    const body = typeof item === "string" ? { content: item } : item;
    const res = await app.call("/capture", { method: "POST", body });
    if (res.status !== 200) throw new Error(`capture failed ${res.status} ${JSON.stringify(res.json)}`);
    ids.push(res.json.id);
    app.clock.t += 5;
  }
  return { app, ids };
}

/** A memory text with frontmatter. */
export const note = (name, description, body = "") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

/** The result names of a recall reply, in order. */
export const names = (res) => res.json.results.map((r) => r.name);
