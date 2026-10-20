// The command that saves a memory. The dashboard never saves an explicit memory itself, a browser login may only save profile and
// person notes, so this builds the command to run where the anymem skill is installed. Pure.

/** A heredoc delimiter that the text does not contain on a line of its own. */
function delimiter(text) {
  const lines = new Set(text.split("\n").map((l) => l.trim()));
  for (let i = 0; ; i++) {
    const d = i === 0 ? "ANYMEM_TEXT" : `ANYMEM_TEXT_${i}`;
    if (!lines.has(d)) return d;
  }
}

/** @returns {string} the shell command, or empty text when there is nothing to save */
export function rememberCommand(text) {
  const body = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!body) return "";
  const d = delimiter(body);
  return `remember.py <<'${d}'\n${body}\n${d}`;
}
