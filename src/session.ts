export type TokenSource = "app" | "pasted";

export type SessionSnapshot = {
  token: string;
  source: TokenSource | null;
  obtainedAt: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  expired: boolean;
};

type Listener = (snapshot: SessionSnapshot) => void;

const listeners = new Set<Listener>();

let token = "";
let source: TokenSource | null = null;
let obtainedAt: number | null = null;
let expiresAt: number | null = null;
let ticker: number | null = null;

export function getSession(): SessionSnapshot {
  return snapshot();
}

export function getToken(): string {
  return token;
}

export function hasToken(): boolean {
  return token.trim().length > 0;
}

export function setAppToken(value: string, expiresIn: number) {
  const now = Date.now();
  token = value.trim();
  source = "app";
  obtainedAt = now;
  expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + 3600 * 1000;
  startTicker();
  notify();
}

export function setPastedToken(value: string) {
  token = value.trim();
  source = token ? "pasted" : null;
  obtainedAt = token ? Date.now() : null;
  expiresAt = null;
  stopTicker();
  notify();
}

export function clearToken() {
  token = "";
  source = null;
  obtainedAt = null;
  expiresAt = null;
  stopTicker();
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function formatRemaining(ms: number | null): string {
  if (ms == null) return "Unknown";
  if (ms <= 0) return "Expired";
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

export function formatClock(timestamp: number | null): string {
  if (timestamp == null) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function snapshot(): SessionSnapshot {
  const remainingMs = expiresAt == null ? null : expiresAt - Date.now();
  return {
    token,
    source,
    obtainedAt,
    expiresAt,
    remainingMs,
    expired: remainingMs != null && remainingMs <= 0,
  };
}

function notify() {
  const current = snapshot();
  for (const listener of listeners) listener(current);
}

function startTicker() {
  stopTicker();
  ticker = window.setInterval(() => {
    notify();
    if (expiresAt != null && Date.now() >= expiresAt) stopTicker();
  }, 1000);
}

function stopTicker() {
  if (ticker == null) return;
  window.clearInterval(ticker);
  ticker = null;
}
