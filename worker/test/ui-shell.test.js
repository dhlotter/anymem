import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteItems } from "../ui/lib/palette.js";
import { rememberCommand } from "../ui/lib/remember.js";
import { colophonText, countFor } from "../ui/lib/shell-data.js";
import { readPref, writePref } from "../ui/lib/prefs.js";
import { setTheme, currentTheme, THEMES } from "../ui/lib/theme.js";
import { NAV } from "../ui/lib/route.js";

/** A stand in for localStorage. Pass a failing one to see the page cope without storage. */
function withStorage(store, fn) {
  const before = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  try {
    return fn();
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: before });
  }
}
const memoryStore = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)) };
};
const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

test("the palette lists every screen for nothing typed, and filters them as you type", () => {
  const all = paletteItems("");
  assert.deepEqual(all.filter((i) => i.href).map((i) => i.id), NAV.map((n) => n.name));
  assert.ok(all.some((i) => i.action === "remember"));
  assert.deepEqual(paletteItems("hea").map((i) => i.id).filter((id) => id !== "search" && id !== "remember"), ["health"]);
  assert.deepEqual(paletteItems("AUD").filter((i) => i.href && i.id !== "search").map((i) => i.id), ["audit"]);
});

test("typed text offers a search and a remember, and a memory id offers to open it", () => {
  const items = paletteItems("restore window for the trash");
  assert.equal(items[0].id, "search");
  assert.equal(items[0].href, "#/search?q=restore+window+for+the+trash");
  assert.match(items[0].label, /^Search for “restore window for the trash”$/);
  assert.ok(items.some((i) => i.id === "remember" && i.action === "remember"));
  assert.equal(paletteItems("ab").some((i) => i.id === "search"), false, "two characters are too few to search");
  const id = "3a11233f-eab4-440f-9813-01c7a4e3d0ac";
  assert.deepEqual(paletteItems(id)[0], { id: "memory", label: "Open memory 3a11233f", hint: "Memory", href: `#/memories/${id}` });
  assert.match(paletteItems("x".repeat(80)).find((i) => i.id === "search").label, /…”$/, "a long query is cut in the label");
  assert.equal(paletteItems("nothing like a screen name zzz").filter((i) => i.href && i.id !== "search").length, 0);
});

test("the remember command is a heredoc that the text cannot end early", () => {
  assert.equal(rememberCommand("   "), "");
  assert.equal(rememberCommand(undefined), "");
  assert.equal(rememberCommand("One fact, with its reason.\n"), "remember.py <<'ANYMEM_TEXT'\nOne fact, with its reason.\nANYMEM_TEXT");
  const sneaky = rememberCommand("first\nANYMEM_TEXT\nrm -rf ~\nANYMEM_TEXT_1\nlast");
  assert.match(sneaky, /^remember\.py <<'ANYMEM_TEXT_2'\n/);
  assert.match(sneaky, /\nANYMEM_TEXT_2$/);
  assert.equal(rememberCommand("a\r\nb"), "remember.py <<'ANYMEM_TEXT'\na\nb\nANYMEM_TEXT", "windows line endings become plain ones");
  assert.match(rememberCommand("it's $HOME `x` \"q\""), /it's \$HOME `x` "q"/, "a quoted heredoc passes everything through untouched");
});

test("the sidebar counts are quiet when there is nothing to say and say it in words as well", () => {
  const nav = { live: 1042, trash: 0, pending: 2, activity_week: 3, capsule_chars: 8_800, capsule_cap: 9_500, attention: 1, unvectorized: 0 };
  assert.equal(countFor("home", { nav }), null);
  assert.deepEqual(countFor("memories", { nav }), { text: "1,042", label: "1,042 live memories", alert: false });
  assert.deepEqual(countFor("activity", { nav }), { text: "3", label: "3 changes by the system this week", alert: false });
  assert.equal(countFor("trash", { nav }), null);
  assert.deepEqual(countFor("capsule", { nav }), { text: "93%", label: "The capsule is at 93 percent of its cap", alert: true });
  assert.deepEqual(countFor("people", { nav }), { text: "2", label: "2 changes waiting for you", alert: true });
  assert.deepEqual(countFor("health", { nav }), { text: "1", label: "1 check needs attention", alert: true });
  assert.equal(countFor("health", { nav: { ...nav, attention: 3 } }).label, "3 checks need attention");
  assert.equal(countFor("subjects", { nav }), null, "no proposal, no number");
  assert.deepEqual(countFor("subjects", { nav: { ...nav, subjects_proposed: 1 } }), { text: "1", label: "1 subject waiting for you", alert: true });
  assert.equal(countFor("subjects", { nav: { ...nav, subjects_proposed: 12 } }).label, "12 subjects waiting for you");
  assert.equal(countFor("memories", null), null);
  assert.equal(countFor("capsule", { nav: { ...nav, capsule_chars: null } }), null);
  assert.equal(countFor("capsule", { nav: { ...nav, capsule_cap: undefined } }), null, "no cap from the Worker, no figure");
  assert.equal(countFor("capsule", { nav: { ...nav, capsule_chars: 100 } }).alert, false);
  assert.equal(countFor("capsule", { nav: { ...nav, capsule_chars: 5000, capsule_cap: 10_000 } }).text, "50%", "the cap comes from the Worker");
  assert.equal(countFor("trash", { nav: { ...nav, trash: 7 } }).label, "7 memories in the trash");
});

test("the sidebar foot says whether the index is in sync, the host and the version", () => {
  const ok = String(colophonText({ version: "2.0.0", host: "memory.example.com", unvectorized: 0, known: true }));
  assert.match(ok, /Index in sync/);
  assert.match(ok, /memory\.example\.com/);
  assert.match(ok, /Version 2\.0\.0/);
  assert.match(String(colophonText({ version: "", host: "h", unvectorized: 4, known: true })), /4 memories waiting for vectors/);
  assert.doesNotMatch(String(colophonText({ version: "", host: "h", unvectorized: 0, known: false })), /Index|Version/);
  assert.match(String(colophonText({ version: "", host: "<b>x</b>", unvectorized: 0, known: false })), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("preferences are read with a fallback, only valid values count, and blocked storage is survived", () => {
  const store = memoryStore();
  withStorage(store, () => {
    assert.equal(readPref("theme", THEMES, "auto"), "auto");
    writePref("theme", "dark");
    assert.equal(store.m.get("anymem-theme"), "dark");
    assert.equal(readPref("theme", THEMES, "auto"), "dark");
    store.m.set("anymem-theme", "<script>");
    assert.equal(readPref("theme", THEMES, "auto"), "auto", "a value that is not allowed is ignored");
    assert.deepEqual([...store.m.keys()].sort(), ["anymem-theme"], "nothing else is stored");
  });
  withStorage(blocked, () => {
    assert.equal(readPref("theme", THEMES, "auto"), "auto");
    assert.doesNotThrow(() => writePref("theme", "dark"));
  });
});

test("setTheme sets or clears data-theme on the root and remembers a valid choice", () => {
  const store = memoryStore();
  const root = { dataset: {} };
  withStorage(store, () => {
    assert.equal(setTheme("dark", root), "dark");
    assert.equal(root.dataset.theme, "dark");
    assert.equal(currentTheme(), "dark");
    assert.equal(setTheme("light", root), "light");
    assert.equal(root.dataset.theme, "light");
    assert.equal(setTheme("auto", root), "auto");
    assert.equal(root.dataset.theme, undefined, "auto leaves the choice to the system");
    assert.equal(setTheme("neon", root), "auto", "an unknown theme falls back to auto");
    assert.equal(store.m.get("anymem-theme"), "auto");
  });
});
