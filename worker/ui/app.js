// The dashboard. One page, hash routes, one small module per screen, and the shell around them.
import { request } from "./lib/api.js";
import { hashFor, parseHash } from "./lib/route.js";
import { createShell } from "./shell.js";
import * as activity from "./screens/activity.js";
import * as audit from "./screens/audit.js";
import * as capsule from "./screens/capsule.js";
import * as health from "./screens/health.js";
import * as home from "./screens/home.js";
import * as memories from "./screens/memories.js";
import * as people from "./screens/people.js";
import * as search from "./screens/search.js";
import * as subjects from "./screens/subjects.js";
import * as trash from "./screens/trash.js";

const SCREENS = { home, search, memories, activity, trash, capsule, people, subjects, health, audit };
const main = document.getElementById("main");
const shell = createShell({ request });
const ctx = { request, now: () => Date.now(), shell };
let shown = null; // { name, handle } the screen on show, and what its mount returned

function route() {
  const { name, arg, params } = parseHash(location.hash);
  const screen = SCREENS[name];
  const canonical = hashFor(name, { arg, params });
  if (location.hash && location.hash !== canonical && /^#\/(browse|memory)\b/.test(location.hash)) history.replaceState(null, "", canonical);
  // A screen that can follow its own address (the memories list with its side panel) keeps its place instead of reloading.
  if (shown?.name === name && shown.handle?.update) {
    shown.handle.update(arg, params);
    return;
  }
  const view = document.createElement("section");
  view.className = `screen screen--${name}`;
  main.replaceChildren(view);
  document.title = `${screen.title}, anymem`;
  shell.current(name, screen.title);
  shown = { name, handle: screen.mount(view, ctx, arg, params) };
  main.focus({ preventScroll: true });
  scrollTo(0, 0);
}

// A memory link on a screen that has the drawer opens the drawer there, so reading never takes you off the page you are on.
const WITH_DRAWER = new Set(["home", "search", "activity", "trash", "capsule", "people", "subjects", "audit"]);
main.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#/memories/"]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const { name, params } = parseHash(location.hash);
  if (!WITH_DRAWER.has(name)) return;
  e.preventDefault();
  location.hash = hashFor(name, { arg: parseHash(a.getAttribute("href")).arg, params });
});

addEventListener("hashchange", route);
shell.refresh();
route();

