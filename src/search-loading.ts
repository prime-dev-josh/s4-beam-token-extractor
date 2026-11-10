import { setNavigationLocked } from "./router.ts";

const FLAVOR = [
  "Opening Signal4 Beam channel",
  "Handshaking with Signal4 Beam",
  "Scanning crash indexes",
  "Walking event pages",
  "Collating matching records",
  "Holding for Signal4 Beam",
];

const BLOCKED_KEYS = new Set([
  "Tab",
  "Escape",
  "Enter",
  " ",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
]);

let shown = false;
let startedAt = 0;
let flavorIndex = 0;
let timerId = 0;
let flavorId = 0;
let previousOverflow = "";
let cancelHandler: (() => void) | null = null;
let cancelBound = false;

export function showSearchLoading(status: string, onCancel?: () => void) {
  const ui = elements();
  bindCancel();
  cancelHandler = onCancel ?? null;
  shown = true;
  startedAt = performance.now();
  flavorIndex = 0;
  ui.overlay.hidden = false;
  ui.flavor.textContent = FLAVOR[0];
  ui.status.textContent = status;
  ui.elapsed.textContent = formatElapsed(0);
  ui.announce.textContent =
    "Search in progress. Input is locked. Press Cancel search or Escape to stop and adjust the query.";
  document.body.classList.add("search-locked");
  document.body.setAttribute("aria-busy", "true");
  ui.app.inert = true;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  setNavigationLocked(true);
  bindLock(true);
  window.clearInterval(timerId);
  window.clearInterval(flavorId);
  tick();
  timerId = window.setInterval(tick, 100);
  flavorId = window.setInterval(rotateFlavor, 2400);
  ui.overlay.focus({ preventScroll: true });
}

export function updateSearchLoading(status: string) {
  if (!shown) return;
  elements().status.textContent = status;
}

export function hideSearchLoading() {
  if (!shown) return;
  shown = false;
  window.clearInterval(timerId);
  window.clearInterval(flavorId);
  timerId = 0;
  flavorId = 0;
  bindLock(false);
  setNavigationLocked(false);
  const ui = elements();
  ui.app.inert = false;
  document.body.classList.remove("search-locked");
  document.body.removeAttribute("aria-busy");
  document.body.style.overflow = previousOverflow;
  ui.announce.textContent = "";
  ui.overlay.hidden = true;
  cancelHandler = null;
}

function requestCancel() {
  cancelHandler?.();
}

function tick() {
  elements().elapsed.textContent = formatElapsed(performance.now() - startedAt);
}

function rotateFlavor() {
  flavorIndex = (flavorIndex + 1) % FLAVOR.length;
  const flavor = elements().flavor;
  flavor.classList.remove("tick");
  flavor.textContent = FLAVOR[flavorIndex];
  void flavor.offsetWidth;
  flavor.classList.add("tick");
}

function formatElapsed(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function bindLock(lock: boolean) {
  if (lock) {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    document.addEventListener("click", onBlock, true);
    document.addEventListener("pointerdown", onBlock, true);
    document.addEventListener("contextmenu", onBlock, true);
    document.addEventListener("wheel", onBlock, { capture: true, passive: false });
    document.addEventListener("touchmove", onBlock, { capture: true, passive: false });
    return;
  }
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  document.removeEventListener("click", onBlock, true);
  document.removeEventListener("pointerdown", onBlock, true);
  document.removeEventListener("contextmenu", onBlock, true);
  document.removeEventListener("wheel", onBlock, true);
  document.removeEventListener("touchmove", onBlock, true);
}

function onKey(event: Event) {
  if (!shown || !(event instanceof KeyboardEvent)) return;
  if (event.key === "Escape" && event.type === "keydown") {
    event.preventDefault();
    event.stopPropagation();
    requestCancel();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "F5" || event.key === "F12") return;
  if (!BLOCKED_KEYS.has(event.key) && event.type !== "keydown") return;
  if (BLOCKED_KEYS.has(event.key) || event.key.length === 1) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function onBlock(event: Event) {
  if (!shown) return;
  const target = event.target;
  if (target instanceof Element && target.closest("#loading-cancel")) return;
  event.preventDefault();
  event.stopPropagation();
}

function bindCancel() {
  if (cancelBound) return;
  cancelBound = true;
  const cancel = required<HTMLButtonElement>("#loading-cancel");
  cancel.addEventListener("click", () => requestCancel());
}

function elements() {
  return {
    overlay: required<HTMLDivElement>("#search-loading"),
    flavor: required<HTMLParagraphElement>("#loading-flavor"),
    status: required<HTMLParagraphElement>("#loading-status"),
    elapsed: required<HTMLElement>("#loading-elapsed"),
    announce: required<HTMLParagraphElement>("#loading-announce"),
    app: required<HTMLElement>(".app"),
  };
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
