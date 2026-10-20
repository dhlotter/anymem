// The subject drawer. One subject card with its brief, fields, aliases, members and links, and the actions: edit the brief, edit the
// fields, add an alias, change the scope, retire. It is the memory drawer's shell (mountPanel), so it slides in the same way and keeps
// the page behind it inert. Its actions all start with subject so it never answers the memory drawer on the same screen.
import { badge, icon, memoryLink, segmented } from "./components.js";
import { linksView, mountPanel } from "./drawer.js";
import { attempt, formValues, notify, onAction, onChange, onSubmit } from "./dom.js";
import { ago, count, formatTime, titleOf } from "./format.js";
import { html } from "./html.js";
import { FIELD_KEYS, fieldLabel, SCOPES } from "./subjects.js";

const STATUS_NOTE = { proposed: "warn", stale: "warn", retired: "muted" };

/** The status as a word, quiet when it is the usual one. */
export const statusMark = (status) => (status === "active" ? html`<span class="muted">active</span>` : badge(status, STATUS_NOTE[status] ?? ""));

const fieldName = (kind, key) => (FIELD_KEYS[kind]?.includes(key) ? fieldLabel(key) : key);

/** The members as a table, a row to a memory. A row opens the memory in the memory drawer. */
const membersView = (s) => {
  const hidden = s.member_count - s.members.length;
  return html`<h3 class="h3">Members</h3>${s.members.length
    ? html`<div class="scroll" tabindex="0" role="region" aria-label="Members"><table class="data data--grid is-clickable data--members"><caption class="sr">The memories about this subject. A row opens the memory.</caption>
      <thead><tr><th scope="col" class="th">Memory</th><th scope="col" class="th num">Changed</th></tr></thead>
      <tbody>${s.members.map((m) => html`<tr data-id="${m.id}"><th scope="row" class="mem__cell"><a class="mem__title" href="${memoryLink(m.id)}">${titleOf(m)}</a></th><td class="num nowrap" title="${formatTime(m.updated_at)}">${ago(m.updated_at, s.now)}</td></tr>`)}</tbody></table></div>
      ${hidden > 0 ? html`<p class="muted small">Showing the newest ${count(s.members.length, "memory", "memories")} of ${count(s.member_count, "memory", "memories")}.</p>` : ""}`
    : html`<p class="muted">No memory is about this subject yet. Open a memory, choose Link, and link it to this card with the type about.</p>`}`;
};

/** The whole panel for one subject. subject is the GET /subject reply, links the card memory's links or null. */
export function subjectView(subject, links, now, back) {
  const s = { members: [], member_count: subject.members?.length ?? 0, ...subject, now };
  const fields = Object.entries(s.fields ?? {});
  const retired = s.status === "retired";
  return html`<article class="detail" aria-labelledby="subject-h">
    <header class="detail__head"><h2 id="subject-h" class="detail__title" tabindex="-1">${s.name}</h2><a class="btn btn--icon" href="${back}" aria-label="Close this subject" data-close>${icon("close")}</a></header>
    <p class="detail__chips">${badge(s.kind)}${statusMark(s.status)}${badge(s.scope, s.scope === "private" ? "warn" : "muted")}<span class="mono muted">${s.slug}</span></p>
    ${retired ? html`<p class="notice" role="status">${icon("info")}<span>This subject is retired. Recall does not offer a retired subject.</span><button type="button" class="btn" data-action="subject-status" data-status="active">Bring back</button></p>` : ""}
    <div class="toolbar" role="group" aria-label="Actions"><button type="button" class="btn" data-action="subject-form" data-form-name="brief">Edit brief</button><button type="button" class="btn" data-action="subject-form" data-form-name="fields">Edit fields</button><button type="button" class="btn" data-action="subject-form" data-form-name="alias">Add alias</button>${retired ? "" : html`<button type="button" class="btn btn--danger" data-action="subject-status" data-status="retired">Retire</button>`}</div>
    <div data-editor aria-live="polite"></div>
    <h3 class="h3">Brief</h3>${s.brief ? html`<pre class="text" role="region" aria-label="Brief" tabindex="0">${s.brief}</pre>` : html`<p class="muted">No brief yet.</p>`}
    <h3 class="h3">Scope</h3>${segmented("subject-scope", "Scope", SCOPES.map((v) => [v, `${v[0].toUpperCase()}${v.slice(1)}`]), s.scope, "subject-scope")}
    <p class="muted small">${s.scope === "private" ? "A device that may not see private subjects never sees this subject, its card, or a memory that is only about private subjects." : "Every device can see this subject."}</p>
    <h3 class="h3">Fields</h3>${fields.length
      ? html`<dl class="facts">${fields.map(([k, f]) => html`<div><dt>${fieldName(s.kind, k)}</dt><dd>${f?.value}<span class="cell__sub" title="${formatTime(f?.confirmed_at)}">confirmed ${ago(f?.confirmed_at, now)}</span></dd></div>`)}</dl>`
      : html`<p class="muted">No fields yet.</p>`}
    <h3 class="h3">Aliases</h3>${s.aliases?.length
      ? html`<ul class="tags" aria-label="Aliases">${s.aliases.map((a) => html`<li>${a} <button type="button" class="btn btn--quiet" data-action="subject-unalias" data-alias="${a}">Remove<span class="sr"> alias ${a}</span></button></li>`)}</ul>`
      : html`<p class="muted">No aliases yet. Recall can find the subject by a name you add here.</p>`}
    ${membersView(s)}
    ${linksView(links, false)}
    <dl class="facts"><div><dt>Created</dt><dd>${formatTime(s.created_at)} (${ago(s.created_at, now)})</dd></div><div><dt>Changed</dt><dd>${formatTime(s.updated_at)} (${ago(s.updated_at, now)})</dd></div><div><dt>Card memory</dt><dd><a class="mono" href="${memoryLink(s.id)}">${s.id}</a></dd></div></dl>
  </article>`;
}

export const briefForm = (s) => html`<form class="stack" data-form="subject-brief" aria-label="Edit the brief"><label class="field">Brief<textarea name="brief" rows="10" class="mono">${s.brief}</textarea></label>
  <p class="actions"><button type="submit" class="btn btn--primary">Save brief</button><button type="button" class="btn" data-action="subject-cancel">Cancel</button></p></form>`;

export const fieldsForm = (s) => html`<form class="stack" data-form="subject-fields" aria-label="Edit the fields">${(FIELD_KEYS[s.kind] ?? []).map((k) => html`<label class="field">${fieldLabel(k)}<input name="${k}" value="${s.fields?.[k]?.value ?? ""}" maxlength="200" autocomplete="off"></label>`)}
  <p class="muted small">Leave a field empty to remove it. A value is up to 200 characters.</p>
  <p class="actions"><button type="submit" class="btn btn--primary">Save fields</button><button type="button" class="btn" data-action="subject-cancel">Cancel</button></p></form>`;

export const aliasForm = () => html`<form class="stack row-form" data-form="subject-alias" aria-label="Add an alias"><label class="field">Alias<input name="alias" required maxlength="80" autocomplete="off"></label>
  <p class="actions"><button type="submit" class="btn btn--primary">Add alias</button><button type="button" class="btn" data-action="subject-cancel">Cancel</button></p></form>`;

/**
 * Adds the subject drawer to a screen. open(slug) shows a subject, open("") closes it.
 * @param {{back: () => string, changed: () => void, title: string, above: () => boolean, member: (id: string) => void, closed?: (slug: string) => void}} o
 * back is the address that closes it, changed runs after any write so the screen can refresh its list, above says whether another drawer is open on top (Escape then belongs to that one), member opens a memory.
 */
export function mountSubjectDrawer(root, ctx, { back, changed, title, above, member, closed = () => {} }) {
  const { scrim, panel, msg, body, shield } = mountPanel(root, "Subject", "subject-close");
  const state = { slug: "", subject: null };
  const editor = () => panel.querySelector("[data-editor]") ?? msg;
  const clearMsg = () => (msg.replaceChildren(), (msg.className = ""), msg.removeAttribute("role")); // an old failure leaves no empty red box behind

  async function load(message) {
    const slug = state.slug;
    const stillOpen = () => state.slug === slug; // the person may have moved on while this loaded
    const got = await attempt(msg, () => ctx.request(`/subject?slug=${encodeURIComponent(slug)}`), undefined, stillOpen);
    if (!stillOpen()) return;
    if (!got) return void body.replaceChildren();
    const links = await ctx.request(`/links?id=${encodeURIComponent(got.subject.id)}`).then((r) => r.links).catch(() => null);
    if (!stillOpen()) return;
    state.subject = got.subject;
    clearMsg();
    body.innerHTML = String(subjectView(got.subject, links, ctx.now(), back()));
    document.title = `${got.subject.name}, anymem`;
    if (message) {
      const p = document.createElement("p");
      p.className = "notice";
      p.setAttribute("role", "status");
      p.textContent = message;
      panel.querySelector("[data-editor]")?.after(p);
    }
  }

  function open(next) {
    const was = state.slug;
    state.slug = next;
    panel.hidden = scrim.hidden = !next;
    clearMsg();
    if (!next) {
      shield(false);
      body.replaceChildren();
      document.title = `${title}, anymem`;
      if (was) (closed(was), setTimeout(() => root.querySelector(`tr[data-slug="${CSS.escape(was)}"] a`)?.focus({ preventScroll: true })));
      return;
    }
    shield(true);
    body.innerHTML = String(html`<p class="muted loading" role="status">Loading</p>`);
    load().then(() => panel.querySelector("#subject-h")?.focus({ preventScroll: true }));
  }

  /** POST /subject/update for the open subject. A failure shows in the editor slot, and the drawer reloads after a success. */
  async function update(payload, message) {
    const done = await attempt(editor(), () => ctx.request("/subject/update", { method: "POST", body: { id: state.subject.id, ...payload } }));
    if (!done) return false;
    dispatchEvent(new Event("anymem:changed"));
    changed();
    await load(message);
    return true;
  }

  onSubmit(root, {
    "subject-brief": (form) => update({ brief: formValues(form).brief }),
    "subject-fields": (form) => {
      const v = formValues(form);
      const changes = {};
      for (const k of FIELD_KEYS[state.subject.kind] ?? []) {
        const now = (v[k] ?? "").trim();
        if (now !== (state.subject.fields?.[k]?.value ?? "")) changes[k] = now || null; // an empty box removes the field
      }
      return Object.keys(changes).length ? update({ fields: changes }) : panel.querySelector("[data-editor]").replaceChildren();
    },
    "subject-alias": (form) => {
      const alias = formValues(form).alias.trim().toLowerCase();
      const have = state.subject.aliases ?? [];
      return alias && !have.includes(alias) ? update({ aliases: [...have, alias] }) : panel.querySelector("[data-editor]").replaceChildren();
    },
  });
  onChange(root, {
    async "subject-scope"(el) {
      if (await update({ scope: el.value })) return;
      for (const r of panel.querySelectorAll('input[name="subject-scope"]')) r.checked = r.value === state.subject.scope; // a refused change puts the toggle back
    },
  });
  // ponytail: this listener outlives the screen and stays quiet through the isConnected check, a few bytes per visit
  addEventListener("keydown", (e) => e.key === "Escape" && state.slug && root.isConnected && !above() && !document.querySelector("dialog[open], :popover-open") && (location.hash = back()));
  panel.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a")) member(tr.dataset.id); // the title link keeps its own click, so a new tab still works
  });
  onAction(root, {
    "subject-close": () => (location.hash = back()),
    "subject-form"(el) {
      const make = { brief: () => briefForm(state.subject), fields: () => fieldsForm(state.subject), alias: aliasForm }[el.dataset.formName];
      const slot = panel.querySelector("[data-editor]");
      slot.innerHTML = String(make());
      slot.querySelector("textarea, input")?.focus();
    },
    "subject-cancel": () => panel.querySelector("[data-editor]").replaceChildren(),
    "subject-unalias": (el) => update({ aliases: state.subject.aliases.filter((a) => a !== el.dataset.alias) }),
    async "subject-status"(el) {
      const id = state.subject.id;
      const to = el.dataset.status;
      if (!(await update({ status: to }))) return;
      if (to === "retired") notify("Subject retired.", { action: { label: "Undo", run: () => ctx.request("/subject/update", { method: "POST", body: { id, status: "active" } }).then(() => (dispatchEvent(new Event("anymem:changed")), changed(), state.subject?.id === id && load())).catch((err) => notify(err.message, { tone: "error" })) } });
    },
  });
  return { open, get slug() { return state.slug; } };
}
