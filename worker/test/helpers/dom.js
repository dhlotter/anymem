// A small fake of the browser DOM for the dashboard tests. It holds only what the screens use: a tree of elements built from the markup
// they write (innerHTML), attributes, classes, the data-* set, the selectors the code asks for, events that bubble, focus, inert and forms.
// It is not a browser and it has no dependency. A test that needs more adds it here.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#96;": "`" };
const unescapeText = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (m) => ENTITIES[m]);

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(value) {
    this.replaceChildren(String(value));
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  _nodes(items) {
    return items.map((n) => (n instanceof Node ? n : new Text(this.ownerDocument, String(n))));
  }
  _detach(n) {
    if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter((c) => c !== n);
    n.parentNode = null;
  }
  append(...items) {
    for (const n of this._nodes(items)) {
      this._detach(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  prepend(...items) {
    const list = this._nodes(items);
    for (const n of list) this._detach(n), (n.parentNode = this);
    this.childNodes.unshift(...list);
  }
  after(...items) {
    const parent = this.parentNode;
    if (!parent) return;
    const list = this._nodes(items);
    for (const n of list) this._detach(n);
    const at = parent.childNodes.indexOf(this);
    parent.childNodes.splice(at + 1, 0, ...list);
    for (const n of list) n.parentNode = parent;
  }
  replaceChildren(...items) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...items);
  }
  remove() {
    if (this.parentNode) this._detach(this);
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value);
  }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    this.inert = false;
    this.disabled = false;
    this._checked = undefined;
    this._value = undefined;
  }
  getAttribute(name) {
    return this.attrs.has(name.toLowerCase()) ? this.attrs.get(name.toLowerCase()) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  hasAttribute(name) {
    return this.attrs.has(name.toLowerCase());
  }
  removeAttribute(name) {
    this.attrs.delete(name.toLowerCase());
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(value) {
    this.setAttribute("id", value);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      add: (...c) => (el.className = [...new Set([...list(), ...c])].join(" ")),
      remove: (...c) => (el.className = list().filter((x) => !c.includes(x)).join(" ")),
      toggle(c, on) {
        const want = on ?? !list().includes(c);
        want ? this.add(c) : this.remove(c);
        return want;
      },
    };
  }
  get dataset() {
    const el = this;
    const attr = (k) => `data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_, k) => el.getAttribute(attr(k)) ?? undefined,
      set: (_, k, v) => (el.setAttribute(attr(k), v), true),
    });
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(on) {
    on ? this.setAttribute("hidden", "") : this.removeAttribute("hidden");
  }
  get name() {
    return this.getAttribute("name") ?? "";
  }
  get checked() {
    return this._checked ?? this.hasAttribute("checked");
  }
  set checked(on) {
    this._checked = Boolean(on);
  }
  get value() {
    if (this.localName === "textarea") return this._value ?? this.textContent;
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(v) {
    this._value = String(v);
  }
  get innerHTML() {
    return "";
  }
  set innerHTML(markup) {
    this.replaceChildren(...parseHTML(this.ownerDocument, String(markup)));
  }
  get offsetWidth() {
    return 0;
  }
  get clientWidth() {
    return 600;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }
  scrollIntoView() {}
  showPopover() {}
  hidePopover() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  click() {
    if (this.localName === "input" && this.getAttribute("type") === "radio") {
      const group = this.closest("form") ?? this.ownerDocument.body;
      for (const r of group.querySelectorAll('input[type="radio"]')) if (r.name === this.name && r !== this) r._checked = false;
      this._checked = true;
    }
    this.dispatchEvent(new Event("click"));
  }
  closest(selector) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n;
    return null;
  }
  matches(selector) {
    return matches(this, selector);
  }
  querySelectorAll(selector) {
    return descendants(this).filter((el) => matches(el, selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    for (const node of path) {
      if (event._stopped) break;
      event.currentTarget = node;
      for (const fn of node.listeners.get(event.type) ?? []) fn.call(node, event);
      if (event.bubbles === false) break;
    }
    if (event.bubbles !== false && !event._stopped) for (const fn of this.ownerDocument.window.listeners.get(event.type) ?? []) fn.call(this.ownerDocument.window, event);
    return !event.defaultPrevented;
  }
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.activeElement = null;
    this.title = "";
    this.listeners = new Map();
    this.window = { listeners: new Map() };
    this.documentElement = this.createElement("html");
    this.append(this.documentElement);
    this.body = this.createElement("body");
    this.documentElement.append(this.body);
  }
  createElement(tag) {
    return new Element(this, tag);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  getElementById(id) {
    return descendants(this).find((el) => el.id === id) ?? null;
  }
  querySelector(selector) {
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

/** A new empty document with a body. */
export function createDocument() {
  return new Document();
}

/** The elements under a node, in document order. */
function descendants(node) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Markup text as nodes. Only what the dashboard writes: tags, quoted or bare attributes, text and entities. */
export function parseHTML(doc, text) {
  const root = new Element(doc, "fragment");
  const stack = [root];
  const tag = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?)*)\s*(\/?)>|([^<]+)|</g;
  for (const m of text.matchAll(tag)) {
    const top = stack.at(-1);
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const name = m[1].toLowerCase();
      const at = stack.map((n) => n.localName).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    if (m[2]) {
      const el = new Element(doc, m[2]);
      for (const a of (m[3] ?? "").matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g)) el.attrs.set(a[1].toLowerCase(), unescapeText(a[2] ?? a[3] ?? a[4] ?? ""));
      top.append(el);
      if (!m[4] && !VOID.has(el.localName)) stack.push(el);
      continue;
    }
    top.append(new Text(doc, unescapeText(m[5] ?? "<")));
  }
  const nodes = [...root.childNodes];
  for (const n of nodes) n.parentNode = null;
  root.childNodes = [];
  return nodes;
}

// Selectors: a list of complex selectors, each a chain of compounds joined by a descendant space or a child >. A compound has a tag,
// ids, classes, attributes (with or without a value) and the :checked pseudo. Any other pseudo never matches.
function splitTop(selector) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of selector) {
    if (quote) (ch === quote && (quote = "")), (cur += ch);
    else if (ch === '"' || ch === "'") (quote = ch), (cur += ch);
    else if (ch === "[") (depth++, (cur += ch));
    else if (ch === "]") (depth--, (cur += ch));
    else if (ch === "," && depth === 0) (out.push(cur.trim()), (cur = ""));
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseCompound(token) {
  const head = /^([a-zA-Z][\w-]*)?/.exec(token)[1];
  const tests = [];
  const rest = token.slice(head?.length ?? 0);
  for (const m of rest.matchAll(/#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|:([\w-]+)/g)) {
    if (m[1]) tests.push((el) => el.id === m[1]);
    else if (m[2]) tests.push((el) => el.classList.contains(m[2]));
    else if (m[7]) tests.push((el) => m[7] === "checked" && Boolean(el.checked));
    else if (m[3]) {
      const want = m[4] ?? m[5] ?? m[6];
      tests.push((el) => (want === undefined ? el.hasAttribute(m[3]) : el.getAttribute(m[3]) === want));
    }
  }
  return { tag: head?.toLowerCase() ?? null, tests };
}

function parseComplex(text) {
  const tokens = text.trim().match(/(?:\[[^\]]*\]|\([^)]*\)|[^\s>[(])+|>/g) ?? [];
  const parts = [];
  let comb = " ";
  for (const tok of tokens) {
    if (tok === ">") comb = ">";
    else {
      parts.push({ compound: parseCompound(tok), comb: parts.length ? comb : " " });
      comb = " ";
    }
  }
  return parts;
}

function matchesCompound(el, c) {
  return (c.tag === null || el.localName === c.tag) && c.tests.every((t) => t(el));
}

function matchesFrom(el, parts, i) {
  if (!matchesCompound(el, parts[i].compound)) return false;
  if (i === 0) return true;
  if (parts[i].comb === ">") return el.parentNode?.nodeType === 1 && matchesFrom(el.parentNode, parts, i - 1);
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchesFrom(p, parts, i - 1)) return true;
  return false;
}

function matches(el, selector) {
  return splitTop(selector).some((s) => {
    const parts = parseComplex(s);
    return parts.length > 0 && matchesFrom(el, parts, parts.length - 1);
  });
}

/** Form values as FormData gives them: named fields only, a checked radio or checkbox only. */
export class FormData {
  constructor(form) {
    this.pairs = [];
    for (const el of form.querySelectorAll("input, select, textarea")) {
      if (!el.name || el.disabled) continue;
      const type = el.getAttribute("type") ?? "";
      if ((type === "radio" || type === "checkbox") && !el.checked) continue;
      this.pairs.push([el.name, el.value]);
    }
  }
  entries() {
    return this.pairs[Symbol.iterator]();
  }
}

/** An event with the fields the screens read. Its target is set when it is dispatched. */
export class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.key = init.key ?? "";
    this.shiftKey = Boolean(init.shiftKey);
    this.ctrlKey = Boolean(init.ctrlKey);
    this.metaKey = Boolean(init.metaKey);
    this.altKey = Boolean(init.altKey);
    this.button = init.button ?? 0;
    this.detail = init.detail ?? 0;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
}

/**
 * Makes a document the page's globals: document, window listeners, Event, CSS, navigator, location and FormData. Returns the document.
 * Each test file runs in its own process under node --test, so the globals stay with that file.
 */
export function installDom(doc = createDocument()) {
  const window = doc.window;
  const globals = {
    document: doc,
    Event,
    FormData,
    addEventListener: (type, fn) => window.listeners.set(type, [...(window.listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => window.listeners.set(type, (window.listeners.get(type) ?? []).filter((f) => f !== fn)),
    dispatchEvent: (event) => {
      event.target = window;
      for (const fn of window.listeners.get(event.type) ?? []) fn.call(window, event);
      return !event.defaultPrevented;
    },
    CSS: { escape: (s) => String(s) },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    navigator: { platform: "Linux", clipboard: { writeText: async () => {} } },
    location: { hash: "", host: "anymem.test" },
    localStorage: { getItem: () => null, setItem: () => {} }, // the theme is the only thing kept, and the tests do not need it
    innerWidth: 1024,
    matchMedia: () => ({ matches: false }),
    scrollTo: () => {},
  };
  // Node defines some of these as getters, so each one is defined, not assigned.
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  return doc;
}
