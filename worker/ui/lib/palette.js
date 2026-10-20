// What the command palette offers for what was typed. Pure. The shell draws it and runs the chosen item.
import { hashFor, NAV } from "./route.js";

const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * @param {string} text what was typed
 * @returns {{id: string, label: string, hint: string, href?: string, action?: string}[]}
 */
export function paletteItems(text) {
  const q = String(text ?? "").trim();
  const lower = q.toLowerCase();
  const items = [];
  if (ID.test(q)) items.push({ id: "memory", label: `Open memory ${q.slice(0, 8)}`, hint: "Memory", href: hashFor("memories", { arg: q }) });
  if (q.length >= 3) {
    items.push({ id: "search", label: `Search for \u201c${q.length > 40 ? `${q.slice(0, 39)}…` : q}\u201d`, hint: "See what a prompt would inject", href: hashFor("search", { params: { q } }) });
    items.push({ id: "remember", label: "Remember this", hint: "Build the command to save it", action: "remember" });
  }
  for (const n of NAV) if (!lower || n.label.toLowerCase().includes(lower) || n.name.includes(lower)) items.push({ id: n.name, label: n.label, hint: "Go to", href: hashFor(n.name) });
  if (!q) items.push({ id: "remember", label: "Remember something", hint: "Build the command to save it", action: "remember" });
  return items;
}
