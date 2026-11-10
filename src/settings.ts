import {
  clearToken,
  formatClock,
  formatRemaining,
  setPastedToken,
  subscribe,
  type SessionSnapshot,
} from "./session.ts";
import { setTheme, subscribeTheme, type Theme } from "./theme.ts";

export function initSettings() {
  const display = required<HTMLTextAreaElement>("#settings-token");
  const paste = required<HTMLTextAreaElement>("#settings-paste");
  const save = required<HTMLButtonElement>("#settings-save");
  const clear = required<HTMLButtonElement>("#settings-clear");
  const copy = required<HTMLButtonElement>("#settings-copy");
  const toggle = required<HTMLButtonElement>("#settings-toggle-token");
  const sourceEl = required<HTMLParagraphElement>("#settings-source");
  const timerEl = required<HTMLParagraphElement>("#settings-timer");
  const obtainedEl = required<HTMLElement>("#settings-obtained");
  const expiresEl = required<HTMLElement>("#settings-expires");
  const remainingEl = required<HTMLElement>("#settings-remaining");
  const noteEl = required<HTMLParagraphElement>("#settings-note");
  const themeGroup = required<HTMLDivElement>("#theme-toggle");

  subscribe(renderSession);
  subscribeTheme(renderTheme);

  save.addEventListener("click", () => {
    const value = paste.value.trim();
    if (!value) {
      paste.focus();
      return;
    }
    setPastedToken(value);
    paste.value = "";
  });
  clear.addEventListener("click", () => {
    clearToken();
    paste.value = "";
  });
  copy.addEventListener("click", () => {
    void copyValue(display.value, display);
  });
  toggle.addEventListener("click", () => {
    const showing = display.classList.toggle("revealed");
    toggle.textContent = showing ? "Hide token" : "Show token";
    toggle.setAttribute("aria-pressed", String(showing));
  });
  themeGroup.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-theme]");
    if (!button) return;
    const theme = button.dataset.theme === "dark" ? "dark" : "light";
    setTheme(theme);
  });

  function renderSession(session: SessionSnapshot) {
    display.value = session.token;
    display.placeholder = session.token ? "" : "No token in this session";
    copy.disabled = !session.token;
    clear.disabled = !session.token;
    toggle.disabled = !session.token;
    if (!session.token) {
      sourceEl.textContent = "No access token is stored in this session.";
      timerEl.textContent = "";
      obtainedEl.textContent = "—";
      expiresEl.textContent = "—";
      remainingEl.textContent = "—";
      noteEl.textContent =
        "Request a token on Get API Token, or paste a bearer token copied from another session. Tokens stay in memory only.";
      return;
    }
    if (session.source === "pasted") {
      sourceEl.textContent = "This token was pasted in Settings.";
      timerEl.textContent = "Expiration unknown";
      obtainedEl.textContent = session.obtainedAt ? formatClock(session.obtainedAt) : "—";
      expiresEl.textContent = "Unknown";
      remainingEl.textContent = "Unknown";
      noteEl.textContent =
        "A pasted token does not include an expiration time. Beam access tokens last one hour from the moment they were issued. If search starts failing, request or paste a new token.";
      return;
    }
    sourceEl.textContent = "This token was requested in the app.";
    timerEl.textContent = session.expired
      ? "Expired"
      : `${formatRemaining(session.remainingMs)} remaining`;
    obtainedEl.textContent = formatClock(session.obtainedAt);
    expiresEl.textContent = formatClock(session.expiresAt);
    remainingEl.textContent = session.expired ? "Expired" : formatRemaining(session.remainingMs);
    noteEl.textContent = session.expired
      ? "This token has reached the one-hour window from when it was requested. Get a new token before searching."
      : "The timer started when this token was requested in the app. Beam access tokens last one hour from issue.";
  }

  function renderTheme(theme: Theme) {
    for (const button of themeGroup.querySelectorAll<HTMLButtonElement>("[data-theme]")) {
      const active = button.dataset.theme === theme;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
}

export function initNavSession() {
  const el = required<HTMLParagraphElement>("#nav-session");
  subscribe((session) => {
    if (!session.token) {
      el.textContent = "No token in session";
      el.dataset.state = "empty";
      return;
    }
    if (session.source === "pasted") {
      el.textContent = "Pasted token · expiry unknown";
      el.dataset.state = "unknown";
      return;
    }
    if (session.expired) {
      el.textContent = "Token expired";
      el.dataset.state = "expired";
      return;
    }
    el.textContent = `${formatRemaining(session.remainingMs)} remaining`;
    el.dataset.state = "live";
  });
}

async function copyValue(value: string, fallback: HTMLTextAreaElement) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    fallback.focus();
    fallback.select();
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
