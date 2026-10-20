// A store on a migrated fake database with a clock the test controls, and a small way to add sample memories.
import { createStore } from "../../memory/store.js";
import { parseMemory } from "../../memory/parse.js";
import { START, migratedDb } from "./app.js";

export async function newStore() {
  const db = await migratedDb();
  const clock = { t: START };
  const store = createStore(db, () => clock.t);
  /** Parse and create. extra overrides provenance. */
  const add = async (content, tags = [], extra = {}) => store.create({ ...(await parseMemory(content, tags)), origin: "explicit", ...extra });
  const ftsHits = async (text) => (await db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?").bind(`"${text}"`).all()).results.map((r) => r.memory_id);
  return { db, clock, store, add, ftsHits };
}
