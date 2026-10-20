// Static checks over every dashboard file: no outside requests, no eval, no inline handlers, no unescaped HTML sinks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { UI_DIR } from "./helpers/ui.js";

const files = (dir = UI_DIR) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const all = files().map((path) => ({ path, name: relative(UI_DIR, path), text: readFileSync(path, "utf8") }));
const scripts = all.filter((f) => f.name.endsWith(".js"));

test("the dashboard is plain files of three kinds, and every screen has its own module", () => {
  assert.ok(all.length >= 20);
  for (const f of all) assert.match(f.name, /\.(html|js|css)$/, f.name);
  for (const screen of ["home", "search", "memories", "activity", "trash", "capsule", "people", "health", "audit"]) assert.ok(all.some((f) => f.name === `screens/${screen}.js`), screen);
  for (const f of scripts.filter((s) => s.name.startsWith("screens/"))) {
    assert.match(f.text, /export const title = /, `${f.name} has no title`);
    assert.match(f.text, /export function mount\(/, `${f.name} has no mount`);
  }
});

test("no file mentions another site, a CDN, a web font or a protocol relative URL", () => {
  for (const f of all) {
    assert.doesNotMatch(f.text, /https?:\/\//i, `${f.name} has an external URL`);
    assert.doesNotMatch(f.text, /(^|[\s"'(=])\/\/[a-z0-9]/i, `${f.name} has a protocol relative URL`);
    assert.doesNotMatch(f.text, /@import|@font-face|url\(\s*["']?(?!data:)/i, `${f.name} loads a resource from CSS`);
    assert.doesNotMatch(f.text, /\b(WebSocket|EventSource|sendBeacon|XMLHttpRequest|importScripts|serviceWorker)\b/, `${f.name} opens another kind of connection`);
  }
});

test("no eval, no Function constructor, no string timers, no document.write", () => {
  for (const f of scripts) {
    assert.doesNotMatch(f.text, /\beval\s*\(|new\s+Function\b|\bFunction\s*\(|document\.write|set(Timeout|Interval)\s*\(\s*["'`]/, f.name);
  }
});

test("no inline event handlers, inline scripts or inline styles in any file, including generated markup", () => {
  for (const f of all) {
    assert.doesNotMatch(f.text, /\son[a-z]+\s*=\s*["'{$]/i, `${f.name} has an inline event handler`);
    assert.doesNotMatch(f.text, /\sstyle\s*=/i, `${f.name} has an inline style`);
    assert.doesNotMatch(f.text, /javascript:/i, `${f.name} has a javascript: URL`);
  }
  const page = all.find((f) => f.name === "index.html").text;
  assert.deepEqual([...page.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim()), ['src="/ui/theme-init.js"', 'type="module" src="/ui/app.js"']);
  assert.doesNotMatch(page, /<style\b/i);
  assert.doesNotMatch(page, /<script[^>]*>[^<]+<\/script>/i);
});

test("markup reaches the page only through String(view), and only the html helper makes markup", () => {
  for (const f of scripts) {
    for (const m of f.text.matchAll(/\.(innerHTML|outerHTML)\s*=\s*([^;\n]*)/g)) {
      assert.match(m[2], /^String\(/, `${f.name} sets ${m[1]} with something other than String(view): ${m[2]}`);
    }
    assert.doesNotMatch(f.text, /insertAdjacentHTML|createContextualFragment|DOMParser|srcdoc/, f.name);
    if (f.name !== "lib/html.js") assert.doesNotMatch(f.text, /\braw\(/, `${f.name} uses raw()`);
  }
});

test("only lib/api.js talks to the network, and it always sends X-Anymem-UI and never touches a token", () => {
  for (const f of scripts) {
    if (f.name === "lib/api.js") continue;
    assert.doesNotMatch(f.text, /\bfetch\s*\(/, `${f.name} calls fetch directly`);
  }
  const api = scripts.find((f) => f.name === "lib/api.js").text;
  assert.match(api, /"X-Anymem-UI": "1"/);
  assert.doesNotMatch(api, /authorization|bearer|localStorage|document\.cookie/i);
});

test("the browser keeps only the theme, in two files, and never a token or memory text", () => {
  const users = scripts.filter((f) => /localStorage|sessionStorage|document\.cookie|indexedDB/.test(f.text)).map((f) => f.name);
  assert.deepEqual(users.sort(), ["lib/prefs.js", "theme-init.js"]);
  const prefs = scripts.find((f) => f.name === "lib/prefs.js").text;
  assert.match(prefs, /const KEYS = \{ theme: "anymem-theme" \};/);
  assert.deepEqual([...prefs.matchAll(/localStorage\.(\w+)\(/g)].map((m) => m[1]).sort(), ["getItem", "setItem"]);
  assert.doesNotMatch(prefs, /document\.cookie|sessionStorage|indexedDB/);
  const init = scripts.find((f) => f.name === "theme-init.js").text;
  assert.deepEqual([...init.matchAll(/localStorage\.(\w+)\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]), [["getItem", "anymem-theme"]]);
  for (const f of scripts.filter((s) => s.name.startsWith("screens/") || s.name === "shell.js")) assert.doesNotMatch(f.text, /localStorage|sessionStorage|indexedDB|document\.cookie/, f.name);
});

test("every colour in the stylesheets comes from a token, and the fonts are named tokens", () => {
  const sheets = all.filter((f) => f.name.endsWith(".css"));
  assert.equal(sheets.length, 3);
  for (const f of sheets) {
    // the token blocks are the rules whose selector starts with :root
    const rest = f.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:root[^{]*\{[^}]*\}/g, "");
    assert.doesNotMatch(rest, /#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab|lch|lab|color-mix)\(/i, `${f.name} has a colour outside the tokens`);
    assert.doesNotMatch(rest, /font-family:(?!\s*var\()/i, `${f.name} names a font outside the tokens`);
    assert.doesNotMatch(rest, /transition:\s*all|transition-property:\s*all|\bbackground-clip:\s*text|(linear|radial|conic)-gradient\(/i, `${f.name} has a banned effect`);
  }
  const tokens = all.find((f) => f.name === "style.css").text;
  assert.doesNotMatch(tokens, /#000\b|#fff\b|\boklch\(\s*(100|0)%/i, "no pure black or white");
});

test("every script parses as an ES module", () => {
  for (const f of scripts) {
    const res = spawnSync(process.execPath, ["--check", f.path], { encoding: "utf8" });
    assert.equal(res.status, 0, `${f.name}: ${res.stderr}`);
  }
});

test("every module imported by another one exists", () => {
  for (const f of scripts) {
    for (const m of f.text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = join(f.path, "..", m[1]);
      assert.ok(statSync(target).isFile(), `${f.name} imports ${m[1]}`);
    }
  }
});

test("the page has landmarks, a language, a viewport, a skip link and both colour schemes", () => {
  const page = all.find((f) => f.name === "index.html").text;
  assert.match(page, /<html lang="en">/);
  assert.match(page, /name="viewport"/);
  assert.match(page, /<main id="main"/);
  assert.match(page, /<nav aria-label=/);
  assert.match(page, /class="skip"/);
  const css = all.find((f) => f.name === "style.css").text;
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /:focus-visible/);
});

test("every form field in the generated screens has a visible label", () => {
  for (const f of scripts.filter((s) => s.name.startsWith("screens/"))) {
    for (const m of f.text.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      if (/type="(checkbox|hidden)"/.test(m[2])) continue;
      const before = f.text.slice(Math.max(0, m.index - 220), m.index);
      assert.match(before, /<label[^>]*>[^<]*(<\/label>)?[^<]*$|<label[^>]*>[^<$]*\$\{[^}]*\}\s*$/s, `${f.name}: ${m[0].slice(0, 60)} is not inside a label`);
    }
  }
});

test("no screen puts aria-live on a page, a table or a list, so a load reads one status line and not the whole page", () => {
  for (const f of scripts.filter((s) => s.name.startsWith("screens/"))) assert.doesNotMatch(f.text, /aria-live/, `${f.name} has an aria-live region`);
  const memories = scripts.find((f) => f.name === "screens/memories.js").text;
  assert.match(memories, /<span data-count role="status">/, "the one line that says how many memories are shown is the status");
});
