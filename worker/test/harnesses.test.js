import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callerLabel, DASHBOARD, foldByHarness, HARNESSES, harnessId, harnessLabel, harnessValues, knownHarness } from "../harnesses.js";
import { newStore } from "./helpers/memories.js";
import { appWith } from "./helpers/search.js";
import { raw, UI_HEADERS } from "./helpers/ui.js";
import { seed } from "./helpers/maintenance.js";

test("every harness has an id, a label and a lower case alias list, and no name is used twice", () => {
  const names = HARNESSES.flatMap((h) => [h.id, ...h.aliases]);
  assert.equal(new Set(names).size, names.length);
  for (const h of HARNESSES) {
    assert.match(h.id, /^[a-z]+$/);
    assert.ok(h.label.length > 0);
    for (const a of h.aliases) assert.equal(a, a.toLowerCase());
  }
  assert.deepEqual(HARNESSES.map((h) => h.label), ["Claude Code", "Codex", "Antigravity", "DSH", "Kilo", "ZCode"]);
  assert.equal(DASHBOARD.label, "Dashboard");
});

test("the client's copy of the list says the same as this one", () => {
  const py = readFileSync(fileURLToPath(new URL("../../client/hm/harnesses.py", import.meta.url)), "utf8");
  const ids = /^IDS = \((.*)\)$/m.exec(py)[1].match(/"([a-z]+)"/g).map((s) => s.slice(1, -1));
  const aliases = Object.fromEntries([.../^ALIASES = \{(.*)\}$/m.exec(py)[1].matchAll(/"([a-z-]+)": "([a-z]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(ids, HARNESSES.map((h) => h.id));
  assert.deepEqual(aliases, Object.fromEntries(HARNESSES.flatMap((h) => h.aliases.map((a) => [a, h.id]))));
});

test("an id or an alias finds its harness whatever the case, and anything else is unknown", () => {
  assert.equal(knownHarness("Codex").id, "codex");
  assert.equal(knownHarness(" antigravity ").id, "agy");
  assert.equal(knownHarness("claude-code").id, "claude");
  assert.equal(knownHarness("hermes"), undefined);
  assert.equal(knownHarness(""), undefined);
  assert.equal(knownHarness(null), undefined);
  assert.equal(harnessId("claude-code"), "claude");
  assert.equal(harnessId("some-new-tool"), "some-new-tool");
  assert.equal(harnessId(null), "");
  assert.deepEqual(harnessValues("claude"), ["claude", "claude-code"]);
  assert.deepEqual(harnessValues("claude-code"), ["claude", "claude-code"]);
  assert.deepEqual(harnessValues("hermes"), ["hermes"]);
  assert.deepEqual(harnessValues("MyTool"), ["mytool"], "an unknown name is compared in lower case");
});

test("the label of a memory comes from its harness, and a blank one says Imported or Unknown by its origin", () => {
  assert.equal(harnessLabel("claude", "capture"), "Claude Code");
  assert.equal(harnessLabel("agy", "explicit"), "Antigravity");
  assert.equal(harnessLabel("claude-code", "import"), "Claude Code", "a recorded name wins over the origin");
  assert.equal(harnessLabel("", "import"), "Imported");
  assert.equal(harnessLabel("", "explicit"), "Unknown");
  assert.equal(harnessLabel("", "capture"), "Unknown");
  assert.equal(harnessLabel("", "profile"), "Unknown");
  assert.equal(harnessLabel(null, undefined), "Unknown");
  assert.equal(harnessLabel("hermes", "capture"), "hermes", "a name this version does not know is shown as written");
  assert.equal(callerLabel("dashboard"), "Dashboard");
  assert.equal(callerLabel("codex"), "Codex");
  assert.equal(callerLabel(""), "Unknown");
  assert.equal(callerLabel("other"), "other");
});

test("rows are added up under one row per harness, an alias joins its harness, and the biggest comes first", () => {
  const rows = [{ harness: "codex", n: 2, k: 1 }, { harness: "claude-code", n: 3, k: 0 }, { harness: "claude", n: 4, k: 2 }, { harness: "", n: 1, k: 1 }, { harness: "dashboard", n: 9, k: 0 }];
  assert.deepEqual(foldByHarness(rows, ["n", "k"]), [
    { harness: "dashboard", label: "Dashboard", n: 9, k: 0 },
    { harness: "claude", label: "Claude Code", n: 7, k: 2 },
    { harness: "codex", label: "Codex", n: 2, k: 1 },
    { harness: "", label: "Unknown", n: 1, k: 1 },
  ]);
  assert.deepEqual(foldByHarness([], ["n"]), []);
});

test("the list filters by harness, an alias finds its harness, and none finds the blanks", async () => {
  const { add, store } = await newStore();
  const a = await add("claude one", [], { harness: "claude" });
  const b = await add("claude old import", [], { harness: "claude-code", origin: "import" });
  const c = await add("codex one", [], { harness: "codex" });
  const d = await add("blank import", [], { origin: "import" });
  const e = await add("blank explicit");
  const ids = async (f) => (await store.list(f)).entries.map((x) => x.id).sort();
  assert.deepEqual(await ids({ harness: "claude" }), [a.id, b.id].sort());
  assert.deepEqual(await ids({ harness: "claude-code" }), [a.id, b.id].sort());
  assert.deepEqual(await ids({ harness: "codex" }), [c.id]);
  assert.deepEqual(await ids({ harness: "none" }), [d.id, e.id].sort());
  assert.deepEqual(await ids({ harness: "kilo" }), []);
  assert.deepEqual(await ids({ harness: "none", origin: "import" }), [d.id], "it combines with another filter");
  assert.equal((await ids({})).length, 5);
});

test("GET /list takes harness, refuses a bad name, and the entries carry the label", async () => {
  const { app, ids } = await appWith([
    { content: "alpha note about otters", harness: "codex" },
    { content: "beta note about badgers", harness: "claude-code" },
    { content: "gamma note about herons", origin: "import" },
    { content: "delta note about stoats" },
  ]);
  const jwt = app.browserJwt("me@example.com");
  const get = async (q) => {
    const res = await raw(app, `/list?${q}`, { jwt, headers: UI_HEADERS });
    return { status: res.status, json: await res.json() };
  };
  const byLabel = (r) => Object.fromEntries(r.json.entries.map((e) => [e.id, e.harness_label]));
  assert.deepEqual(byLabel(await get("harness=codex")), { [ids[0]]: "Codex" });
  assert.deepEqual(byLabel(await get("harness=claude")), { [ids[1]]: "Claude Code" }, "saved through the capture route, an alias is stored as its id");
  assert.deepEqual(byLabel(await get("harness=none")), { [ids[2]]: "Imported", [ids[3]]: "Unknown" });
  assert.equal((await get("harness=CODEX")).json.entries.length, 1, "the case does not matter");
  assert.equal((await get("harness=")).json.entries.length, 4, "an empty filter is no filter");
  for (const bad of ["harness=a%20b", "harness=" + "x".repeat(65), "harness=a%3Bb"]) assert.equal((await get(bad)).status, 400, bad);
  assert.equal((await raw(app, "/list?harness=codex", {})).status, 401, "it needs a login like every read");
  const entry = await (await raw(app, `/entry?id=${ids[2]}`, { jwt })).json();
  assert.equal(entry.entry.harness_label, "Imported");
});

test("a recall result carries the harness and its label", async () => {
  const { app } = await appWith([{ content: "---\nname: otter-facts\ndescription: Sea otters hold hands\n---\nSea otters hold hands while they sleep.", harness: "kilo" }]);
  const res = await app.call("/recall?query=" + encodeURIComponent("do sea otters hold hands while they sleep") + "&count=0");
  assert.equal(res.status, 200);
  assert.equal(res.json.results[0].harness, "kilo");
  assert.equal(res.json.results[0].harness_label, "Kilo");
});

test("activity entries carry the harness label of the memory", async () => {
  const { createApp } = await import("./helpers/app.js");
  const { createStore } = await import("../memory/store.js");
  const app = await createApp();
  const store = createStore(app.env.DB, () => app.clock.t);
  const gone = await seed(app, { name: "never-used", ageDays: 70, harness: "zcode" });
  const blank = await seed(app, { name: "blank-one", ageDays: 70, origin: "import" });
  app.clock.t += 1000;
  await store.softDelete(gone, "retire_never_recalled");
  await store.softDelete(blank, "retire_never_recalled");
  const res = await raw(app, "/ui/api/activity", { jwt: app.browserJwt("me@example.com") });
  const rows = Object.fromEntries((await res.json()).entries.map((e) => [e.title, [e.harness, e.harness_label]]));
  assert.deepEqual(rows, { "never-used": ["zcode", "ZCode"], "blank-one": ["", "Imported"] });
});

test("a harness name nobody knows is stored as written and found by the same name, whatever its case", async () => {
  const { add, store } = await newStore();
  const a = await add("custom tool note", [], { harness: "MyTool" });
  await add("another", [], { harness: "codex" });
  const ids = async (f) => (await store.list(f)).entries.map((x) => x.id);
  assert.deepEqual(await ids({ harness: "MyTool" }), [a.id], "the name the Sources panel offers finds it");
  assert.deepEqual(await ids({ harness: "mytool" }), [a.id]);
  const { app, ids: appIds } = await appWith([{ content: "custom note about otters", harness: "MyTool" }]);
  const res = await raw(app, "/list?harness=MyTool", { jwt: app.browserJwt("me@example.com"), headers: UI_HEADERS });
  assert.deepEqual((await res.json()).entries.map((e) => e.id), appIds);
});

test("the audit filter finds a row saved under a case variant of a known id", async () => {
  const { createApp } = await import("./helpers/app.js");
  const { recordAudit } = await import("../audit.js");
  const app = await createApp();
  const add = (harness) => recordAudit(app.env.DB, { ts: app.clock.t++, actor: { kind: "device", id: "d1" }, harness, script: "", method: "GET", route: "/recall", status: 200, durationMs: 1, memoryIds: [] });
  await add("Claude");
  await add("claude-code");
  await add("codex");
  const res = await app.call("/audit?harness=claude");
  assert.deepEqual(res.json.entries.map((e) => e.harness).sort(), ["Claude", "claude-code"]);
});
