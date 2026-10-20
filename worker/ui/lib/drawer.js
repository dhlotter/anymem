// The memory drawer. One memory with its history, a diff of every change, and the actions: edit, append, change status, link, undo
// and move to the trash. It slides in from the right on any screen that lists memories, so a row never takes you away from the list.
// A screen gives it where closing goes and what to do after a change, and the screen's own address holds the open memory.
import { ApiError } from "./api.js";
import { badge, icon, memoryLink, provenance, tagList } from "./components.js";
import { diffCounts, diffLines, withContext } from "./diff.js";
import { attempt, formValues, notify, onAction, onSubmit, say } from "./dom.js";
import { splitTags, STATUSES } from "./filters.js";
import { ago, count, DAY_MS, formatTime, titleOf } from "./format.js";
import { harnessText, recalledByView, savedByText } from "./harness.js";
import { html } from "./html.js";
import { hashFor } from "./route.js";

const when = (ms, now) => (ms ? html`${formatTime(ms)} (${ago(ms, now)})` : "none");

/** The facts of a memory. Saved by and Recalled by tool come from the extras, and are left out when the Worker does not send them. */
export function factsView(e, extras, now) {
  const saved = savedByText(extras?.saved_by, now);
  const used = recalledByView(extras);
  return html`<dl class="facts">
  <div><dt>Origin</dt><dd>${e.origin}</dd></div><div><dt>Tool</dt><dd>${harnessText(e)}</dd></div><div><dt>Session</dt><dd class="mono">${e.session || "none"}</dd></div>
  ${saved === null ? "" : html`<div><dt>Saved by</dt><dd>${saved}</dd></div>`}
  <div><dt>Kind</dt><dd>${e.kind ?? "not classified"}</dd></div><div><dt>Pinned</dt><dd>${e.pinned ? "yes" : "no"}</dd></div>
  <div><dt>Recalled</dt><dd>${e.recall_count} ${e.recall_count === 1 ? "time" : "times"}, last ${e.last_recalled_at ? ago(e.last_recalled_at, now) : "never"}</dd></div>
  ${used ? html`<div class="facts__wide"><dt>Recalled by</dt><dd>${used.text}<span class="cell__sub">${used.note}</span></dd></div>` : ""}
  <div><dt>Probation ends</dt><dd>${extras?.probation_until ? when(extras.probation_until, now) : "not on probation"}</dd></div>
  <div><dt>Valid from</dt><dd>${when(e.valid_from, now)}</dd></div>
  <div><dt>Valid until</dt><dd>${e.valid_until ? when(e.valid_until, now) : "still valid"}</dd></div>
  <div><dt>Saved</dt><dd>${when(e.created_at, now)}</dd></div><div><dt>Changed</dt><dd>${when(e.updated_at, now)}</dd></div>
  <div><dt>Id</dt><dd class="mono">${e.id}</dd></div></dl>`;
}

export const linksView = (links) =>
  links === null ? "" : html`<h3 class="h3">Links</h3>${links.length ? html`<ul class="plain">${links.map((l) => html`<li>${l.direction === "out" ? "Links to" : "Linked from"} <a href="${memoryLink(l.id)}">${l.name || l.id.slice(0, 8)}</a> <span class="muted">${l.type}</span></li>`)}</ul>` : html`<p class="muted">No links yet.</p>`}`;

/** One line of a diff. The marker is drawn by the stylesheet and the words are for a screen reader. */
export function diffView(before, after, label) {
  const all = diffLines(before, after);
  const ops = withContext(all);
  const { added, removed } = diffCounts(all);
  if (!added && !removed) return html`<p class="muted">${label} did not change the text. The change was to tags, status or something else.</p>`;
  return html`<p class="muted">${label} added ${count(added, "line")} and removed ${count(removed, "line")}.</p>
    <div class="diff" role="group" aria-label="Changes to the text">${ops.map((o) => (o.type === "skip" ? html`<p class="diff__skip">${o.text}</p>` : html`<p class="diff__line diff__line--${o.type}"><span class="sr">${o.type === "add" ? "Added " : o.type === "del" ? "Removed " : "Unchanged "}</span>${o.text || " "}</p>`))}</div>`;
}

export const historyView = (versions, now) =>
  html`<h3 class="h3">History</h3>${versions.length
    ? html`<ol class="history">${versions.map((v) => html`<li data-seq="${v.seq}"><div class="history__line"><strong>${v.reason.replace(/_/g, " ")}</strong><span class="muted" title="${formatTime(v.at)}">${ago(v.at, now)}</span></div><p class="history__sum">${v.summary || "No visible change"}</p><button type="button" class="btn btn--quiet" data-action="compare" data-seq="${v.seq}">See the change</button><div class="history__diff" data-diff aria-live="polite"></div></li>`)}</ol>`
    : html`<p class="muted">No changes yet.</p>`}`;

export const editForm = (e) => html`<form class="stack" data-form="edit" aria-label="Edit the memory"><label class="field">Text<textarea name="content" rows="14" required class="mono">${e.content}</textarea></label>
  <label class="field">Tags, separated by spaces or commas<input name="tags" value="${e.tags.join(" ")}" autocomplete="off"></label>
  <p class="muted small">The save is refused if anyone changed this memory after you opened it.</p>
  <p class="actions"><button type="submit" class="btn btn--primary">Save changes</button><button type="button" class="btn" data-action="cancel">Cancel</button></p></form>`;
export const appendForm = () => html`<form class="stack" data-form="append" aria-label="Append to the memory"><label class="field">Text to add after a blank line<textarea name="addition" rows="4" required></textarea></label><p class="actions"><button type="submit" class="btn btn--primary">Append</button><button type="button" class="btn" data-action="cancel">Cancel</button></p></form>`;
export const linkForm = () => html`<form class="stack row-form" data-form="link" aria-label="Link to another memory"><label class="field">Other memory id<input name="target" required maxlength="64" autocomplete="off"></label><label class="field">Link type<input name="type" value="related" required maxlength="64" pattern="[a-z0-9][a-z0-9_\\-]*"></label><p class="actions"><button type="submit" class="btn btn--primary">Add link</button><button type="button" class="btn" data-action="cancel">Cancel</button></p></form>`;

/** The whole panel for one memory. */
export function detailView(e, { versions, extras, links, back = hashFor("memories") }, now) {
  const trashed = e.deleted_at !== null;
  const closed = e.valid_until !== null;
  const purgeAt = extras?.purge_at ?? null; // the Worker's purge time, the same one the Trash list shows
  const left = trashed && purgeAt !== null ? Math.max(0, Math.ceil((purgeAt - now) / DAY_MS)) : null;
  return html`<article class="detail" aria-labelledby="detail-h">
    <header class="detail__head"><h2 id="detail-h" class="detail__title" tabindex="-1">${titleOf(e)}</h2><a class="btn btn--icon" href="${back}" aria-label="Close this memory" data-close>${icon("close")}</a></header>
    <p class="detail__chips">${provenance(e)}${trashed ? badge("in the trash", "warn") : ""}${closed ? badge("closed", "muted") : ""}</p>
    ${e.description ? html`<p class="detail__desc">${e.description}</p>` : ""}
    ${trashed ? html`<p class="notice" role="status">${icon("trash")}<span>${left === null ? "This memory is in the trash." : `This memory is in the trash and goes for good in ${count(left, "day")}.`}</span><button type="button" class="btn" data-action="restore">Restore</button></p>` : ""}
    ${closed && !trashed ? html`<p class="notice" role="status">${icon("info")}<span>This memory is closed history${e.superseded_by ? html`, replaced by <a href="${memoryLink(e.superseded_by)}">${e.superseded_by.slice(0, 8)}</a>` : ""}. Undo reopens it.</span><button type="button" class="btn" data-action="undo">Undo</button></p>` : ""}
    ${trashed ? "" : html`<div class="toolbar" role="group" aria-label="Actions"><button type="button" class="btn" data-action="open" data-form-name="edit">Edit</button><button type="button" class="btn" data-action="open" data-form-name="append">Append</button><button type="button" class="btn" data-action="open" data-form-name="link">Link</button><button type="button" class="btn" data-action="undo">${icon("undo")}Undo last change</button><button type="button" class="btn btn--danger" data-action="forget">${icon("trash")}Move to trash</button></div>
      <div data-editor aria-live="polite"></div>`}
    <pre class="text" role="region" aria-label="Memory text" tabindex="0">${e.content}</pre>
    ${tagList(e.tags)}
    ${trashed ? "" : html`<form class="inline-form" data-form="status"><label class="field">Status<select name="status">${STATUSES.map((s) => html`<option value="${s}" ${s === e.status ? "selected" : ""}>${s}</option>`)}</select></label><button type="submit" class="btn">Change status</button></form>`}
    ${factsView(e, extras, now)}
    ${linksView(links)}
    ${historyView(versions, now)}
  </article>`;
}


/**
 * The "Undo the undo" of the undo toast, for the memory the undo was made on. The toast keeps that id, so a memory opened since
 * is never sent it. The memory is reloaded only when it is still open, and a failure goes to the toast, because the panel may be hidden.
 * @returns {Promise<boolean>} true when the undo went through
 */
export function redoUndo(request, id, { isOpen, reload, changed, announce = () => {}, fail }) {
  return request("/undo", { method: "POST", body: { id } }).then(
    () => {
      announce();
      if (isOpen(id)) reload();
      changed();
      return true;
    },
    (err) => {
      fail(err.message);
      return false;
    },
  );
}

/**
 * Adds the drawer to a screen. open(id) shows a memory, open("") closes it.
 * @param {{back: () => string, changed: () => void, title: string, closed?: (id: string) => void}} o back is the address that closes it, changed runs after any write so the screen can refresh its list, closed runs after it closes.
 */
export function mountDrawer(root, ctx, { back, changed, title, closed = () => {} }) {
  const scrim = document.createElement("div");
  scrim.className = "mem__scrim";
  scrim.dataset.action = "close";
  scrim.hidden = true;
  const panel = document.createElement("aside");
  panel.className = "mem__panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Memory");
  panel.hidden = true;
  panel.innerHTML = String(html`<div data-msg></div><div data-body></div>`);
  root.append(scrim, panel);
  const msg = panel.querySelector("[data-msg]");
  const body = panel.querySelector("[data-body]");
  const state = { id: "", entry: null, version: 0 };

  // While the drawer is open the page behind it is inert, so reading and focus stay in the memory. The toasts stay live, so Undo still works.
  const shielded = new Set();
  // The dialogs (the palette, Remember) stay live, because they open on top of the drawer and an inert dialog cannot take focus.
  const behind = () => [...document.body.children].filter((el) => el.id !== "toasts" && el.localName !== "dialog" && !el.contains(panel)).concat([...root.children].filter((el) => el !== scrim && el !== panel));
  // A route change replaces the whole screen without telling the drawer, so the shield lets go when the drawer's screen is gone.
  const screenGone = () => {
    if (!root.isConnected) shield(false);
  };
  function shield(on) {
    if (on) {
      for (const el of behind()) if (!el.inert) ((el.inert = true), shielded.add(el));
      addEventListener("hashchange", screenGone);
    } else {
      for (const el of shielded) el.inert = false;
      shielded.clear();
      removeEventListener("hashchange", screenGone);
    }
  }
  // Tab stays inside the panel: from its last control it goes to the first, and back the other way.
  panel.addEventListener("keydown", (e) => {
    const items = [...panel.querySelectorAll("a[href], button, input, select, textarea")].filter((el) => !el.disabled);
    if (e.key !== "Tab" || !items.length) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === items[0] || !panel.contains(active))) (e.preventDefault(), items.at(-1).focus());
    else if (!e.shiftKey && (active === items.at(-1) || !panel.contains(active))) (e.preventDefault(), items[0].focus());
  });

  async function loadEntry(message) {
    const q = encodeURIComponent(state.id);
    const stillOpen = () => q === encodeURIComponent(state.id); // the person may have moved on while this loaded
    let entry;
    try {
      entry = (await ctx.request(`/entry?id=${q}`)).entry;
    } catch (err) {
      if (!stillOpen()) return;
      if (!(err instanceof ApiError) || err.status !== 404) return say(msg, err.message, true);
      entry = (await attempt(msg, () => ctx.request(`/entry?id=${q}&deleted=1`), undefined, stillOpen))?.entry; // it may be in the trash
      if (!entry) return;
    }
    const [versions, extras] = await Promise.all([ctx.request(`/history?id=${q}`).then((r) => r.versions).catch(() => []), ctx.request(`/ui/api/memory-extras?id=${q}`).catch(() => null)]);
    if (q !== encodeURIComponent(state.id)) return; // the person moved on while this loaded
    state.entry = entry;
    state.version = versions[0]?.seq ?? 0;
    msg.replaceChildren();
    body.innerHTML = String(detailView(entry, { versions, extras, links: extras ? extras.links : null, back: back() }, ctx.now()));
    document.title = `${titleOf(entry)}, anymem`;
    if (message) notice(message);
  }
  const notice = (message) => {
    const slot = panel.querySelector("[data-editor]") ?? panel.querySelector(".detail__chips");
    const p = document.createElement("p");
    p.className = "notice";
    p.setAttribute("role", "status");
    p.textContent = message;
    slot?.after(p);
  };

  function open(next) {
    const was = state.id;
    state.id = next;
    panel.hidden = scrim.hidden = !next;
    msg.replaceChildren();
    if (!next) {
      shield(false);
      body.replaceChildren();
      document.title = `${title}, anymem`;
      // the screen redraws in this same turn, so focus goes back to the row it came from on the next turn, after the redraw
      if (was) (closed(was), setTimeout(() => root.querySelector(`tr[data-id="${CSS.escape(was)}"] a`)?.focus({ preventScroll: true })));
      return;
    }
    shield(true);
    body.innerHTML = String(html`<p class="muted loading" role="status">Loading</p>`);
    loadEntry().then(() => panel.querySelector("#detail-h")?.focus({ preventScroll: true }));
  }

  const act = async (path, payload) => {
    const done = await attempt(panel.querySelector("[data-editor]") ?? msg, () => ctx.request(path, { method: "POST", body: { id: state.id, ...payload } }), (err, area) => {
      if (err.code !== "stale_update" && err.code !== "lost_race") return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.dataset.action = "reload";
      button.textContent = "Reload this memory";
      area.append(" ", button);
    });
    if (done) dispatchEvent(new Event("anymem:changed"));
    return done;
  };

  onSubmit(root, {
    async edit(form) {
      const v = formValues(form);
      if (await act("/update", { content: v.content, tags: splitTags(v.tags), if_updated_at: state.entry.updated_at })) (await loadEntry(), changed());
    },
    async append(form) {
      if (await act("/append", { addition: formValues(form).addition })) (await loadEntry(), changed());
    },
    async status(form) {
      if (await act("/status", { status: formValues(form).status })) (await loadEntry(), changed());
    },
    async link(form) {
      const v = formValues(form);
      const reply = await attempt(panel.querySelector("[data-editor]") ?? msg, () => ctx.request("/link", { method: "POST", body: { source_id: state.id, target_id: v.target.trim(), type: v.type.trim() } }));
      if (reply) (await loadEntry(reply.created ? "Link added." : "That link already existed."));
    },
  });
  // ponytail: this listener outlives the screen and stays quiet through the isConnected check, a few bytes per visit
  addEventListener("keydown", (e) => e.key === "Escape" && state.id && root.isConnected && !document.querySelector("dialog[open], :popover-open") && (location.hash = back()));
  onAction(root, {
    close: () => (location.hash = back()),
    reload: () => loadEntry(),
    open(el) {
      const slot = panel.querySelector("[data-editor]");
      const make = { edit: () => editForm(state.entry), append: appendForm, link: linkForm }[el.dataset.formName];
      slot.innerHTML = String(make());
      slot.querySelector("textarea, input")?.focus();
    },
    cancel: () => (panel.querySelector("[data-editor]").replaceChildren()),
    async undo() {
      const id = state.id;
      if (await act("/undo", {})) {
        await loadEntry();
        changed();
        notify("Undone.", { action: { label: "Undo the undo", run: () => redoUndo(ctx.request, id, { isOpen: (x) => state.id === x, reload: loadEntry, changed, announce: () => dispatchEvent(new Event("anymem:changed")), fail: (m) => notify(m, { tone: "error" }) }) } });
      }
    },
    async restore() {
      if (await act("/restore", {})) (await loadEntry(), changed());
    },
    async forget() {
      const gone = state.id;
      if (await act("/forget", {})) {
        await loadEntry();
        changed();
        notify("Moved to the trash. You can restore it until it goes for good.", { action: { label: "Undo", run: () => ctx.request("/restore", { method: "POST", body: { id: gone } }).then(() => (dispatchEvent(new Event("anymem:changed")), state.id === gone && loadEntry(), changed())).catch((err) => notify(err.message, { tone: "error" })) } });
      }
    },
    async compare(el) {
      const seq = Number(el.dataset.seq);
      const slot = el.closest("li").querySelector("[data-diff]");
      if (slot.childElementCount) return void slot.replaceChildren(); // a second click closes it
      const q = encodeURIComponent(state.id);
      const trash = state.entry.deleted_at ? "&deleted=1" : "";
      slot.innerHTML = String(html`<p class="muted loading" role="status">Loading</p>`);
      const pair = await attempt(slot, async () => {
        const before = (await ctx.request(`/entry?id=${q}&version=${seq}${trash}`)).entry.content;
        const after = seq === state.version ? state.entry.content : (await ctx.request(`/entry?id=${q}&version=${seq + 1}${trash}`)).entry.content;
        return { before, after };
      });
      if (pair) slot.innerHTML = String(html`${diffView(pair.before, pair.after, "This change")}<details class="fold"><summary>Show the text before this change</summary><pre class="text">${pair.before}</pre></details>`);
    },
  });
  return { open, get id() { return state.id; } };
}
