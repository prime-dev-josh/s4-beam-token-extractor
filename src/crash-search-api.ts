import type { SearchRequest } from "./crash-query.ts";
import { isTauri } from "./is-tauri.ts";
import { isSearchAborted, SearchAbortedError } from "./search-abort.ts";

export type SearchCallOptions = {
  signal?: AbortSignal;
};

export const BEAM_CRASH_SEARCH_URL =
  "https://beam.signal4lab.com/api/extract/crash-event/v1/search";

const SEARCH_PATH = "/api/extract/crash-event/v1/search";

export function buildBeamSearchUrl(request: {
  crashDate: string | null;
  s4UpdateDate: string | null;
  page?: number | null;
}): string {
  const params = new URLSearchParams();
  if (request.crashDate) params.set("crash_date", request.crashDate);
  if (request.s4UpdateDate) params.set("s4_update_date", request.s4UpdateDate);
  if (request.page != null) params.set("page", String(request.page));
  const query = params.toString();
  return query ? `${BEAM_CRASH_SEARCH_URL}?${query}` : BEAM_CRASH_SEARCH_URL;
}

/** URLs actually issued for Search records (one GET per Beam page). */
export function formatRecordsSearchUrls(
  request: Pick<SearchRequest, "crashDate" | "s4UpdateDate" | "pageFrom" | "pageTo">,
): string {
  const from = request.pageFrom ?? 1;
  const to = request.pageTo ?? from;
  const base = {
    crashDate: request.crashDate,
    s4UpdateDate: request.s4UpdateDate,
  };
  const first = `GET ${buildBeamSearchUrl({ ...base, page: from })}`;
  if (from === to) return first;
  const last = `GET ${buildBeamSearchUrl({ ...base, page: to })}`;
  const count = to - from + 1;
  return `${first}\n… ${count} requests …\n${last}`;
}

/** URL for match totals (no page parameter). */
export function formatSummarySearchUrl(
  request: Pick<SearchRequest, "crashDate" | "s4UpdateDate">,
): string {
  return `GET ${buildBeamSearchUrl({ ...request, page: null })}`;
}

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

export type CrashSearchResponse = {
  httpStatus: number;
  payload: CrashPayload;
};

export async function searchCrashEvents(
  accessToken: string,
  request: Pick<SearchRequest, "crashDate" | "s4UpdateDate" | "pageFrom">,
  options?: SearchCallOptions,
): Promise<CrashSearchResponse> {
  if (options?.signal?.aborted) throw new SearchAbortedError();
  const args: Record<string, unknown> = { accessToken: accessToken.trim() };
  if (request.crashDate) args.crashDate = request.crashDate;
  if (request.s4UpdateDate) args.s4UpdateDate = request.s4UpdateDate;
  if (request.pageFrom != null) args.page = request.pageFrom;

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<CrashSearchResponse>("search_crash_events", args);
    if (options?.signal?.aborted) throw new SearchAbortedError();
    return result;
  }

  return fetchCrashSearch(accessToken, request, options?.signal);
}

async function fetchCrashSearch(
  accessToken: string,
  request: Pick<SearchRequest, "crashDate" | "s4UpdateDate" | "pageFrom">,
  signal?: AbortSignal,
): Promise<CrashSearchResponse> {
  const params = new URLSearchParams();
  if (request.crashDate) params.set("crash_date", request.crashDate);
  if (request.s4UpdateDate) params.set("s4_update_date", request.s4UpdateDate);
  if (request.pageFrom != null) params.set("page", String(request.pageFrom));
  const query = params.toString();
  const url = query ? `${SEARCH_PATH}?${query}` : SEARCH_PATH;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    if (isSearchAborted(error)) throw new SearchAbortedError();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach the Signal4 Beam crash event service. ${detail} If you are not using npm run dev, start the desktop app with npm run tauri dev.`,
    );
  }

  const httpStatus = response.status;
  const text = await response.text();
  let payload: CrashPayload = {};
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as CrashPayload;
      } else {
        payload = {
          error: { message: "The crash event service returned an unexpected response." },
        };
      }
    } catch {
      payload = { error: { message: text } };
    }
  }

  if (!response.ok && !payload.error) {
    payload.error = {
      message:
        httpStatus === 401
          ? "The access token was rejected or has expired."
          : `Request failed (HTTP ${httpStatus}).`,
    };
  }

  return { httpStatus, payload };
}
