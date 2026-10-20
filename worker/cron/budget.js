// The time and subrequest budget of the nightly run. A Worker invocation may make a limited number of subrequests
// (D1, Vectorize, AI and R2 calls all count, a D1 batch counts once), so the whole run shares one subrequest pool and
// the steps stop when it is used. Each step also has its own time limit. What is left over is done on the next night.

export const DEFAULT_WALL_MS = 20_000;
// The cap is 50 per invocation on Free. The steps stop at 40, and the run's own two writes and the calls that do not
// check the budget (backup, purge_old) fit in the rest.
export const DEFAULT_SUBREQUESTS = 40;

/**
 * @param {{now: () => number, wallMs?: number, subrequests?: number, pool?: {spent: number}}} args
 *   pool is the count shared by the steps of one run. Without it the budget counts on its own.
 */
export function createBudget({ now, wallMs = DEFAULT_WALL_MS, subrequests = DEFAULT_SUBREQUESTS, pool = { spent: 0 } }) {
  const deadline = now() + wallMs;
  const budget = {
    /** Subrequests used so far by every step that shares the pool. */
    get spent() {
      return pool.spent;
    },
    set spent(n) {
      pool.spent = n;
    },
    limit: subrequests,
    /** Subrequests still available. */
    left: () => subrequests - pool.spent,
    /** True while there is time left and at least n subrequests. */
    has: (n = 1) => budget.left() >= n && now() < deadline,
  };
  return budget;
}

const counted = (target, budget) =>
  new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop];
      if (typeof value !== "function") return value;
      return (...args) => {
        budget.spent++;
        return value.apply(obj, args);
      };
    },
  });

function countedDb(db, budget) {
  const wrap = (statement) => ({
    inner: statement,
    bind: (...a) => wrap(statement.bind(...a)),
    first: (...a) => (budget.spent++, statement.first(...a)),
    all: (...a) => (budget.spent++, statement.all(...a)),
    run: (...a) => (budget.spent++, statement.run(...a)),
    raw: (...a) => (budget.spent++, statement.raw(...a)),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: (statements) => (budget.spent++, db.batch(statements.map((s) => s.inner ?? s))),
    exec: (sql) => (budget.spent++, db.exec(sql)),
  };
}

/**
 * The same bindings, with every call counted against the budget.
 * @param {Record<string, any>} env
 * @param {ReturnType<typeof createBudget>} budget
 */
export function countedEnv(env, budget) {
  const out = { ...env, DB: countedDb(env.DB, budget) };
  for (const name of ["VECTORIZE", "AI", "BACKUP_BUCKET"]) if (env[name]) out[name] = counted(env[name], budget);
  return out;
}
