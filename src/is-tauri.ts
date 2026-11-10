export function isTauri(): boolean {
  const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return host.__TAURI_INTERNALS__ != null || host.__TAURI__ != null;
}
