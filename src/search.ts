import { CRASH_FIELDS } from "./crash-fields.ts";
import {
  formatRecordsSearchUrls,
  formatSummarySearchUrl,
  searchCrashEvents,
  type CrashSearchResponse,
} from "./crash-search-api.ts";
import {
  filterKey,
  formatSearchPath,
  parsePage,
  prepareSearch,
  type QueryError,
  type SearchDraft,
  type SearchRequest,
} from "./crash-query.ts";
import {
  bindPageRange,
  clampPageRange,
  syncPageRangeUi,
} from "./page-range-slider.ts";
import { formatRemaining, getToken, hasToken, subscribe } from "./session.ts";
import { go, subscribeRoute } from "./router.ts";
import { showExportAlert } from "./export-alert.ts";
import { isSearchAborted } from "./search-abort.ts";
import { hideSearchLoading, showSearchLoading, updateSearchLoading } from "./search-loading.ts";
import {
  csvFromSnapshot,
  downloadBlob,
  exportFilename,
  resolveDownloadLocation,
  formatCell,
  pdfFromSnapshot,
  snapshotRecords,
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

type SearchMode = "idle" | "table";
type Totals = { totalRecords: number; totalPages: number; pageSize: number };
type ActiveQuery = { crashDate: string | null; s4UpdateDate: string | null };
type SearchTab = "form" | "table";

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
  const pageFromInput = required<HTMLInputElement>("#page-from");
  const pageToInput = required<HTMLInputElement>("#page-to");
  const pageRangeFill = required<HTMLElement>("#page-range-fill");
  const pageFromOut = required<HTMLOutputElement>("#page-from-out");
  const pageToOut = required<HTMLOutputElement>("#page-to-out");
  const pageRangeField = required<HTMLFieldSetElement>("#page-range-field");
  const overviewStatus = required<HTMLParagraphElement>("#overview-status");
  const overviewUrl = required<HTMLParagraphElement>("#overview-url");
  const overviewStats = required<HTMLElement>("#overview-stats");
  const overviewRecords = required<HTMLElement>("#overview-records");
  const overviewPages = required<HTMLElement>("#overview-pages");
  const overviewSize = required<HTMLElement>("#overview-size");
  const fetchScope = required<HTMLParagraphElement>("#fetch-scope");
  const pageMeta = required<HTMLParagraphElement>("#page-meta");
  const tableMeta = required<HTMLParagraphElement>("#table-meta");
  const viewPageInput = required<HTMLInputElement>("#view-page");
  const viewSizeInput = required<HTMLSelectElement>("#view-size");
  const viewPrev = required<HTMLButtonElement>("#view-prev");
  const viewNext = required<HTMLButtonElement>("#view-next");
  const toggleColumns = required<HTMLButtonElement>("#toggle-columns");
  const columnsClose = required<HTMLButtonElement>("#columns-close");
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
  const tabForm = required<HTMLButtonElement>("#tab-form");
  const tabTable = required<HTMLButtonElement>("#tab-table");
  const panelForm = required<HTMLElement>("#panel-form");
  const panelTable = required<HTMLElement>("#panel-table");
  const searchHelp = required<HTMLButtonElement>("#search-help");
  const searchHelpPanel = required<HTMLElement>("#search-help-panel");
  const filterPop = required<HTMLDivElement>("#column-filter-pop");
  const filterPopName = required<HTMLElement>("#filter-pop-name");
  const filterPopInput = required<HTMLInputElement>("#filter-pop-input");
  const filterPopClear = required<HTMLButtonElement>("#filter-pop-clear");

  const hidden = loadHiddenColumns();
  const columnFilters = new Map<string, string>();
  let tokenReady = false;
  let busy = false;
  let mode: SearchMode = "idle";
  let active: ActiveQuery | null = null;
  let totals: Totals | null = null;
  let overviewKey: string | null = null;
  let rangeAutoKey: string | null = null;
  let items: Record<string, unknown>[] = [];
  let fetchedFrom: number | null = null;
  let fetchedTo: number | null = null;
  let viewPage = 1;
  let viewPageSize = 50;
  let openFilterKey: string | null = null;
  let summaryGen = 0;
  let overviewTimerId = 0;
  let overviewAbort: AbortController | null = null;
  let recordSearchId = 0;
  let recordSearchAbort: AbortController | null = null;
  const OVERVIEW_DEBOUNCE_MS = 750;

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
    const ready = hasToken();
    const readinessChanged = ready !== tokenReady;
    tokenReady = ready;
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
    if (readinessChanged) scheduleOverview();
  });

  renderColumnList();
  renderFieldNotes();
  syncModes();
  renderOverview("idle");
  refreshChrome();
  renderResults();
  showTab("form");

  for (const input of [crashDay, crashStart, crashEnd, updateAt, updateStart, updateEnd]) {
    input.addEventListener("input", () => {
      clearFieldState();
      refreshChrome();
    });
  }
  bindPageRange(pageFromInput, pageToInput, pageRangeFill, pageFromOut, pageToOut, () => {
    clearFieldState();
    refreshChrome();
  });
  for (const input of [crashDay, crashStart, crashEnd, updateAt, updateStart, updateEnd]) {
    input.addEventListener("change", () => {
      invalidateOverviewIfDraftDrifted();
      scheduleOverview();
      refreshChrome();
    });
  }
  crashMode.addEventListener("change", () => {
    syncModes();
    invalidateOverviewIfDraftDrifted();
    scheduleOverview();
    refreshChrome();
  });
  updateMode.addEventListener("change", () => {
    syncModes();
    invalidateOverviewIfDraftDrifted();
    scheduleOverview();
    refreshChrome();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void executeForm();
  });
  tabForm.addEventListener("click", () => showTab("form"));
  tabTable.addEventListener("click", () => showTab("table"));
  searchHelp.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = searchHelpPanel.hidden;
    searchHelpPanel.hidden = !open;
    searchHelp.setAttribute("aria-expanded", String(open));
  });
  viewPrev.addEventListener("click", () => {
    viewPage = Math.max(1, viewPage - 1);
    renderResults();
  });
  viewNext.addEventListener("click", () => {
    viewPage += 1;
    renderResults();
  });
  viewPageInput.addEventListener("change", () => {
    const parsed = parsePage(viewPageInput.value);
    viewPage = parsed.ok ? parsed.value : 1;
    renderResults();
  });
  viewSizeInput.addEventListener("change", () => {
    const next = Number(viewSizeInput.value);
    viewPageSize = Number.isFinite(next) && next > 0 ? next : 50;
    viewPage = 1;
    renderResults();
  });
  toggleColumns.addEventListener("click", () => {
    setColumnPanel(columnPanel.hasAttribute("hidden"));
  });
  columnsClose.addEventListener("click", () => setColumnPanel(false));
  columnSearch.addEventListener("input", applyColumnPickerFilter);
  columnsAll.addEventListener("click", () => setAllColumns(true));
  columnsNone.addEventListener("click", () => setAllColumns(false));
  exportCsv.addEventListener("click", () => {
    void exportFetched("csv");
  });
  exportPdf.addEventListener("click", () => {
    void exportFetched("pdf");
  });
  filterPopInput.addEventListener("input", () => {
    if (!openFilterKey) return;
    const value = filterPopInput.value;
    if (value.trim()) columnFilters.set(openFilterKey, value);
    else columnFilters.delete(openFilterKey);
    viewPage = 1;
    renderResults();
    positionFilterPop();
  });
  filterPopClear.addEventListener("click", () => {
    if (!openFilterKey) return;
    columnFilters.delete(openFilterKey);
    filterPopInput.value = "";
    viewPage = 1;
    renderResults();
    positionFilterPop();
    filterPopInput.focus();
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!searchHelpPanel.hidden && !searchHelpPanel.contains(target) && !searchHelp.contains(target)) {
      searchHelpPanel.hidden = true;
      searchHelp.setAttribute("aria-expanded", "false");
    }
    if (!filterPop.hidden && !filterPop.contains(target) && !(target instanceof Element && target.closest(".col-filter"))) {
      closeFilterPop();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchHelpPanel.hidden = true;
      searchHelp.setAttribute("aria-expanded", "false");
      closeFilterPop();
    }
  });
  window.addEventListener("resize", () => {
    if (!filterPop.hidden) positionFilterPop();
  });

  function showTab(next: SearchTab) {
    const formActive = next === "form";
    tabForm.setAttribute("aria-selected", String(formActive));
    tabTable.setAttribute("aria-selected", String(!formActive));
    tabForm.classList.toggle("active", formActive);
    tabTable.classList.toggle("active", !formActive);
    panelForm.hidden = !formActive;
    panelTable.hidden = formActive;
    document.body.dataset.searchTab = next;
    closeFilterPop();
  }

  function setColumnPanel(open: boolean) {
    columnPanel.hidden = !open;
    toggleColumns.setAttribute("aria-expanded", String(open));
    if (open) columnSearch.focus();
  }

  function setSearchEnabled(enabled: boolean) {
    searchRecords.disabled = !enabled || busy;
    updateExport();
    updateLocalPager();
  }

  async function executeForm() {
    if (busy) return;
    stampDateLimits();
    const prepared = prepareSearch(readDraft(), "records");
    if (!prepared.ok) {
      showError(prepared.error, "local");
      showTab("form");
      return;
    }
    if (!ensureToken()) return;
    searchHelpPanel.hidden = true;
    searchHelp.setAttribute("aria-expanded", "false");
    closeFilterPop();
    setColumnPanel(false);
    const ok = await runRange(prepared.request);
    if (ok) {
      showTab("table");
      tabTable.focus();
    }
  }

  function scheduleOverview() {
    window.clearTimeout(overviewTimerId);
    overviewAbort?.abort();
    overviewAbort = null;
    const gen = ++summaryGen;
    overviewTimerId = window.setTimeout(() => {
      overviewTimerId = 0;
      void loadOverview(gen);
    }, OVERVIEW_DEBOUNCE_MS);
  }

  function cancelRecordSearch() {
    recordSearchId += 1;
    recordSearchAbort?.abort();
    recordSearchAbort = null;
  }

  async function loadOverview(gen: number) {
    if (gen !== summaryGen) return;
    stampDateLimits();
    const prepared = prepareSearch(readDraft(), "summary");
    if (!prepared.ok) {
      if (prepared.error.field !== "page") {
        totals = null;
        overviewKey = null;
        renderOverview("idle");
        refreshChrome();
      }
      return;
    }
    if (!tokenReady) {
      renderOverview("need-token");
      return;
    }
    const key = filterKey(prepared.request);
    if (key === overviewKey && totals) {
      renderOverview("ready");
      refreshChrome();
      return;
    }
    renderOverview("loading");
    overviewAbort?.abort();
    const abort = new AbortController();
    overviewAbort = abort;
    try {
      const result = await invokeSearch(
        { ...prepared.request, pageFrom: null, pageTo: null },
        abort.signal,
      );
      if (gen !== summaryGen || abort.signal.aborted) return;
      const failure = readFailure(result);
      if (failure) {
        totals = null;
        overviewKey = null;
        renderOverview("error", failure.message);
        return;
      }
      const summary = result.payload.summary;
      if (!summary) {
        totals = null;
        overviewKey = null;
        renderOverview("error", "The Signal4 Beam crash event service did not return totals.");
        return;
      }
      rememberSummary(summary);
      overviewKey = key;
      if (rangeAutoKey !== key && totals) {
        pageFromInput.value = "1";
        pageToInput.value = String(Math.max(1, totals.totalPages));
        rangeAutoKey = key;
      }
      applyPageRangeBounds();
      renderOverview("ready");
      refreshChrome();
    } catch (error) {
      if (gen !== summaryGen || isSearchAborted(error)) return;
      totals = null;
      overviewKey = null;
      renderOverview("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (overviewAbort === abort) overviewAbort = null;
    }
  }

  function renderOverview(state: "idle" | "need-token" | "loading" | "ready" | "error", message = "") {
    overviewStats.hidden = state !== "ready";
    if (state === "idle") {
      overviewStatus.textContent = "Add a crash date, an update time, or both to load match totals.";
    } else if (state === "need-token") {
      overviewStatus.textContent = "Get an API token to load match totals for this filter.";
    } else if (state === "loading") {
      overviewStatus.textContent = "Loading match totals…";
    } else if (state === "error") {
      overviewStatus.textContent = message || "Could not load match totals.";
    } else {
      overviewStatus.textContent =
        "Match totals loaded. The To page handle is set to the last Signal4 Beam page.";
      overviewRecords.textContent = totals ? totals.totalRecords.toLocaleString() : "—";
      overviewPages.textContent = totals ? totals.totalPages.toLocaleString() : "—";
      overviewSize.textContent = totals ? totals.pageSize.toLocaleString() : "—";
    }
    syncOverviewUrl();
    syncPageRangeAccess();
  }

  function syncOverviewUrl() {
    stampDateLimits();
    const prepared = prepareSearch(readDraft(), "summary");
    if (!prepared.ok) {
      overviewUrl.hidden = true;
      overviewUrl.textContent = "";
      return;
    }
    overviewUrl.hidden = false;
    overviewUrl.textContent = formatSummarySearchUrl(prepared.request);
  }

  function pageRangeReady(): boolean {
    stampDateLimits();
    const prepared = prepareSearch(readDraft(), "summary");
    if (!prepared.ok || !totals) return false;
    return overviewKey === filterKey(prepared.request);
  }

  function syncPageRangeAccess() {
    const unlocked = pageRangeReady();
    pageRangeField.hidden = !unlocked;
    pageRangeField.disabled = !unlocked;
    pageFromInput.disabled = !unlocked || busy;
    pageToInput.disabled = !unlocked || busy;
  }

  function invalidateOverviewIfDraftDrifted() {
    const prepared = prepareSearch(readDraft(), "summary");
    if (!prepared.ok) {
      totals = null;
      overviewKey = null;
      rangeAutoKey = null;
      renderOverview("idle");
      return;
    }
    const key = filterKey(prepared.request);
    if (overviewKey === key && totals) return;
    totals = null;
    overviewKey = null;
    rangeAutoKey = null;
    if (!tokenReady) {
      renderOverview("need-token");
      return;
    }
    renderOverview("loading");
  }

  async function runRange(request: SearchRequest): Promise<boolean> {
    const from = request.pageFrom ?? 1;
    const to = request.pageTo ?? from;
    busy = true;
    setSearchEnabled(tokenReady);
    clearError();
    const slow = !request.crashDate && !!request.s4UpdateDate;
    const collected: Record<string, unknown>[] = [];
    const statusFor = (page: number) =>
      slow
        ? `Fetching Signal4 Beam page ${page} of ${to}. A search that uses only the update time can take a while.`
        : `Fetching Signal4 Beam page ${page} of ${to}.`;
    cancelRecordSearch();
    const searchId = recordSearchId;
    const abort = new AbortController();
    recordSearchAbort = abort;
    showSearchLoading(statusFor(from), () => {
      if (searchId === recordSearchId) cancelRecordSearch();
    });
    try {
      for (let page = from; page <= to; page += 1) {
        if (searchId !== recordSearchId || abort.signal.aborted) {
          options.setStatus("Search cancelled. Adjust the query and try again.", true);
          showTab("form");
          return false;
        }
        const status = statusFor(page);
        options.setStatus(status);
        updateSearchLoading(status);
        const result = await invokeSearch(
          { ...request, pageFrom: page, pageTo: page },
          abort.signal,
        );
        const failure = readFailure(result);
        if (failure) {
          showError(failure, result.httpStatus === 0 ? "local" : "api");
          options.setStatus(failure.message);
          return false;
        }
        if (!Array.isArray(result.payload.items)) {
          showError(
            {
              message: "The Signal4 Beam crash event service returned an unexpected response.",
              details: "A page of records arrives as items.",
            },
            "api",
          );
          options.setStatus("Unexpected response from the Signal4 Beam crash event service.");
          return false;
        }
        collected.push(...result.payload.items.filter(isRecord));
      }
      active = { crashDate: request.crashDate, s4UpdateDate: request.s4UpdateDate };
      items = collected;
      fetchedFrom = from;
      fetchedTo = to;
      mode = "table";
      viewPage = 1;
      clearError();
      refreshChrome();
      renderResults();
      options.setStatus(
        items.length === 0
          ? "The Signal4 Beam crash event service returned no records for this page range."
          : `Loaded ${items.length.toLocaleString()} crash events from Signal4 Beam pages ${from}–${to}.`,
        true,
      );
      return true;
    } catch (error) {
      if (isSearchAborted(error) || searchId !== recordSearchId) {
        options.setStatus("Search cancelled. Adjust the query and try again.", true);
        showTab("form");
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      const local =
        /invoke/i.test(message) ||
        /desktop app/i.test(message) ||
        /tauri dev/i.test(message);
      showError(
        {
          message: local
            ? "Search is not available in this browser view."
            : "Could not reach the Signal4 Beam crash event service.",
          details: local
            ? "Run npm run tauri dev or the installed Beam Token app. With npm run dev, a pasted token can search through the Vite proxy."
            : message,
        },
        local ? "local" : "api",
      );
      options.setStatus(message);
      return false;
    } finally {
      if (searchId === recordSearchId) {
        recordSearchAbort = null;
      }
      hideSearchLoading();
      busy = false;
      setSearchEnabled(tokenReady);
    }
  }

  async function invokeSearch(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<CrashSearchResponse> {
    return searchCrashEvents(getToken(), request, { signal });
  }

  function rememberSummary(summary: NonNullable<CrashPayload["summary"]>) {
    totals = readTotals(summary);
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
    showTab("form");
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
      pageFrom: pageFromInput.value,
      pageTo: pageToInput.value,
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

  function applyPageRangeBounds() {
    const maxPages = totals && totals.totalPages > 0 ? totals.totalPages : null;
    clampPageRange(pageFromInput, pageToInput, maxPages);
    syncPageRangeUi(pageFromInput, pageToInput, pageRangeFill, pageFromOut, pageToOut);
  }

  function refreshChrome() {
    stampDateLimits();
    syncModes();
    syncOverviewUrl();
    syncPageRangeAccess();
    if (pageRangeReady()) {
      applyPageRangeBounds();
    }
    const prepared = prepareSearch(readDraft(), "records");
    if (!prepared.ok) {
      preview.textContent =
        "Add a crash date, an update time, or both. At least one is required to preview request URLs.";
    } else if (pageRangeReady()) {
      preview.textContent = formatRecordsSearchUrls(prepared.request);
    } else {
      preview.textContent = formatSummarySearchUrl(prepared.request);
    }
    if (active) {
      const path = formatSearchPath({ ...active, pageFrom: fetchedFrom, pageTo: fetchedTo });
      const draftKey = currentFilterKey();
      const drifted = draftKey != null && draftKey !== filterKey(active);
      activeQuery.textContent = drifted
        ? `The table still holds ${path}. The form has unsent date changes.`
        : `The table holds ${path}.`;
    } else {
      activeQuery.textContent = "No records have been fetched yet.";
    }
    updateFetchScope(prepared.ok ? prepared.request : null);
    updateColumnCount();
    updateLocalPager();
    updateExport();
  }

  function updateFetchScope(request: SearchRequest | null) {
    fetchScope.hidden = true;
    fetchScope.className = "warn";
    if (!pageRangeReady() || !request || request.pageFrom == null || request.pageTo == null) return;
    const pages = request.pageTo - request.pageFrom + 1;
    const cap = pages * (totals?.pageSize ?? 500);
    const coversAll =
      totals != null &&
      totals.totalPages > 0 &&
      request.pageFrom === 1 &&
      request.pageTo >= totals.totalPages;
    if (coversAll && totals) {
      fetchScope.hidden = false;
      fetchScope.className = "warn fetch-all";
      fetchScope.textContent = `This search will fetch all ${totals.totalPages.toLocaleString()} Signal4 Beam pages, up to ${totals.totalRecords.toLocaleString()} records.`;
      return;
    }
    fetchScope.hidden = false;
    fetchScope.textContent = `This search will fetch Signal4 Beam pages ${request.pageFrom}–${request.pageTo} (${pages.toLocaleString()} pages, up to ${cap.toLocaleString()} records).`;
  }

  function visibleFields() {
    return CRASH_FIELDS.filter((field) => !hidden.has(field.key));
  }

  function filteredItems(): Record<string, unknown>[] {
    const fields = visibleFields();
    return items.filter((item) =>
      fields.every((field) => {
        const query = columnFilters.get(field.key)?.trim().toLowerCase();
        if (!query) return true;
        return formatCell(item[field.key]).toLowerCase().includes(query);
      }),
    );
  }

  function renderResults() {
    const filtered = filteredItems();
    const fields = visibleFields();
    const pages = Math.max(1, Math.ceil(filtered.length / viewPageSize) || 1);
    if (viewPage > pages) viewPage = pages;
    if (viewPage < 1) viewPage = 1;
    viewPageInput.value = String(viewPage);
    const start = (viewPage - 1) * viewPageSize;
    const pageRows = filtered.slice(start, start + viewPageSize);
    resultsRegion.replaceChildren();
    try {
      if (mode !== "table") {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent = "Run Search records to load crash events into this table.";
        resultsRegion.append(empty);
        tableMeta.textContent = "No fetched records yet.";
        return;
      }
      if (items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent = "No crash events matched these filters.";
        resultsRegion.append(empty);
        tableMeta.textContent = "0 fetched records.";
        return;
      }
      if (fields.length === 0) {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent = "Every column is hidden. Check at least one column to see this page.";
        resultsRegion.append(empty);
        tableMeta.textContent = `${items.length.toLocaleString()} fetched records.`;
        return;
      }
      if (filtered.length === 0) {
        const empty = document.createElement("p");
        empty.className = "results-empty";
        empty.textContent = "No rows match the column filters. Clear a filter from a column header to bring rows back.";
        resultsRegion.append(empty);
      } else {
        const scroller = document.createElement("div");
        scroller.className = "table-scroll";
        scroller.tabIndex = 0;
        scroller.setAttribute("aria-label", "Crash event results");
        scroller.append(renderTable(fields, pageRows, columnFilters, (key, button) => {
          openFilter(key, button);
        }));
        resultsRegion.append(scroller);
      }
      const end = Math.min(filtered.length, start + pageRows.length);
      const filterNote = filtered.length === items.length
        ? ""
        : ` Filtered to ${filtered.length.toLocaleString()}.`;
      tableMeta.textContent = `${items.length.toLocaleString()} fetched records.${filterNote} Showing ${
        pageRows.length === 0 ? 0 : start + 1
      }–${end} on local page ${viewPage} of ${pages}.`;
    } finally {
      updateLocalPager();
      updateExport();
    }
  }

  function updateLocalPager() {
    const filtered = mode === "table" ? filteredItems() : [];
    const pages = Math.max(1, Math.ceil(filtered.length / viewPageSize) || 1);
    const canPage = mode === "table" && filtered.length > 0 && !busy;
    viewPrev.disabled = !canPage || viewPage <= 1;
    viewNext.disabled = !canPage || viewPage >= pages;
    viewPageInput.disabled = !canPage;
    viewSizeInput.disabled = mode !== "table" || busy;
    pageMeta.textContent =
      mode === "table"
        ? "Local paging and column filters only change what you see. CSV and PDF export every fetched record in the columns currently shown."
        : "Search from the Search tab to fetch records. This pager stays local after that.";
  }

  function updateExport() {
    const ready = mode === "table" && items.length > 0 && visibleFields().length > 0 && !busy;
    exportCsv.disabled = !ready;
    exportPdf.disabled = !ready;
  }

  async function exportFetched(kind: "csv" | "pdf") {
    const fields = visibleFields();
    if (items.length === 0) {
      options.setStatus("Load crash events before exporting.");
      return;
    }
    if (fields.length === 0) {
      options.setStatus("Check at least one column before exporting.");
      return;
    }
    const snapshot = snapshotRecords(fields, items);
    const filename = exportFilename(kind, fetchedFrom);
    const query = active
      ? formatSearchPath({ ...active, pageFrom: fetchedFrom, pageTo: fetchedTo })
      : "";
    const subtitle = [
      query,
      `${snapshot.headers.length} columns shown`,
      `${snapshot.rows.length.toLocaleString()} fetched records`,
    ]
      .filter(Boolean)
      .join(" · ");
    exportCsv.disabled = true;
    exportPdf.disabled = true;
    try {
      const rowCount = snapshot.rows.length;
      const columnCount = snapshot.headers.length;
      if (kind === "csv") {
        downloadBlob(
          filename,
          new Blob([csvFromSnapshot(snapshot)], { type: "text/csv;charset=utf-8" }),
        );
        options.setStatus(
          `CSV saved with ${columnCount} columns and ${rowCount.toLocaleString()} fetched rows.`,
          true,
        );
      } else {
        options.setStatus("Building PDF.");
        const blob = await pdfFromSnapshot(snapshot, {
          title: "Signal4 Beam crash events",
          subtitle,
        });
        downloadBlob(filename, blob);
        options.setStatus(
          `PDF saved with ${columnCount} columns and ${rowCount.toLocaleString()} fetched rows.`,
          true,
        );
      }
      const location = await resolveDownloadLocation(filename);
      showExportAlert({ kind, filename, location, rowCount, columnCount });
    } catch (error) {
      options.setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      updateExport();
    }
  }

  function renderColumnList() {
    columnList.replaceChildren(
      columnGroup("Crash report", CRASH_FIELDS.filter((field) => !field.key.startsWith("s4_"))),
      columnGroup("Signal4 Beam derived", CRASH_FIELDS.filter((field) => field.key.startsWith("s4_"))),
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
        else updateExport();
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

  function applyColumnPickerFilter() {
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
    else updateExport();
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

  function openFilter(key: string, button: HTMLElement) {
    openFilterKey = key;
    const field = CRASH_FIELDS.find((item) => item.key === key);
    filterPopName.textContent = field?.label ?? key;
    filterPopInput.value = columnFilters.get(key) ?? "";
    filterPop.hidden = false;
    filterPop.dataset.anchor = key;
    positionFilterPop(button);
    filterPopInput.focus();
    filterPopInput.select();
  }

  function positionFilterPop(button?: HTMLElement) {
    const anchor =
      button ??
      resultsRegion.querySelector<HTMLElement>(`.col-filter[data-key="${openFilterKey ?? ""}"]`);
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const pop = filterPop.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.right - pop.width), window.innerWidth - pop.width - 8);
    const top = Math.min(box.bottom + 6, window.innerHeight - pop.height - 8);
    filterPop.style.left = `${Math.max(8, left)}px`;
    filterPop.style.top = `${Math.max(8, top)}px`;
  }

  function closeFilterPop() {
    openFilterKey = null;
    filterPop.hidden = true;
  }

  function showError(error: QueryError, source: "local" | "api") {
    crashField.classList.toggle("invalid", error.field === "crash_date");
    updateField.classList.toggle("invalid", error.field === "s4_update_date");
    pageRangeField.classList.toggle("invalid", error.field === "page");
    errorCode.textContent = error.code == null ? "" : `Code ${error.code}`;
    errorMessage.textContent = error.message;
    errorDetails.textContent = error.details ?? "";
    errorCause.textContent = error.code != null && ERROR_CAUSES[error.code] ? `Cause: ${ERROR_CAUSES[error.code]}` : "";
    errorSource.textContent = source === "local"
      ? "Checked before the request was sent."
      : "Returned by the Signal4 Beam crash event service.";
    errorBox.hidden = false;
    showTab("form");
    errorBox.scrollIntoView({ block: "nearest" });
  }

  function clearError() {
    errorBox.hidden = true;
    clearFieldState();
  }

  function clearFieldState() {
    crashField.classList.remove("invalid");
    updateField.classList.remove("invalid");
    pageRangeField.classList.remove("invalid");
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

function renderTable(
  fields: typeof CRASH_FIELDS,
  rows: Record<string, unknown>[],
  filters: Map<string, string>,
  onFilter: (key: string, button: HTMLElement) => void,
): HTMLTableElement {
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
    const wrap = document.createElement("div");
    wrap.className = "th-wrap";
    const label = document.createElement("span");
    label.textContent = field.label;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "col-filter";
    button.dataset.key = field.key;
    button.setAttribute("aria-label", `Filter ${field.label}`);
    button.textContent = "Filter";
    if (filters.get(field.key)?.trim()) button.classList.add("active");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onFilter(field.key, button);
    });
    wrap.append(label, button);
    cell.append(wrap);
    const title = [`${field.label} (${field.key})`, field.format, field.note].filter(Boolean).join(". ");
    cell.title = title;
    headRow.append(cell);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const item of rows) {
    const row = document.createElement("tr");
    for (const field of fields) {
      const cell = document.createElement("td");
      cell.textContent = formatCell(item[field.key]);
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  return table;
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
      : "The Signal4 Beam crash event service returned an error.";
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
  const { isTauri } = await import("./is-tauri.ts");
  if (!isTauri()) return;
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
