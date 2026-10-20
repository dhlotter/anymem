// A fake of the D1 binding on node:sqlite. Covers prepare, bind, first, all, run, raw, batch and exec.
import { DatabaseSync } from "node:sqlite";

const MAX_PARAMS = 100; // D1 allows 100 bound parameters per statement

function meta(changes = 0, lastRowId = 0, sizeAfter = 0) {
  return { duration: 0, size_after: sizeAfter, changes, last_row_id: lastRowId, rows_read: 0, rows_written: changes, changed_db: changes > 0 };
}

/** The database size in bytes, as D1 reports it in meta.size_after. */
const sizeOf = (db) => Number(db.prepare("PRAGMA page_count").get().page_count) * Number(db.prepare("PRAGMA page_size").get().page_size);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    if (params.length > MAX_PARAMS) throw new Error("D1_ERROR: too many SQL variables");
    if (params.some((p) => p === undefined)) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    return new Statement(this.db, this.sql, params.map((p) => (typeof p === "boolean" ? Number(p) : p)));
  }

  execute() {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length > 0) return { results: stmt.all(...this.params), meta: meta(0, 0, sizeOf(this.db)) };
    const res = stmt.run(...this.params);
    return { results: [], meta: meta(Number(res.changes), Number(res.lastInsertRowid), sizeOf(this.db)) };
  }

  async first(column) {
    const row = this.execute().results[0] ?? null;
    return column && row ? row[column] : row;
  }

  async all() {
    return { success: true, ...this.execute() };
  }

  async run() {
    return { success: true, ...this.execute() };
  }

  async raw() {
    return this.execute().results.map((r) => Object.values(r));
  }
}

export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }

  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }

  /** Runs every statement in one transaction, like D1. A failure rolls all of them back. */
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => ({ success: true, ...s.execute() }));
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
}
