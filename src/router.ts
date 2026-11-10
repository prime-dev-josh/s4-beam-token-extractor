export type Route = "home" | "token" | "search" | "settings";

const ROUTES: Record<string, Route> = {
  "": "home",
  "/": "home",
  "/token": "token",
  "/search": "search",
  "/settings": "settings",
};

const TITLES: Record<Route, string> = {
  home: "Home",
  token: "Get API Token",
  search: "Search Signal4 Beam",
  settings: "Settings",
};

type Listener = (route: Route) => void;

const listeners = new Set<Listener>();
let current: Route = "home";

export function getRoute(): Route {
  return current;
}

export function routeTitle(route: Route = current): string {
  return TITLES[route];
}

export function go(route: Route) {
  const hash = route === "home" ? "#/" : `#/${route}`;
  if (window.location.hash === hash) {
    apply(route);
    return;
  }
  window.location.hash = hash;
}

export function initRouter() {
  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();
}

export function subscribeRoute(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

function syncFromHash() {
  const path = window.location.hash.replace(/^#/, "") || "/";
  apply(ROUTES[path] ?? "home");
}

function apply(route: Route) {
  current = route;
  document.body.dataset.route = route;
  for (const view of document.querySelectorAll<HTMLElement>("[data-view]")) {
    const active = view.dataset.view === route;
    view.hidden = !active;
    view.inert = !active;
    view.setAttribute("aria-hidden", String(!active));
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-nav]")) {
    const active = link.dataset.nav === route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const title = document.querySelector("#page-title");
  if (title) title.textContent = TITLES[route];
  document.title = route === "home" ? "Beam Token" : `${TITLES[route]} · Beam Token`;
  for (const listener of listeners) listener(route);
}
