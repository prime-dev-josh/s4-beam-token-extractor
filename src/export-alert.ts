export type ExportAlertPayload = {
  kind: "csv" | "pdf";
  filename: string;
  location: string;
  rowCount: number;
  columnCount: number;
};

let bound = false;
let lastFocus: HTMLElement | null = null;

export function initExportAlert() {
  if (bound) return;
  bound = true;
  const overlay = required<HTMLDivElement>("#export-alert");
  const ok = required<HTMLButtonElement>("#export-alert-ok");
  ok.addEventListener("click", () => hideExportAlert());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) hideExportAlert();
  });
  window.addEventListener("keydown", (event) => {
    if (overlay.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hideExportAlert();
    }
  });
}

export function showExportAlert(payload: ExportAlertPayload) {
  initExportAlert();
  const ui = elements();
  const label = payload.kind === "csv" ? "CSV exported" : "PDF exported";
  ui.title.textContent = label;
  ui.file.textContent = payload.filename;
  ui.path.textContent = payload.location;
  ui.detail.textContent = `${payload.columnCount} columns · ${payload.rowCount.toLocaleString()} rows written.`;
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ui.overlay.hidden = false;
  ui.ok.focus();
}

export function hideExportAlert() {
  const ui = elements();
  if (ui.overlay.hidden) return;
  ui.overlay.hidden = true;
  lastFocus?.focus();
  lastFocus = null;
}

function elements() {
  return {
    overlay: required<HTMLDivElement>("#export-alert"),
    title: required<HTMLHeadingElement>("#export-alert-title"),
    file: required<HTMLElement>("#export-alert-file"),
    path: required<HTMLElement>("#export-alert-path"),
    detail: required<HTMLParagraphElement>("#export-alert-detail"),
    ok: required<HTMLButtonElement>("#export-alert-ok"),
  };
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
