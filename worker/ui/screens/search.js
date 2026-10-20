// Search. Type a prompt and see what the recall hook would do with it. The Worker runs the same search with count=0, so
// nothing here changes a recall count. The page shows the text the hook would add, then every hit with its scores and the rules.
import { isMissingRoute } from "../lib/api.js";
import { badge, emptyState, harnessChip, icon, missingRoute, originChip } from "../lib/components.js";
import { attempt, formValues, onAction, onSubmit, say, show } from "../lib/dom.js";
import { mountDrawer } from "../lib/drawer.js";
import { appliedChips } from "../lib/grid.js";
import { recallQuery } from "../lib/filters.js";
import { count, formatNumber, titleOf, truncate } from "../lib/format.js";
import { html } from "../lib/html.js";
import { arms, closeness, hookQuery, heldBack, injectedHits, injectedText, rareWords, RULE_NAMES, ruleSplit } from "../lib/relevance.js";
import { hashFor } from "../lib/route.js";

export const title = "Search";

export const searchForm = (q = "", project = "") => html`<form class="searchbox" data-form="search"><input type="hidden" name="project" value="${project}"><div class="searchbox__row"><label class="field searchbox__prompt">Prompt<textarea name="q" rows="2" maxlength="2000" required placeholder="What did we decide about the restore window for the trash?">${q}</textarea></label><button type="submit" class="btn btn--primary">${icon("search")}Search</button></div>
  <p class="muted small">Enter searches, Shift and Enter adds a line. Nothing here counts as a recall. The same search the hook runs, asked with count off.</p></form>`;

/** The state of a hit in one word, and the reason in a sentence. */
export function verdict(hit, injected, project = "") {
  if (injected.includes(hit)) return { word: "Injected", note: "It is one of the first three relevant hits, so the hook adds it to the prompt.", kind: "good" };
  if (hit.relevant) return { word: "Held back", note: heldBack(hit, project) || "It is relevant, but three relevant hits are already in the prompt.", kind: "warn" };
  return { word: "Not relevant", note: "No relevance rule held for it, so the hook leaves it out.", kind: "" };
}

/** Every rule of the relevance test, those that held first. */
export function rulesView(hit) {
  const { held, missed } = ruleSplit(hit);
  if (!held.length && !missed.length) return "";
  const li = (c) => html`<li class="${c.met ? "is-met" : ""}"><span class="rule__mark">${icon(c.met ? "ok" : "off")}<span class="sr">${c.met ? "Held" : "Did not hold"}</span></span><span><strong>${RULE_NAMES[c.rule] ?? c.rule}</strong> ${c.detail}</span></li>`;
  return html`<p class="why__h">${hit.relevant ? `Why it is relevant, ${count(held.length, "rule")} held` : "Why it is not relevant, no rule held"}</p><ul class="rules">${[...held, ...missed].map(li)}</ul>`;
}

/** Which of the two searches found a hit, in a few words. */
const foundBy = (hit) => arms(hit).map((a) => `${a.arm === "meaning" ? "meaning" : "keyword"} place ${a.rank}`).join(" and ") || "neither";

/** One hit as a table row one line high, and under it a row with the reasons that opens with Why. The row opens the memory in a drawer here. */
export function hitView(hit, place, injected, params = {}) {
  const v = verdict(hit, injected, params.project);
  const rare = rareWords(hit);
  return html`<tr class="hit hit--${v.kind || "none"}" data-id="${hit.id}"><td class="num">${place}</td>
    <th scope="row" class="mem__cell"><a class="mem__title" href="${hashFor("search", { arg: hit.id, params })}">${titleOf(hit)}</a>${hit.description ? html`<span class="mem__desc">${truncate(hit.description, 160)}</span>` : ""}</th>
    <td>${badge(v.word, v.kind)}</td><td>${originChip(hit.origin)}</td><td class="nowrap">${harnessChip(hit)}</td>
    <td class="num fig">${closeness(hit)}</td><td class="num fig">${hit.rerank ?? "none"}</td><td class="num fig">${hit.score ?? "none"}</td><td class="nowrap">${foundBy(hit)}</td>
    <td><button type="button" class="btn btn--quiet" data-action="why" aria-expanded="false">Why</button></td></tr>
    <tr class="why-row" hidden><td></td><td colspan="9"><p class="muted">${v.note}</p><p class="muted">Rare words matched ${rare.length ? rare.join(", ") : "none"}.${hit.project ? ` Project ${hit.project}.` : ""}</p>${rulesView(hit)}</td></tr>`;
}

/** The text the hook would add, in one block. */
export function injectedView(text, hits) {
  if (!hits.length) return html`<section class="inject" aria-labelledby="inject-h"><h2 class="h2" id="inject-h">What the hook would add</h2><p class="inject__none">${icon("off")}<span><strong>Nothing.</strong> No hit is relevant and in scope, so a prompt like this goes through with no memories added.</span></p></section>`;
  return html`<section class="inject" aria-labelledby="inject-h"><h2 class="h2" id="inject-h">What the hook would add</h2>
    <p class="muted">${count(hits.length, "memory", "memories")} added, ${formatNumber(text.length)} of 1,800 characters. This is the exact text, shown as plain text.</p>
    <pre class="code code--block" tabindex="0">${text}</pre></section>`;
}

export function resultsView(reply, query, params = {}) {
  const results = reply.results ?? [];
  const hits = injectedHits(results, params.project);
  const text = injectedText(hits);
  return html`${reply.degraded ? html`<p class="notice" role="status">${icon("warn")}<span>Part of the search was unavailable (${reply.degraded}). These results use what still worked.</span></p>` : ""}
    <p class="muted small">The hook would search for <q class="query">${query}</q>${reply.took_ms !== undefined ? `. The search took ${formatNumber(reply.took_ms)} ms.` : "."}</p>
    ${injectedView(text, hits)}
    <section class="hits" aria-labelledby="hits-h"><h2 class="h2" id="hits-h">All ${count(results.length, "hit")}, best first</h2>
      ${results.length ? html`<div class="scroll" tabindex="0" role="region" aria-label="Every hit, best first"><table class="data data--grid is-clickable data--hits"><caption class="sr">Every memory the search considered, best first, with its scores. A row opens the memory, and Why shows the rules.</caption>
        <thead><tr><th scope="col" class="th num">Place</th><th scope="col" class="th">Memory</th><th scope="col" class="th">Verdict</th><th scope="col" class="th">Origin</th><th scope="col" class="th">Tool</th><th scope="col" class="th num">Meaning</th><th scope="col" class="th num">Reranker</th><th scope="col" class="th num">Rank score</th><th scope="col" class="th">Found by</th><th scope="col" class="th"><span class="sr">Reasons</span></th></tr></thead>
        <tbody>${results.map((h, i) => hitView(h, i + 1, hits, params))}</tbody></table></div>` : emptyState("No hits", "Neither search found anything close to this text.")}</section>`;
}

export function mount(root, ctx, arg, params) {
  let seq = 0; // the newest search, so a slow older one cannot show its results under a newer prompt
  let now = { q: "", project: "" };
  show(root, html`<header class="head"><div><h1 tabindex="-1">Search</h1><p class="head__intro">See exactly what a prompt would get, and why.</p></div></header><div class="search-grid"><div data-form-host></div><div data-out></div></div>`);
  const host = root.querySelector("[data-form-host]");
  const out = root.querySelector("[data-out]");
  const drawer = mountDrawer(root, ctx, { back: () => hashFor("search", { params: now }), changed: () => run(now.q, now.project), title });

  async function run(q, project) {
    now = { q: q.trim(), project };
    host.innerHTML = String(html`${searchForm(q, project)}${appliedChips(project ? [{ label: "In project", value: project, href: hashFor("search", { params: { q: now.q } }) }] : [])}`);
    if (!q.trim()) return (out.innerHTML = String(emptyState("Type a prompt above", "The page shows the text the hook would add to it, and every memory it considered.")));
    const asked = hookQuery(q);
    say(out, "Searching");
    const mine = ++seq;
    const reply = await attempt(
      out,
      () =>
        ctx.request(`/recall?${recallQuery(asked.query ?? q, { project })}`).catch((err) => {
          if (isMissingRoute(err)) return null;
          throw err;
        }),
      undefined,
      () => mine === seq, // an error from a search that was overtaken is not shown
    );
    if (mine !== seq || reply === undefined) return;
    out.className = "";
    out.removeAttribute("role");
    out.innerHTML = String(reply === null ? missingRoute("Search", "GET /recall") : html`${asked.query === null ? html`<p class="notice" role="status">${icon("info")}<span>${asked.reason} The results below are what the search finds when you ask it anyway.</span></p>` : ""}${resultsView(reply, asked.query ?? q.trim(), now)}`);
  }

  onSubmit(root, {
    search(form) {
      const v = formValues(form);
      const next = hashFor("search", { params: { q: v.q.trim(), project: v.project.trim() } });
      if (location.hash === next) run(v.q, v.project);
      else location.hash = next;
    },
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target.matches?.('textarea[name="q"]')) {
      e.preventDefault();
      e.target.form.requestSubmit(); // Enter searches, Shift and Enter adds a line
    }
  });
  root.addEventListener("click", (e) => {
    const tr = e.target.closest(".data--hits tr[data-id]");
    if (tr && !e.target.closest("a, button")) location.hash = hashFor("search", { arg: tr.dataset.id, params: now });
  });
  onAction(root, {
    why(el) {
      const row = el.closest("tr").nextElementSibling;
      row.hidden = !row.hidden;
      el.setAttribute("aria-expanded", String(!row.hidden));
    },
  });
  run(params.q ?? "", params.project ?? "");
  if (arg) drawer.open(arg);
  return {
    update(nextArg, p) {
      if (nextArg !== drawer.id) drawer.open(nextArg);
      if ((p.q ?? "") !== now.q || (p.project ?? "") !== now.project) run(p.q ?? "", p.project ?? "");
    },
  };
}
