// The lifecycle planner and the migration runner exist in JavaScript (here) and in Python (client/tests/test_parity.py). Both
// read test/fixtures/parity.json, so a change to one side that the other does not make fails one of the two tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PREFIX, RULE_ID, MAX_AGE_SECONDS, planRules } from "../scripts/set-lifecycle.js";
import { listMigrations, migrate } from "../migrate.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

test("the backup rule has the same id, prefix and age on both sides", () => {
  assert.deepEqual({ id: RULE_ID, prefix: PREFIX, max_age_seconds: MAX_AGE_SECONDS }, fixture.rule);
});

test("the lifecycle planner says what the fixture says, and keeps the other rules", () => {
  for (const c of fixture.lifecycle) {
    const { rules, changed } = planRules(c.current);
    assert.equal(changed, c.changed, c.name);
    const mine = rules.filter((r) => r.id === fixture.rule.id);
    assert.equal(mine.length, 1, `${c.name}: one backup rule`);
    assert.deepEqual(mine[0], { id: RULE_ID, enabled: true, conditions: { prefix: PREFIX }, deleteObjectsTransition: { condition: { type: "Age", maxAge: MAX_AGE_SECONDS } } }, c.name);
    assert.deepEqual(rules.filter((r) => r.id !== fixture.rule.id), c.current.filter((r) => r.id !== fixture.rule.id), `${c.name}: other rules kept`);
  }
});

test("the migration runner applies exactly the versions after the recorded one, in order", async () => {
  const migrations = listMigrations();
  for (const current of fixture.migrations_current) {
    const written = [];
    // A migration is applied in the same request as its schema_version row, so that row is what is counted.
    const execute = async (sql) => {
      if (sql.includes("INSERT INTO meta")) written.push(Number(/'schema_version', '(\d+)'/.exec(sql)[1]));
      if (sql.includes("SELECT value FROM meta")) return current ? [{ value: String(current) }] : [];
      return [];
    };
    const applied = await migrate({ execute, migrations });
    assert.deepEqual(applied, migrations.map((m) => m.version).filter((v) => v > current), `recorded version ${current}`);
    assert.deepEqual(written, applied);
  }
});
