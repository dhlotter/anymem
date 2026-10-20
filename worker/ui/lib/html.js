// Safe HTML building. Everything that is interpolated into html`...` is escaped, so text from the store can never become
// markup. Only the result of another html`...` call, or raw(), is inserted as it is.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Escape text for use in HTML content or in a quoted attribute. */
export const esc = (value) => String(value ?? "").replace(/[&<>"'`]/g, (c) => ESCAPES[c]);

class Markup {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

/** Mark text as already safe. Use it only for strings written in this code base, never for store data. */
export const raw = (text) => new Markup(String(text));

function part(value) {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(part).join("");
  if (value === null || value === undefined || value === false) return "";
  return esc(value);
}

/** A template tag. Values are escaped, nested html`` results and arrays of them are kept. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += part(v) + strings[i + 1];
  });
  return new Markup(out);
}
