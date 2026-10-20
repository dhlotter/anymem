// The hover and keyboard layer of a chart. Every mark that carries data-tip shows its text in one tooltip. The text is
// written with textContent, so a label from the store can never become markup. Tooltips never gate a value, the table twin has them all.

let tip;
let live;

function ensure() {
  if (tip) return;
  tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "presentation");
  tip.hidden = true;
  live = document.createElement("div");
  live.className = "sr";
  live.setAttribute("aria-live", "polite");
  document.body.append(tip, live);
}

function show(text, x, y) {
  ensure();
  tip.replaceChildren(...text.split("\n").map((line, i) => Object.assign(document.createElement("div"), { className: i === 0 ? "tip__head" : "tip__row", textContent: line })));
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - box.width / 2), document.documentElement.clientWidth - box.width - 8);
  const top = y - box.height - 12 < 8 ? y + 18 : y - box.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hide() {
  if (tip) tip.hidden = true;
}

/** Wire one chart wrapper. The wrapper holds the svg, takes focus, and moves between marks with the arrow keys. */
export function attachChart(plot) {
  const marks = () => [...plot.querySelectorAll("[data-tip]")];
  let at = -1;
  const focusMark = (i) => {
    const list = marks();
    if (!list.length) return;
    at = Math.max(0, Math.min(list.length - 1, i));
    const rect = list[at].getBoundingClientRect();
    const text = list[at].dataset.tip;
    show(text, rect.left + rect.width / 2, rect.top + Math.min(rect.height, 40) / 2 + 20);
    ensure();
    live.textContent = text.replace(/\n/g, ", ");
    for (const m of list) m.classList.toggle("is-on", m === list[at]);
  };
  const clear = () => {
    hide();
    for (const m of marks()) m.classList.remove("is-on");
    at = -1;
  };
  plot.addEventListener("pointermove", (e) => {
    const mark = e.target.closest?.("[data-tip]");
    if (!mark) return clear();
    for (const m of marks()) m.classList.toggle("is-on", m === mark);
    show(mark.dataset.tip, e.clientX, e.clientY);
  });
  plot.addEventListener("pointerleave", clear);
  plot.addEventListener("blur", clear);
  plot.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") (e.preventDefault(), focusMark(at < 0 ? (e.key === "ArrowRight" ? 0 : marks().length - 1) : at + (e.key === "ArrowRight" ? 1 : -1)));
    else if (e.key === "Home") (e.preventDefault(), focusMark(0));
    else if (e.key === "End") (e.preventDefault(), focusMark(marks().length - 1));
    else if (e.key === "Escape") clear();
  });
}
