export type Theme = "light" | "dark";

const THEME_KEY = "beam-theme";

type Listener = (theme: Theme) => void;

const listeners = new Set<Listener>();

export function getTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "dark" || stored === "light" ? stored : "light";
}

export function setTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  for (const listener of listeners) listener(theme);
}

export function toggleTheme(): Theme {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function initTheme() {
  applyTheme(getTheme());
}

export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  listener(getTheme());
  return () => listeners.delete(listener);
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
