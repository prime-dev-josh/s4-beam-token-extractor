export type DateMode = "off" | "single" | "range";

export type SearchDraft = {
  crashMode: DateMode;
  crashDay: string;
  crashStart: string;
  crashEnd: string;
  updateMode: DateMode;
  updateAt: string;
  updateStart: string;
  updateEnd: string;
  pageFrom: string;
  pageTo: string;
};

export type SearchRequest = {
  crashDate: string | null;
  s4UpdateDate: string | null;
  pageFrom: number | null;
  pageTo: number | null;
};

export type QueryError = {
  code?: number;
  message: string;
  details?: string;
  field?: "crash_date" | "s4_update_date" | "page";
};

type ComposeResult =
  | { ok: true; value: string | null }
  | { ok: false; error: QueryError };

const CRASH_LIMIT = 21;
const UPDATE_LIMIT = 39;

export function prepareSearch(
  draft: SearchDraft,
  kind: "records" | "summary",
  now = new Date(),
): { ok: true; request: SearchRequest } | { ok: false; error: QueryError } {
  const crash = composeCrash(draft, now);
  if (!crash.ok) return crash;
  const update = composeUpdate(draft, now);
  if (!update.ok) return update;
  if (!crash.value && !update.value) {
    return {
      ok: false,
      error: {
        code: 1,
        message: "Missing required parameter",
        details: "Parameter of crash_date or s4_update_date was not provided.",
        field: "crash_date",
      },
    };
  }

  let pageFrom: number | null = null;
  let pageTo: number | null = null;
  if (kind === "records") {
    const parsed = parsePageRange(draft.pageFrom, draft.pageTo);
    if (!parsed.ok) return parsed;
    pageFrom = parsed.from;
    pageTo = parsed.to;
  }

  return {
    ok: true,
    request: {
      crashDate: crash.value,
      s4UpdateDate: update.value,
      pageFrom,
      pageTo,
    },
  };
}

export function parsePage(
  raw: string,
): { ok: true; value: number } | { ok: false; error: QueryError } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: 1 };
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      ok: false,
      error: {
        field: "page",
        message: "Page must be a whole number of 1 or higher.",
        details: "Get Overview Summary leaves page off. Page 0 is not sent.",
      },
    };
  }
  const value = Number(trimmed);
  if (value < 1) {
    return {
      ok: false,
      error: {
        field: "page",
        message: "Page starts at 1.",
        details: "Use Get Overview Summary for totals. That request leaves page off instead of sending 0.",
      },
    };
  }
  return { ok: true, value };
}

export function parsePageRange(
  fromRaw: string,
  toRaw: string,
): { ok: true; from: number; to: number } | { ok: false; error: QueryError } {
  const from = parsePage(fromRaw === "" ? "1" : fromRaw);
  if (!from.ok) return from;
  const to = parsePage(toRaw === "" ? String(from.value) : toRaw);
  if (!to.ok) return to;
  if (to.value < from.value) {
    return {
      ok: false,
      error: {
        field: "page",
        message: "Page range end must be at or after the start.",
        details: "Each Beam page holds 500 records. The range is inclusive, and Search fetches every page in it.",
      },
    };
  }
  return { ok: true, from: from.value, to: to.value };
}

export function formatSearchPath(request: SearchRequest): string {
  const parts: string[] = [];
  if (request.crashDate) parts.push(`crash_date=${request.crashDate}`);
  if (request.s4UpdateDate) parts.push(`s4_update_date=${request.s4UpdateDate}`);
  if (request.pageFrom != null && request.pageTo != null) {
    parts.push(
      request.pageFrom === request.pageTo
        ? `page=${request.pageFrom}`
        : `page=${request.pageFrom}..${request.pageTo}`,
    );
  }
  return parts.length
    ? `/crash-event/v1/search?${parts.join("&")}`
    : "/crash-event/v1/search";
}

export function filterKey(request: Pick<SearchRequest, "crashDate" | "s4UpdateDate">): string {
  return `${request.crashDate ?? ""}\n${request.s4UpdateDate ?? ""}`;
}

function composeCrash(draft: SearchDraft, now: Date): ComposeResult {
  if (draft.crashMode === "off") return { ok: true, value: null };
  if (draft.crashMode === "single") {
    return oneCrashDate(draft.crashDay, now, "Enter the crash date.");
  }
  const start = draft.crashStart.trim();
  const end = draft.crashEnd.trim();
  if (!start || !end) {
    return {
      ok: false,
      error: {
        field: "crash_date",
        message: "Enter both ends of the crash date range.",
        details: "A range is sent as YYYY-MM-DD~YYYY-MM-DD. Both days must be today or earlier.",
      },
    };
  }
  const left = checkYmd(start, now);
  if (!left.ok) return { ok: false, error: { ...left.error, field: "crash_date" } };
  const right = checkYmd(end, now);
  if (!right.ok) return { ok: false, error: { ...right.error, field: "crash_date" } };
  if (left.value > right.value) {
    return {
      ok: false,
      error: {
        code: 5,
        field: "crash_date",
        message: "Range values are inverted for date range parameter",
        details: "crash_date start is after crash_date end.",
      },
    };
  }
  return limitCrash(`${left.value}~${right.value}`);
}

function oneCrashDate(raw: string, now: Date, emptyMessage: string): ComposeResult {
  if (!raw.trim()) {
    return {
      ok: false,
      error: {
        field: "crash_date",
        message: emptyMessage,
        details: "Use YYYY-MM-DD, through today. Choose Not used if this search filters only by update time.",
      },
    };
  }
  const checked = checkYmd(raw, now);
  if (!checked.ok) return { ok: false, error: { ...checked.error, field: "crash_date" } };
  return limitCrash(checked.value);
}

function limitCrash(value: string): ComposeResult {
  if (value.length > CRASH_LIMIT) {
    return {
      ok: false,
      error: {
        code: 3,
        field: "crash_date",
        message: "Character limit exceeded for parameter",
        details: "crash_date -> parameter value exceeds 21 characters",
      },
    };
  }
  return { ok: true, value };
}

function composeUpdate(draft: SearchDraft, now: Date): ComposeResult {
  if (draft.updateMode === "off") return { ok: true, value: null };
  if (draft.updateMode === "single") {
    return oneUpdate(draft.updateAt, now, "Enter the update time.");
  }
  const start = draft.updateStart.trim();
  const end = draft.updateEnd.trim();
  if (!start || !end) {
    return {
      ok: false,
      error: {
        field: "s4_update_date",
        message: "Enter both ends of the update time range.",
        details: "A range is sent as YYYY-MM-DDTHH:mm:ss~YYYY-MM-DDTHH:mm:ss. The end must be now or earlier.",
      },
    };
  }
  const left = checkTimestamp(start, now);
  if (!left.ok) return { ok: false, error: { ...left.error, field: "s4_update_date" } };
  const right = checkTimestamp(end, now);
  if (!right.ok) return { ok: false, error: { ...right.error, field: "s4_update_date" } };
  if (left.value > right.value) {
    return {
      ok: false,
      error: {
        code: 5,
        field: "s4_update_date",
        message: "Range values are inverted for date range parameter",
        details: "s4_update_date start is after s4_update_date end.",
      },
    };
  }
  return limitUpdate(`${left.value}~${right.value}`);
}

function oneUpdate(raw: string, now: Date, emptyMessage: string): ComposeResult {
  if (!raw.trim()) {
    return {
      ok: false,
      error: {
        field: "s4_update_date",
        message: emptyMessage,
        details: "Use YYYY-MM-DDTHH:mm:ss, through now. Choose Not used if this search filters only by crash date.",
      },
    };
  }
  const checked = checkTimestamp(raw, now);
  if (!checked.ok) return checked;
  return limitUpdate(checked.value);
}

function limitUpdate(value: string): ComposeResult {
  if (value.length > UPDATE_LIMIT) {
    return {
      ok: false,
      error: {
        code: 3,
        field: "s4_update_date",
        message: "Character limit exceeded for parameter",
        details: "s4_update_date -> parameter value exceeds 39 characters",
      },
    };
  }
  return { ok: true, value };
}

function checkYmd(raw: string, now: Date): { ok: true; value: string } | { ok: false; error: QueryError } {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return {
      ok: false,
      error: {
        code: 2,
        message: "Invalid format for date range parameter",
        details: "crash_date must be YYYY-MM-DD or YYYY-MM-DD~YYYY-MM-DD.",
      },
    };
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!isRealYmd(year, month, day)) {
    return {
      ok: false,
      error: {
        code: 4,
        message: "Invalid value for date in parameter",
        details: `crash_date -> ${value} is not a real date`,
      },
    };
  }
  if (value > localYmd(now)) {
    return {
      ok: false,
      error: {
        message: "Crash date cannot be after today.",
        details: "crash_date accepts a day through today, or a range written as start~end.",
      },
    };
  }
  return { ok: true, value };
}

function checkTimestamp(
  raw: string,
  now: Date,
): { ok: true; value: string } | { ok: false; error: QueryError } {
  const normalized = normalizeTimestamp(raw);
  if (!normalized) {
    return {
      ok: false,
      error: {
        code: 2,
        message: "Invalid format for date range parameter",
        details: "s4_update_date must be YYYY-MM-DDTHH:mm:ss or a start~end range.",
      },
    };
  }
  const stamp = parseLocalTimestamp(normalized);
  if (!stamp) {
    return {
      ok: false,
      error: {
        code: 4,
        message: "Invalid value for date in parameter",
        details: `s4_update_date -> ${normalized} is not a real date or time`,
      },
    };
  }
  if (stamp.getTime() > now.getTime()) {
    return {
      ok: false,
      error: {
        message: "Update time cannot be after the current time.",
        details: "s4_update_date accepts a timestamp through now, or a range written as start~end.",
      },
    };
  }
  return { ok: true, value: normalized };
}

function normalizeTimestamp(raw: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
}

function parseLocalTimestamp(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!isRealYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date;
}

function isRealYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const max = [0, 31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
  return day <= max;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function localYmd(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
