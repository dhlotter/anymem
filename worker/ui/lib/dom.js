// The few DOM helpers the screens share. Not used by the tests.
import { describeError } from "./api.js";

/** Replace the contents of an element with a view. The view is an html`` result, so everything in it is escaped. */
export const show = (root, view) => {
  if (root.isConnected) root.innerHTML = String(view); // a screen that was left while loading stays quiet
};

/** One click listener for the whole screen. Buttons say what they do with data-action. */
export function onAction(root, handlers) {
  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    const handler = el && handlers[el.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(el, event);
  });
}

/** One submit listener per named form. */
export function onSubmit(root, handlers) {
  root.addEventListener("submit", (event) => {
    const handler = handlers[event.target.dataset.form];
    if (!handler) return;
    event.preventDefault();
    handler(event.target, event);
  });
}

/** One change listener per named form or control, for controls that apply as soon as they change, such as a tab or a range. */
export function onChange(root, handlers) {
  root.addEventListener("change", (event) => {
    const el = event.target.closest("[data-change]");
    const handler = el && handlers[el.dataset.change];
    if (handler) handler(el, event);
  });
}

/** One click listener per named choice, for column filters. A pointer click or Enter applies a choice; an arrow key only moves it (grid.js). */
export function onPick(root, handlers) {
  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-pick]");
    const handler = el && handlers[el.dataset.pick];
    if (handler) handler(el, event);
  });
}

/** The fields of a form as an object of text. */
export const formValues = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));

/** Put a message in a status area. Errors use role alert so a screen reader says them at once. */
export function say(area, message, isError = false) {
  area.setAttribute("role", isError ? "alert" : "status");
  area.className = isError ? "notice notice--error" : "notice";
  area.textContent = message;
}

/**
 * Run an action and show its failure in the status area. Returns undefined on failure. onError may add to the message.
 * current says whether the request is still the newest one for this area. A request that was overtaken shows nothing, neither its answer nor its error.
 */
export async function attempt(area, work, onError, current = () => true) {
  try {
    return await work();
  } catch (err) {
    if (!current()) return undefined;
    say(area, describeError(err), true);
    onError?.(err, area);
    return undefined;
  }
}

/**
 * A message in the corner, with at most one button. Success stays silent, so this is for failures and for undo.
 * New messages stack above the old ones and nothing on the page moves.
 */
export function notify(message, { action, tone = "info", seconds = 10 } = {}) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const box = document.createElement("div");
  box.className = `toast toast--${tone}`;
  box.setAttribute("role", tone === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  box.append(text);
  const close = () => box.remove();
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--ghost";
    button.textContent = action.label;
    button.addEventListener("click", () => (close(), action.run()));
    box.append(button);
  }
  host.prepend(box);
  const timer = setTimeout(close, seconds * 1000);
  box.addEventListener("pointerenter", () => clearTimeout(timer), { once: true });
}
