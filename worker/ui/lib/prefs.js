// The one thing the dashboard remembers in this browser: the theme. Nothing else is stored, and never a
// token or any memory text. A browser that refuses storage just forgets the choice, and the page still works.
const KEYS = { theme: "anymem-theme" };

/** The saved choice, or the fallback when nothing valid is saved or storage is blocked. */
export function readPref(name, allowed, fallback) {
  try {
    const value = localStorage.getItem(KEYS[name]);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Save a choice. A refusal is ignored. */
export function writePref(name, value) {
  try {
    localStorage.setItem(KEYS[name], value);
  } catch {
    // the choice lasts until the page is closed
  }
}
