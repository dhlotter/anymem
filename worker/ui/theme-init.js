// Runs before the first paint so a saved light or dark choice does not flash. Automatic needs nothing, the stylesheet follows the system.
try {
  const saved = localStorage.getItem("anymem-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  // storage is blocked, the system setting decides
}
