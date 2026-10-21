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

/** A name is at most this many words. A sentence is not a name. */
export const HINT_MAX_WORDS = 5;
// A name is letters of any script (with their marks), digits, a plain space, an apostrophe, a period, a hyphen and an ampersand.
// Anything else is out: punctuation that makes a link, an address or a sentence ("eve@x.com", "https://x", "Dana says: ..."), and every
// invisible character (format, line and paragraph separators), which could hide text or flip it. It must start with a letter or a digit.
const PLAIN_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '’.&-]*$/u;
const words = (name) => name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The name as plain text (composed form, single plain spaces, nothing at the ends), or null when it is not plain or has more than
 * HINT_MAX_WORDS words. Only the plain space is folded, so any other kind of white space makes the name not plain.
 * @returns {string | null}
 */
export function plainName(name) {
  if (typeof name !== "string") return null;
  const parts = name.normalize("NFC").split(" ").filter(Boolean);
  const text = parts.join(" ");
  return parts.length <= HINT_MAX_WORDS && PLAIN_NAME.test(text) ? text : null;
}

/** True for a name made only of generic words, or only of digits. */
export function isGeneric(name) {
  const w = words(name);
  return !w.length || w.every((x) => GENERIC_NAMES.has(x) || /^\d+$/.test(x));
}

/**
 * The hint in its clean form, or null. A name is 2 to 60 characters of plain text (see isPlainName), a kind is one of the
 * subject kinds, and neither a secret nor an instruction nor a copy of our own injected blocks.
 * @returns {{name: string, kind: string} | null}
 */
export function cleanHint(hint) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  // Checked on the raw text, before white space is folded, so a line separator or a no break space cannot slip through as a space.
  const name = plainName(hint.name);
  if (!name || name.length < HINT_NAME_MIN || name.length > HINT_NAME_MAX) return null;
  if (!KINDS.includes(hint.kind)) return null;
  if (isGeneric(name) || findSecret(name) || readsAsInstruction(name) || echoesInjected(name)) return null;
  return { name, kind: hint.kind };
}

/** True when the name stands in the text as a whole word or phrase, any case. Pip is in "Pip's bowl" and not in "Pipeline". */
export function mentions(text, name) {
  const body = name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu").test(text);
}
