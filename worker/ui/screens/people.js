// Profile. What waits for a decision comes first, then the profile. People are subjects of kind person and live on the Subjects tab.
// Accept saves the value into the profile memory and moves the pending item to the trash, like the skill's `profile.py accept`.
import { emptyState, icon } from "../lib/components.js";
import { mountDrawer } from "../lib/drawer.js";
import { attempt, notify, onAction, say, show } from "../lib/dom.js";
import { ago, count, formatNumber, titleOf } from "../lib/format.js";
import { html } from "../lib/html.js";
import { hashFor } from "../lib/route.js";
import { FIELDS, findProfile, parseFacts, pendingCurrent, pendingField, pendingValue, renderFacts, setFact, tagsFor } from "../lib/profile.js";

export const title = "Profile";

/** Changes that wait for the owner, one line each, with the value now, the value proposed, and the three things you can do. */
export const pendingView = (pending, facts, now, total = pending.length) =>
  html`<section class="decide" aria-labelledby="pending-h"><h2 class="h2" id="pending-h">${total ? `${count(total, "change")} waiting for you` : "Waiting for you"}</h2>${pending.length
    ? html`<div class="scroll" tabindex="0" role="region" aria-label="Changes waiting for you"><table class="data data--grid data--decide"><caption class="sr">Changes waiting for you, with the value now and the value proposed</caption>
      <thead><tr><th scope="col" class="th">Field</th><th scope="col" class="th">Now</th><th scope="col" class="th">Proposed</th><th scope="col" class="th">When</th><th scope="col" class="th"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${pending.map((p) => {
        const key = pendingField(p);
        const known = Boolean(FIELDS[key]) && Boolean(pendingValue(p));
        return html`<tr><th scope="row">${known ? FIELDS[key][0] : titleOf(p)}</th>${known
          ? html`<td class="decision__was">${facts[key]?.value || pendingCurrent(p) || "not set"}</td><td><strong class="decision__is">${pendingValue(p)}</strong></td>`
          : html`<td colspan="2" class="muted">Not a profile field change, open it to decide.</td>`}<td class="nowrap">${ago(p.created_at, now)}</td>
          <td class="cell__act">${known ? html`<button type="button" class="btn btn--primary" data-action="accept" data-id="${p.id}">Accept</button> ` : ""}<button type="button" class="btn" data-action="dismiss" data-id="${p.id}">Dismiss</button> <a class="btn btn--quiet" href="${hashFor("people", { arg: p.id })}">Open</a></td></tr>`;
      })}</tbody></table></div>${total > pending.length ? html`<p class="muted small">Showing the first ${formatNumber(pending.length)} of ${formatNumber(total)}. Accept or dismiss these to see the rest.</p>` : ""}` : html`<p class="muted">${icon("ok")} Nothing is waiting for a decision.</p>`}</section>`;

/** The profile as a table, a row to a field. A row opens the profile memory in a drawer, where it can be edited. */
export const profileView = (profile) => {
  const facts = profile ? parseFacts(profile.content) : {};
  const keys = Object.keys(FIELDS).filter((k) => facts[k]);
  const unset = Object.keys(FIELDS).filter((k) => !facts[k] && k !== "last-name").map((k) => FIELDS[k][0]);
  return html`<section class="panel" aria-labelledby="profile-h"><h2 class="h2" id="profile-h">Profile</h2>${keys.length
    ? html`<div class="scroll" tabindex="0" role="region" aria-label="Profile"><table class="data data--grid is-clickable data--profile"><caption class="sr">Your profile. A row opens the profile memory.</caption>
      <thead><tr><th scope="col" class="th">Field</th><th scope="col" class="th">Value</th><th scope="col" class="th">Confirmed</th></tr></thead>
      <tbody>${keys.map((k) => html`<tr data-id="${profile.id}"><th scope="row"><a class="mem__title" href="${hashFor("people", { arg: profile.id })}">${FIELDS[k][0]}</a></th><td class="mem__cell">${facts[k].value}</td><td class="muted">${facts[k].note.replace(/^confirmed\s*/, "")}</td></tr>`)}</tbody></table></div>
      ${unset.length ? html`<p class="muted small">No value yet for ${unset.join(", ")}.</p>` : ""}`
    : emptyState("No profile yet", "Accepting a pending change creates it.")}</section>`;
};

export function mount(root, ctx, arg) {
  let data = null;
  show(root, html`<header class="head"><div><h1 tabindex="-1">Profile</h1><p class="head__intro">Your own facts, and the changes waiting for you. The people you talk about are on <a class="link" href="${hashFor("subjects", { params: { kind: "person" } })}">Subjects</a>.</p></div></header><div data-status></div><div data-out><p class="muted loading" role="status">Loading</p></div>`);
  const status = root.querySelector("[data-status]");
  const out = root.querySelector("[data-out]");
  const drawer = mountDrawer(root, ctx, { back: () => hashFor("people"), changed: () => load(), title });
  async function load() {
    data = await attempt(status, () => ctx.request("/ui/api/people"));
    if (!data) return;
    const profile = findProfile(data.profile);
    show(out, html`${pendingView(data.pending, profile ? parseFacts(profile.content) : {}, ctx.now(), data.pending_total ?? data.pending.length)}${profileView(profile)}`);
  }
  async function saveField(key, value) {
    const profile = findProfile(data.profile);
    const facts = setFact(profile ? parseFacts(profile.content) : {}, key, value);
    const content = renderFacts(facts);
    const tags = [...tagsFor(facts), "status:canonical"];
    if (profile) await ctx.request("/update", { method: "POST", body: { id: profile.id, content, tags, if_updated_at: profile.updated_at } });
    else await ctx.request("/capture", { method: "POST", body: { content, tags, source: "profile" } });
  }
  onAction(root, {
    async accept(el) {
      const item = data.pending.find((p) => p.id === el.dataset.id);
      el.disabled = true;
      const done = await attempt(status, async () => {
        await saveField(pendingField(item), pendingValue(item));
        await ctx.request("/forget", { method: "POST", body: { id: item.id } });
        return true;
      });
      if (done) (dispatchEvent(new Event("anymem:changed")), await load());
      else el.disabled = false;
    },
    async dismiss(el) {
      const id = el.dataset.id;
      el.disabled = true;
      if (await attempt(status, () => ctx.request("/forget", { method: "POST", body: { id } }))) {
        dispatchEvent(new Event("anymem:changed"));
        notify("Dismissed.", { action: { label: "Undo", run: () => ctx.request("/restore", { method: "POST", body: { id } }).then(() => (dispatchEvent(new Event("anymem:changed")), load())).catch((err) => say(status, err.message, true)) } });
        await load();
      } else el.disabled = false;
    },
  });
  root.addEventListener("click", (e) => {
    const tr = e.target.closest(".data--profile tr[data-id]");
    if (tr && !e.target.closest("a, button")) location.hash = hashFor("people", { arg: tr.dataset.id }); // a row opens its memory in a drawer, here on People
  });
  load();
  if (arg) drawer.open(arg);
  return { update: (next) => (next !== drawer.id ? drawer.open(next) : undefined) };
}
