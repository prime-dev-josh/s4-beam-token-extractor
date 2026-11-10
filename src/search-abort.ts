export class SearchAbortedError extends Error {
  constructor() {
    super("Search cancelled.");
    this.name = "SearchAbortedError";
  }
}

export function isSearchAborted(error: unknown): boolean {
  if (error instanceof SearchAbortedError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}
