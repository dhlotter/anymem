// The theme choice: auto follows the system, light and dark are fixed. The stylesheet reads data-theme on the root.
import { readPref, writePref } from "./prefs.js";

export const THEMES = ["auto", "light", "dark"];

export const currentTheme = () => readPref("theme", THEMES, "auto");

/** Apply a choice to the page and remember it. */
export function setTheme(choice, root = document.documentElement) {
  const theme = THEMES.includes(choice) ? choice : "auto";
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  writePref("theme", theme);
  return theme;
}
