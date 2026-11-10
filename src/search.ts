import { invoke } from "@tauri-apps/api/core";
import { CRASH_FIELDS } from "./crash-fields.ts";
import {
  filterKey,
  formatSearchPath,
  parsePage,
  prepareSearch,
  type QueryError,
  type SearchDraft,
  type SearchRequest,
} from "./crash-query.ts";
import { formatRemaining, getToken, hasToken, subscribe } from "./session.ts";
import { go, subscribeRoute } from "./router.ts";
import {
  csvFromSnapshot,
  downloadBlob,
  exportFilename,
  pdfFromSnapshot,
  snapshotTable,
} from "./export-table.ts";

const HIDDEN_COLUMNS_KEY = "beam-crash-hidden-columns";
const ERROR_CAUSES: Record<number, string> = {
  0: "An unexpected exception was encountered in PL/SQL code for the handler.",
  1: "Parameter of crash_date or s4_update_date was not provided.",
  2: "Parameter value did not match the expected format mask.",
  3: "Parameter value is too long.",
  4: "Parameter value of date type is not a real date (for example, 2/31/2020).",
  5: "Order of date range components in the date parameter is not chronological.",
};

type SearchMode = "idle" | "summary" | "table";
type Totals = { totalRecords: number; totalPages: number; pageSize: number };
type ActiveQuery = { crashDate: string | null; s4UpdateDate: string | null };

type CrashPayload = {
  summary?: {
    total_records?: unknown;
    total_pages?: unknown;
    page_size?: unknown;
  };
  items?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
};

type CrashSearchResponse = {
  httpStatus: number;
  payload: CrashPayload;
};

type SearchOptions = {
  setStatus: (message: string, ok?: boolean) => void;
};

export function initSearch(options: SearchOptions) {
  const sessionNote = required<HTMLParagraphElement>("#session-note");
  const form = required<HTMLFormElement>("#crash-search-form");
  const crashMode = required<HTMLSelectElement>("#crash-mode");
  const crashSingle = required<HTMLDivElement>("#crash-single");
  const crashRange = required<HTMLDivElement>("#crash-range");
  const crashDay = required<HTMLInputElement>("#crash-day");
  const crashStart = required<HTMLInputElement>("#crash-start");
  const crashEnd = required<HTMLInputElement>("#crash-end");
  const crashField = required<HTMLFieldSetElement>("#crash-field");
  const updateMode = required<HTMLSelectElement>("#update-mode");
  const updateSingle = required<HTMLDivElement>("#update-single");
  const updateRange = required<HTMLDivElement>("#update-range");
  const updateAt = required<HTMLInputElement>("#update-at");
  const updateStart = required<HTMLInputElement>("#update-start");
  const updateEnd = required<HTMLInputElement>("#update-end");
  const updateField = required<HTMLFieldSetElement>("#update-field");
  const slowNote = required<HTMLParagraphElement>("#slow-note");
  const preview = required<HTMLParagraphElement>("#query-preview");
  const errorBox = required<HTMLDivElement>("#search-error");
  const errorCode = required<HTMLParagraphElement>("#error-code");
  const errorMessage = required<HTMLParagraphElement>("#error-message");
  const errorDetails = required<HTMLParagraphElement>("#error-details");
  const errorCause = required<HTMLParagraphElement>("#error-cause");
  const errorSource = required<HTMLParagraphElement>("#error-source");
  const activeQuery = required<HTMLParagraphElement>("#active-query");
  const pageInput = required<HTMLInputElement>("#page");
  const pagePrev = required<HTMLButtonElement>("#page-prev");
  const pageNext = required<HTMLButtonElement>("#page-next");
  const pageGo = required<HTMLButtonElement>("#page-go");
  const pageMeta = required<HTMLParagraphElement>("#page-meta");
  const toggleColumns = required<HTMLButtonElement>("#toggle-columns");
  const columnCount = required<HTMLSpanElement>("#column-count");
  const columnPanel = required<HTMLDivElement>("#column-panel");
  const columnSearch = required<HTMLInputElement>("#column-search");
  const columnsAll = required<HTMLButtonElement>("#columns-all");
  const columnsNone = required<HTMLButtonElement>("#columns-none");
  const exportCsv = required<HTMLButtonElement>("#export-csv");
  const exportPdf = required<HTMLButtonElement>("#export-pdf");
  const columnList = required<HTMLDivElement>("#column-list");
  const resultsRegion = required<HTMLDivElement>("#results-region");
  const fieldNoteList = required<HTMLUListElement>("#field-note-list");
  const searchRecords = required<HTMLButtonElement>("#search-records");
  const searchSummary = required<HTMLButtonElement>("#search-summary");

  const hidden = loadHiddenColumns();
  let tokenReady = false;
  let busy = false;
  let mode: SearchMode = "idle";
  let active: ActiveQuery | null = null;
  let totals: Totals | null = null;
  let summaryText = { totalRecords: "—", totalPages: "—", pageSize: "—" };
  let items: Record<string, unknown>[] = [];
  let loadedPage: number | null = null;

  required<HTMLButtonElement>("#search-go-token").addEventListener("click", () => {
    go("token");
  });
  required<HTMLButtonElement>("#search-go-settings").addEventListener("click", () => {
    go("settings");
  });

  subscribeRoute((route) => {
    if (route === "search") void widenWindow();
  });

  subscribe((session) => {
    tokenReady = hasToken();
    if (!session.token) {
      sessionNote.textContent =
        "No access token in this session. Request one on Get API Token, or paste one in Settings.";
    } else if (session.source === "pasted") {
      sessionNote.textContent =
        "Search will use the pasted token. Expiration is unknown because this token was not requested in the app.";
    } else if (session.expired) {
      sessionNote.textContent =
        "The in-app token has expired. Request a new token before searching.";
    } else {
      sessionNote.textContent = `Search will send the in-app token as a bearer token. ${formatRemaining(session.remainingMs)} remaining.`;
    }
    setSearchEnabled(tokenReady);
  });

  renderColumnList();
  renderFieldNotes();
  syncModes();
  refreshChrome();
  renderResults();

  for (const input of [crashDay, crashStart, crashEnd, updateAt, updateStart, updateEnd, pageInput]) {
    input.addEventListener("input", () => {
      clearFieldState();
      refreshChrome();
    });
  }
  for (const input of [crashDay, crashStart, crashEnd, updateAt, updateStart, updateEnd]) {
    input.addEventListener("change", () => {
      const nextKey = currentFilterKey();
      if (active && nextKey && nextKey !== filterKey(active)) {
        pageInput.value = "1";
      }
      refreshChrome();
    });
  }
  crashMode.addEventListener("change", () => {
    syncModes();
    refreshChrome();
  });
  updateMode.addEventListener("change", () => {
    syncModes();
    refreshChrome();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void executeForm("records");
  });
  searchSummary.addEventListener("click", () => {
    void executeForm("summary");
  });
  pagePrev.addEventListener("click", () => {
    const parsed = parsePage(pageInput.value);
    const current = parsed.ok ? parsed.value : 1;
    void loadAbsolutePage(Math.max(1, current - 1));
  });
  pageNext.addEventListener("click", () => {
    const parsed = parsePage(pageInput.value);
    const current = parsed.ok ? parsed.value : 1;
    void loadAbsolutePage(current + 1);
  });
  pageGo.addEventListener("click", () => {
    const parsed = parsePage(pageInput.value);
    if (!parsed.ok) {
      showError(parsed.error, "local");
      return;
    }
    void loadAbsolutePage(parsed.value);
  });
  toggleColumns.addEventListener("click", () => {
    const show = columnPanel.hidden;
    columnPanel.hidden = !show;
    toggleColumns.setAttribute("aria-expanded", String(show));
    if (show) columnSearch.focus();
  });
  columnSearch.addEventListener("input", applyColumnFilter);
  columnsAll.addEventListener("click", () => setAllColumns(true));
  columnsNone.addEventListener("click", () => setAllColumns(false));
  exportCsv.addEventListener("click", () => {
    void exportVisible("csv");
  });
  exportPdf.addEventListener("click", () => {
    void exportVisible("pdf");
  });
  resultsRegion.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.action === "open-page-1") {
      void loadAbsolutePage(1);
    }
  });

  function setSearchEnabled(enabled: boolean) {
    searchRecords.disabled = !enabled || busy;
    searchSummary.disabled = !enabled || busy;
    if (!enabled || busy) {
      pagePrev.disabled = true;
      pageNext.disabled = true;
      pageGo.disabled = true;
      updateExport();
      return;
    }
    updatePager();
    updateExport();
  }

  async function executeForm(kind: "records" | "summary") {
    if (busy) return;
    stampDateLimits();
    const snapshot = pageInput.value;
    const prepared = prepareSearch(readDraft(), kind);
    if (!prepared.ok) {
      showError(prepared.error, "local");
      return;
    }
    if (!ensureToken()) return;
    if (kind === "records" && prepared.request.page != null) {
      pageInput.value = String(prepared.request.page);
    }
    const ok = await run(prepared.request, kind);
    if (!ok) pageInput.value = snapshot;
  }

  async function loadAbsolutePage(page: number) {
    const snapshot = pageInput.value;
    pageInput.value = String(page);
    const ok = await executePager();
    if (!ok) pageInput.value = snapshot;
  }

  async function executePager(): Promise<boolean> {
    if (busy) return false;
    if (!ensureToken()) return false;
    if (!active) {
      showError(
        {
          message: "Search or get an overview before paging.",
          details: "Previous, next, and go reuse the date filters from the last successful request.",
        },
        "local",
      );
      return false;
    }
    const parsed = parsePage(pageInput.value);
    if (!parsed.ok) {
      showError(parsed.error, "local");
      return false;
    }
    return run(
      {
        crashDate: active.crashDate,
        s4UpdateDate: active.s4UpdateDate,
        page: parsed.value,
      },
      "records",
    );
  }

  async function run(request: SearchRequest, kind: "records" | "summary"): Promise<boolean> {
    busy = true;
    setSearchEnabled(tokenReady);
    clearError();
    const slow = !request.crashDate && !!request.s4UpdateDate;
    options.setStatus(
      kind === "summary"
        ? slow
          ? "Loading the overview summary. A search that uses only the update time can take a while."
          : "Loading the overview summary."
        : slow
          ? "Searching crash events. A search that uses only the update time can take a while."
          : "Searching crash events.",
    );
    try {
      const args: Record<string, unknown> = { accessToken: getToken() };
      if (request.crashDate) args.crashDate = request.crashDate;
      if (request.s4UpdateDate) args.s4UpdateDate = request.s4UpdateDate;
      if (request.page != null) args.page = request.page;
      const result = await invoke<CrashSearchResponse>("search_crash_events", args);
      const failure = readFailure(result);
      if (failure) {
        showError(failure, result.httpStatus === 0 ? "local" : "api");
        options.setStatus(failure.message);
        return false;
      }
      const sameFilters = active != null && filterKey(active) === filterKey(request);
      if (!sameFilters) totals = null;
      active = { crashDate: request.crashDate, s4UpdateDate: request.s4UpdateDate };
      if (kind === "summary" && result.payload.summary) {
        rememberSummary(result.payload.summary);
        mode = "summary";
        loadedPage = null;
        options.setStatus("Overview summary ready.", true);
      } else if (Array.isArray(result.payload.items)) {
        items = result.payload.items.filter(isRecord);
        loadedPage = request.page;
        mode = "table";
        if (request.page != null) pageInput.value = String(request.page);
        options.setStatus(
          items.length === 0 ? "The crash event service returned no records on this page." : "Crash events loaded.",
          true,
        );
      } else if (result.payload.summary) {
        rememberSummary(result.payload.summary);
        mode = "summary";
        loadedPage = null;
        options.setStatus("Overview summary ready.", true);
      } else {
        showError(
          {
            message: "The crash event service returned an unexpected response.",
            details: "A page of records arrives as items. An overview arrives as summary.",
          },
          "api",
        );
        options.setStatus("Unexpected response from the crash event service.");
        return false;
      }
      clearError();
      refreshChrome();
      renderResults();
      resultsRegion.scrollIntoView({ block: "nearest" });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showError(
        {
          message: "Could not reach the Beam crash event service.",
          details: message,
        },
        "api",
      );
      options.setStatus(message);
      return false;
    } finally {
      busy = false;
      setSearchEnabled(tokenReady);
    }
  }

  function rememberSummary(summary: NonNullable<CrashPayload["summary"]>) {
    totals = readTotals(summary);
    summaryText = {
      totalRecords: displayCount(summary.total_records),
      totalPages: displayCount(summary.total_pages),
      pageSize: displayCount(summary.page_size),
    };
  }

  function ensureToken(): boolean {
    if (getToken().trim()) return true;
    showError(
      {
        message: "Get an API token before searching.",
        details: "Open Get API Token to request one from your credentials file, or paste a bearer token in Settings.",
      },
      "local",
    );
    return false;
  }

  function readDraft(): SearchDraft {
    return {
      crashMode: modeValue(crashMode.value),
      crashDay: crashDay.value,
      crashStart: crashStart.value,
      crashEnd: crashEnd.value,
      updateMode: modeValue(updateMode.value),
      updateAt: updateAt.value,
      updateStart: updateStart.value,
      updateEnd: updateEnd.value,
      page: pageInput.value,
    };
  }

  function currentFilterKey(): string | null {
    const prepared = prepareSearch(readDraft(), "summary");
    if (!prepared.ok) return null;
    return filterKey(prepared.request);
  }

  function syncModes() {
    crashSingle.hidden = crashMode.value !== "single";
    crashRange.hidden = crashMode.value !== "range";
    updateSingle.hidden = updateMode.value !== "single";
    updateRange.hidden = updateMode.value !== "range";
    slowNote.hidden = !(updateMode.value !== "off" && crashMode.value === "off");
  }

  function refreshChrome() {
    stampDateLimits();
    syncModes();
    const prepared = prepareSearch(readDraft(), "records");
    preview.textContent = prepared.ok
      ? `Search records sends ${formatSearchPath(prepared.request)}. Get Overview Summary sends the same dates with page left off.`
      : "Add a crash date, an update time, or both. At least one is required. Page is sent only by Search records, previous, next, and go.";
    if (active) {
      const path = formatSearchPath({ ...active, page: null });
      const draftKey = currentFilterKey();
      const drifted = draftKey != null && draftKey !== filterKey(active);
      activeQuery.textContent = drifted
        ? `Paging still uses ${path}. The form has unsent date changes. Submit Search records or Get Overview Summary to apply them.`
        : `Paging reuses ${path}.`;
    } else {
      activeQuery.textContent = "Paging stays off until a search or an overview summary succeeds.";
    }
    updateColumnCount();
    updatePager();
    updateExport();
  }

  function updatePager() {
    const parsed = parsePage(pageInput.value);
    const page = parsed.ok ? parsed.value : null;
    const canPage = tokenReady && !busy && active != null;
    pageGo.disabled = !canPage;
    pagePrev.disabled = !canPage || page == null || page <= 1;
    const atEnd =
      page != null &&
      ((totals != null && page >= totals.totalPages) ||
        (mode === "table" && loadedPage === page && items.length < (totals?.pageSize ?? 500)));
    pageNext.disabled = !canPage || page == null || atEnd;
    if (mode === "summary" && totals) {
      pageMeta.textContent = `Overview is showing instead of a page. ${totals.totalRecords.toLocaleString()} records, ${totals.totalPages.toLocaleString()} pages, ${totals.pageSize.toLocaleString()} per page. Go loads the page number into the table.`;
    } else if (mode === "table" && loadedPage != null) {
      const of = totals ? ` of ${totals.totalPages.toLocaleString()}` : "";
      pageMeta.textContent = `Showing page ${loadedPage.toLocaleString()}${of}. Each page holds ${totals ? totals.pageSize.toLocaleString() : "500"} records. A page past the end returns an empty list.`;
    } else if (totals) {
      pageMeta.textContent = `${totals.totalRecords.toLocaleString()} records across ${totals.totalPages.toLocaleString()} pages.`;
    } else {
      pageMeta.textContent = "Page 1 is the first block of records. The overview summary does not use this number.";
    }
  }

  function renderResults() {
    resultsRegion.replaceChildren();
    try {
      if (mode === "summary") {
        resultsRegion.append(renderSummary());
        return;
      }
      if (mode !== "table") {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent = "Run Search records for a page of crash events, or Get Overview Summary for the match totals.";
        resultsRegion.append(empty);
        return;
      }
      const fields = CRASH_FIELDS.filter((field) => !hidden.has(field.key));
      if (items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent =
          loadedPage != null && loadedPage > 1
            ? "No records on this page. Beam returns an empty list when the page is past the last page, instead of an error."
            : "No crash events matched these filters.";
        resultsRegion.append(empty);
        return;
      }
      if (fields.length === 0) {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent = "Every column is hidden. Check at least one column to see this page.";
        resultsRegion.append(empty);
        return;
      }
      const hint = document.createElement("p");
      hint.className = "scroll-hint";
      hint.textContent = `${items.length.toLocaleString()} read-only records on this page. Scroll horizontally to move across the columns. Full CSV and PDF export the columns currently shown.`;
      const scroller = document.createElement("div");
      scroller.className = "table-scroll";
      scroller.tabIndex = 0;
      scroller.setAttribute("aria-label", "Crash event results");
      scroller.append(renderTable(fields, items));
      resultsRegion.append(hint, scroller);
    } finally {
      updateExport();
    }
  }

  function updateExport() {
    const ready = resultsRegion.querySelector(".results-table") != null && !busy;
    exportCsv.disabled = !ready;
    exportPdf.disabled = !ready;
  }

  async function exportVisible(kind: "csv" | "pdf") {
    const table = resultsRegion.querySelector<HTMLTableElement>(".results-table");
    if (!table) {
      options.setStatus("Load a page of crash events before exporting.");
      return;
    }
    const snapshot = snapshotTable(table);
    if (snapshot.headers.length === 0) {
      options.setStatus("Check at least one column before exporting.");
      return;
    }
    const filename = exportFilename(kind, loadedPage);
    const query = active ? formatSearchPath({ ...active, page: loadedPage }) : "";
    const subtitle = [
      query,
      `${snapshot.headers.length} columns shown`,
      `${snapshot.rows.length.toLocaleString()} records`,
    ]
      .filter(Boolean)
      .join(" · ");
    exportCsv.disabled = true;
    exportPdf.disabled = true;
    try {
      if (kind === "csv") {
        downloadBlob(
          filename,
          new Blob([csvFromSnapshot(snapshot)], { type: "text/csv;charset=utf-8" }),
        );
        options.setStatus(
          `CSV saved with ${snapshot.headers.length} columns and ${snapshot.rows.length.toLocaleString()} rows.`,
          true,
        );
        return;
      }
      options.setStatus("Building PDF.");
      const blob = await pdfFromSnapshot(snapshot, {
        title: "Signal4 Beam crash events",
        subtitle,
      });
      downloadBlob(filename, blob);
      options.setStatus(
        `PDF saved with ${snapshot.headers.length} columns and ${snapshot.rows.length.toLocaleString()} rows.`,
        true,
      );
    } catch (error) {
      options.setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      updateExport();
    }
  }

  function renderSummary(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "summary-view";
    const title = document.createElement("h3");
    title.textContent = "Overview summary";
    const copy = document.createElement("p");
    copy.textContent =
      "Page was left off, so Beam returned totals instead of crash records. This replaces the table until you load a page.";
    const list = document.createElement("dl");
    for (const [label, value] of [
      ["Total records", summaryText.totalRecords],
      ["Total pages", summaryText.totalPages],
      ["Page size", summaryText.pageSize],
    ] as const) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      row.append(term, detail);
      list.append(row);
    }
    const follow = document.createElement("p");
    follow.className = "hint";
    follow.textContent = totals && totals.totalRecords === 0
      ? "Nothing matched these filters."
      : "Open page 1 to load the first block of records into the table. Each page is read-only.";
    wrap.append(title, copy, list);
    if (!totals || totals.totalPages > 0) {
      const openPage = document.createElement("button");
      openPage.type = "button";
      openPage.className = "primary";
      openPage.dataset.action = "open-page-1";
      openPage.textContent = "Open page 1";
      wrap.append(openPage);
    }
    wrap.append(follow);
    return wrap;
  }

  function renderColumnList() {
    columnList.replaceChildren(
      columnGroup("Crash report", CRASH_FIELDS.filter((field) => !field.key.startsWith("s4_"))),
      columnGroup("Signal4 derived", CRASH_FIELDS.filter((field) => field.key.startsWith("s4_"))),
    );
  }

  function columnGroup(title: string, fields: typeof CRASH_FIELDS): HTMLElement {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);
    for (const field of fields) {
      const label = document.createElement("label");
      label.dataset.search = `${field.label} ${field.key}`.toLowerCase();
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !hidden.has(field.key);
      input.addEventListener("change", () => {
        if (input.checked) hidden.delete(field.key);
        else hidden.add(field.key);
        persistHiddenColumns(hidden);
        updateColumnCount();
        if (mode === "table") renderResults();
      });
      const text = document.createElement("span");
      text.textContent = field.label;
      const key = document.createElement("code");
      key.textContent = field.key;
      label.append(input, text, key);
      if (field.format || field.note) {
        const meta = document.createElement("small");
        meta.textContent = [field.format, field.note].filter(Boolean).join(" · ");
        label.append(meta);
      }
      section.append(label);
    }
    return section;
  }

  function applyColumnFilter() {
    const query = columnSearch.value.trim().toLowerCase();
    for (const section of columnList.querySelectorAll("section")) {
      let visible = 0;
      for (const label of section.querySelectorAll("label")) {
        const haystack = label.dataset.search ?? "";
        const match = query.length === 0 || haystack.includes(query);
        label.hidden = !match;
        if (match) visible += 1;
      }
      section.hidden = visible === 0;
    }
  }

  function setAllColumns(checked: boolean) {
    hidden.clear();
    if (!checked) {
      for (const field of CRASH_FIELDS) hidden.add(field.key);
    }
    for (const input of columnList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      input.checked = checked;
    }
    persistHiddenColumns(hidden);
    updateColumnCount();
    if (mode === "table") renderResults();
  }

  function updateColumnCount() {
    const shown = CRASH_FIELDS.length - hidden.size;
    columnCount.textContent = `${shown} of ${CRASH_FIELDS.length} columns shown`;
  }

  function renderFieldNotes() {
    for (const field of CRASH_FIELDS) {
      if (!field.note) continue;
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = field.label;
      item.append(name, document.createTextNode(` (${field.key}): ${field.note}`));
      fieldNoteList.append(item);
    }
  }

  function showError(error: QueryError, source: "local" | "api") {
    crashField.classList.toggle("invalid", error.field === "crash_date");
    updateField.classList.toggle("invalid", error.field === "s4_update_date");
    pageInput.classList.toggle("invalid", error.field === "page");
    errorCode.textContent = error.code == null ? "" : `Code ${error.code}`;
    errorMessage.textContent = error.message;
    errorDetails.textContent = error.details ?? "";
    errorCause.textContent = error.code != null && ERROR_CAUSES[error.code] ? `Cause: ${ERROR_CAUSES[error.code]}` : "";
    errorSource.textContent = source === "local"
      ? "Checked before the request was sent."
      : "Returned by the crash event service.";
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: "nearest" });
  }

  function clearError() {
    errorBox.hidden = true;
    clearFieldState();
  }

  function clearFieldState() {
    crashField.classList.remove("invalid");
    updateField.classList.remove("invalid");
    pageInput.classList.remove("invalid");
  }

  function stampDateLimits() {
    const today = localYmd(new Date());
    crashDay.max = today;
    crashStart.max = today;
    crashEnd.max = today;
    const now = localTimestamp(new Date());
    updateAt.max = now;
    updateStart.max = now;
    updateEnd.max = now;
  }
}

function renderTable(fields: typeof CRASH_FIELDS, items: Record<string, unknown>[]): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "results-table";
  const caption = document.createElement("caption");
  caption.className = "sr-only";
  caption.textContent = "Crash event records";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const field of fields) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = field.label;
    const title = [`${field.label} (${field.key})`, field.format, field.note].filter(Boolean).join(". ");
    cell.title = title;
    headRow.append(cell);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const item of items) {
    const row = document.createElement("tr");
    for (const field of fields) {
      const cell = document.createElement("td");
      cell.textContent = cellText(item[field.key]);
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  return table;
}

function cellText(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.length > 0 ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function readFailure(result: CrashSearchResponse): QueryError | null {
  const payload = result.payload;
  const error = payload?.error;
  const httpFailed = result.httpStatus === 0 || result.httpStatus >= 400;
  if (!error && !httpFailed) return null;
  const code = typeof error?.code === "number" ? error.code : undefined;
  let message = typeof error?.message === "string" && error.message.trim()
    ? error.message
    : httpFailed
      ? `Request failed (HTTP ${result.httpStatus}).`
      : "The crash event service returned an error.";
  let details = typeof error?.details === "string" ? error.details : undefined;
  if (result.httpStatus === 401) {
    message = "The access token was rejected or has expired.";
    details = [details, "Get a new token and search again. Access tokens last about one hour."].filter(Boolean).join(" ");
  }
  return { code, message, details };
}

function readTotals(summary: NonNullable<CrashPayload["summary"]>): Totals | null {
  if (
    typeof summary.total_records !== "number" ||
    typeof summary.total_pages !== "number" ||
    typeof summary.page_size !== "number"
  ) {
    return null;
  }
  return {
    totalRecords: summary.total_records,
    totalPages: summary.total_pages,
    pageSize: summary.page_size,
  };
}

function displayCount(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();
  if (typeof value === "string" && value.trim()) return value;
  return "—";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modeValue(value: string): SearchDraft["crashMode"] {
  if (value === "single" || value === "range" || value === "off") return value;
  return "off";
}

function loadHiddenColumns(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const known = new Set(CRASH_FIELDS.map((field) => field.key));
    return new Set(parsed.filter((key): key is string => typeof key === "string" && known.has(key)));
  } catch {
    return new Set();
  }
}

function persistHiddenColumns(hidden: Set<string>) {
  localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function localYmd(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${localYmd(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function widenWindow() {
  const host = window as Window & { __TAURI_INTERNALS__?: unknown };
  if (!host.__TAURI_INTERNALS__) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const factor = await win.scaleFactor();
    const width = size.width / factor;
    const height = size.height / factor;
    if (width < 1180 || height < 840) {
      await win.setSize(new LogicalSize(Math.max(width, 1180), Math.max(height, 840)));
    }
  } catch {
    // The layout still fills the current window and scrolls.
  }
}
