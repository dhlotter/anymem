// The subject hint: the extractor says "this memory introduces Pip, a pet". A hint is data, never an instruction. It is checked here, in one
// place, for the extractor, for POST /capture and for the proposal, so all three agree on what a usable hint is.
import { echoesInjected, findSecret, readsAsInstruction } from "../write/screen.js";
import { KINDS } from "./store.js";

export const HINT_NAME_MIN = 2;
export const HINT_NAME_MAX = 60;
/** Only these origins may carry a hint. A person, profile or system write is never a source of a new subject. */
export const HINT_ORIGINS = ["capture", "explicit"];

// Words that name nothing. A subject called "the team" or "work" would collect every memory that mentions them.
export const GENERIC_NAMES = new Set(
  ("the a an it its this that these those user users thing things stuff project projects work home team teams me my myself mine i you your we us our they them he she him her " +
    "someone something anyone everyone everything people person company office house car dog cat pet app apps code repo task tasks issue bug topic area none null undefined unknown " +
    "other general misc note notes memory memories assistant today tomorrow yesterday client customer server file files system data example test").split(" "),
);

const hasControl = (s) => /\p{Cc}/u.test(s);
const words = (name) => name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** True for a name made only of generic words, or only of digits. */
export function isGeneric(name) {
  const w = words(name);
  return !w.length || w.every((x) => GENERIC_NAMES.has(x) || /^\d+$/.test(x));
}

/**
 * The hint in its clean form, or null. A name is 2 to 60 characters without control characters or angle brackets, a kind is one of the
 * subject kinds, and neither a secret nor an instruction nor a copy of our own injected blocks.
 * @returns {{name: string, kind: string} | null}
 */
export function cleanHint(hint) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  const name = typeof hint.name === "string" ? hint.name.split(/\s+/).filter(Boolean).join(" ") : "";
  if (name.length < HINT_NAME_MIN || name.length > HINT_NAME_MAX || hasControl(hint.name) || /[<>]/.test(name)) return null;
  if (!KINDS.includes(hint.kind)) return null;
  if (isGeneric(name) || findSecret(name) || readsAsInstruction(name) || echoesInjected(name)) return null;
  return { name, kind: hint.kind };
}

/** True when the name stands in the text as a whole word or phrase, any case. Pip is in "Pip's bowl" and not in "Pipeline". */
export function mentions(text, name) {
  const body = name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu").test(text);
}
