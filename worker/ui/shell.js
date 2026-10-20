// The frame around every screen: the sidebar with live counts, the drawer on a phone, the theme switch, the command palette
// and the remember dialog. Screens never touch it, they only ask it to refresh with the "anymem:changed" event.
import { html } from "./lib/html.js";
import { icon } from "./lib/components.js";
import { hashFor, NAV } from "./lib/route.js";
import { paletteItems } from "./lib/palette.js";
import { rememberCommand } from "./lib/remember.js";
import { currentTheme, setTheme, THEMES } from "./lib/theme.js";
import { VERSION_UNKNOWN, countFor, colophonText } from "./lib/shell-data.js";

const $ = (id) => document.getElementById(id);

/** The sidebar list, with the counts that are known so far. */
function drawNav(counts, current) {
  $("nav").innerHTML = String(html`${NAV.map((n, i) => {
    const c = countFor(n.name, counts);
    const sep = i > 0 && NAV[i - 1].group !== n.group;
    return html`<li class="${sep ? "nav__gap" : ""}"><a href="${hashFor(n.name)}" data-screen="${n.name}" aria-current="${n.name === current ? "page" : "false"}">${icon(n.icon)}<span class="nav__label">${n.label}</span>${c ? html`<span class="nav__count ${c.alert ? "is-alert" : ""}">${c.alert ? icon("warn") : ""}<span aria-hidden="true">${c.text}</span><span class="sr">${c.label}</span></span>` : ""}</a></li>`;
  })}`);
}

export function createShell({ request }) {
  const state = { counts: null, current: "home", version: VERSION_UNKNOWN };
  const side = $("side");
  const scrim = $("scrim");
  const openBtn = $("open-nav");

  const setDrawer = (open) => {
    side.classList.toggle("is-open", open);
    scrim.hidden = !open;
    openBtn.setAttribute("aria-expanded", String(open));
    $("main").inert = open && matchMedia("(max-width: 59.99rem)").matches;
    if (open) side.querySelector("a, button")?.focus();
    else if (document.activeElement && side.contains(document.activeElement)) openBtn.focus();
  };
  openBtn.addEventListener("click", () => setDrawer(true));
  $("close-nav").addEventListener("click", () => setDrawer(false));
  scrim.addEventListener("click", () => setDrawer(false));
  side.addEventListener("click", (e) => e.target.closest("a") && setDrawer(false));
  addEventListener("keydown", (e) => e.key === "Escape" && side.classList.contains("is-open") && setDrawer(false));
  $("kbd-hint").textContent = /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘K" : "Ctrl K";

  // Theme switch
  const themeBox = $("theme");
  const drawTheme = () => {
    const now = currentTheme();
    themeBox.innerHTML = String(html`<legend class="sr">Theme</legend>${THEMES.map((t) => html`<button type="button" class="seg__btn" data-theme-choice="${t}" aria-pressed="${t === now ? "true" : "false"}" title="${t === "auto" ? "Follow the system" : `${t[0].toUpperCase()}${t.slice(1)} theme`}">${icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon")}<span>${t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"}</span></button>`)}`);
  };
  themeBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-choice]");
    if (b) (setTheme(b.dataset.themeChoice), drawTheme());
  });
  drawTheme();

  function drawColophon() {
    const c = state.counts?.nav;
    $("colophon").innerHTML = String(colophonText({ version: state.version, host: location.host, unvectorized: c?.unvectorized, known: Boolean(c) }));
  }

  async function refresh() {
    try {
      const [home, health] = await Promise.all([request("/ui/api/home"), state.version === VERSION_UNKNOWN ? request("/health") : Promise.resolve(null)]);
      state.counts = home;
      if (health?.version) state.version = health.version;
    } catch {
      // the sidebar still works without its numbers
    }
    drawNav(state.counts, state.current);
    drawColophon();
    return state.counts;
  }

  // The command palette
  const dialog = $("palette");
  const input = $("palette-input");
  const list = $("palette-list");
  let items = [];
  let at = 0;
  const drawList = () => {
    items = paletteItems(input.value);
    at = Math.min(at, items.length - 1);
    list.innerHTML = String(html`${items.map((it, i) => html`<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === at ? "true" : "false"}"><span class="sheet__label">${it.label}</span><span class="sheet__hint">${it.hint}</span></li>`)}`);
    input.setAttribute("aria-activedescendant", items.length ? `pal-${at}` : "");
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    dialog.close();
    if (it.href) location.hash = it.href;
    else if (it.action === "remember") openRemember(input.value.trim());
  };
  const openPalette = () => {
    setDrawer(false);
    input.value = "";
    at = 0;
    drawList();
    dialog.showModal();
    input.focus();
  };
  input.addEventListener("input", () => ((at = 0), drawList()));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      drawList();
      list.querySelector(`#pal-${at}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") (e.preventDefault(), choose(at));
  });
  list.addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) choose(Number(li.dataset.i));
  });

  // The remember dialog. It builds a command. It saves nothing, a browser login may not save an explicit memory.
  const remember = $("remember");
  const rbody = $("remember-body");
  function openRemember(text = "") {
    rbody.innerHTML = String(html`<p class="muted">The dashboard cannot save a memory for you. That is deliberate, a browser login may only save profile and person notes. Write it here, copy the command, and run it where the anymem skill is installed, or hand it to an agent.</p>
      <label class="field">What to remember<textarea id="remember-text" rows="6" maxlength="30000" placeholder="One fact, with the reason for it">${text}</textarea></label>
      <pre class="code" id="remember-cmd" role="region" aria-label="The command" tabindex="0"></pre>
      <p class="sheet__actions"><button type="button" class="btn btn--primary" data-action="copy-command">${icon("copy")}Copy the command</button><span class="muted" id="remember-note" role="status"></span></p>`);
    const area = $("remember-text");
    const draw = () => ($("remember-cmd").textContent = rememberCommand(area.value) || "Write something above to see the command.");
    area.addEventListener("input", draw);
    draw();
    setDrawer(false);
    remember.showModal();
    area.focus();
  }
  rbody.addEventListener("click", async (e) => {
    if (!e.target.closest('[data-action="copy-command"]')) return;
    const cmd = rememberCommand($("remember-text").value);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      $("remember-note").textContent = "Copied.";
    } catch {
      $("remember-note").textContent = "Your browser blocked the copy. Select the command and copy it by hand.";
    }
  });
  for (const d of [dialog, remember]) d.addEventListener("click", (e) => e.target === d && d.close()); // a click on the backdrop closes

  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") (e.preventDefault(), dialog.open ? dialog.close() : openPalette());
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    if (b.dataset.action === "palette") openPalette();
    else if (b.dataset.action === "remember") openRemember(b.dataset.text ?? "");
    else if (b.dataset.action === "close-dialog") b.closest("dialog")?.close();
  });
  addEventListener("anymem:changed", () => refresh());

  return {
    refresh,
    openRemember,
    /** Mark the current screen in the sidebar and the phone bar. */
    current(name, title) {
      state.current = name;
      drawNav(state.counts, name);
      $("bar-title").textContent = title;
      setDrawer(false);
    },
    state,
  };
}
