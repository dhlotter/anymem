// Puts a chart in the page at the width of its box, redraws it when the box changes size, and wires the hover and keyboard layer.
import { attachChart } from "./tooltip.js";

/**
 * @param {HTMLElement} plot the box that holds the svg
 * @param {(width: number) => {toString(): string}} build makes the chart markup for a width
 */
export function mountChart(plot, build) {
  let drawn = 0;
  const draw = () => {
    const width = Math.max(260, Math.floor(plot.clientWidth));
    if (width === drawn) return;
    drawn = width;
    plot.innerHTML = String(build(width));
  };
  draw();
  attachChart(plot);
  const watch = new ResizeObserver(() => (plot.isConnected ? draw() : watch.disconnect()));
  watch.observe(plot);
  return { redraw: () => ((drawn = 0), draw()) };
}
