import { isTauri } from "./is-tauri.ts";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { initExportAlert } from "./export-alert.ts";
import { initSearch } from "./search.ts";
import { go, initRouter } from "./router.ts";
import { initTheme } from "./theme.ts";
import { setAppToken, subscribe } from "./session.ts";
import { initNavSession, initSettings } from "./settings.ts";

type CredentialSummary = {
  fileName: string;
  clientIdHint: string;
  expiresAt: string;
};

type TokenInfo = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
};

initTheme();
initRouter();
initNavSession();
initSettings();
initExportAlert();

const fileNameEl = document.querySelector<HTMLParagraphElement>("#file-name")!;
const dropzone = document.querySelector<HTMLDivElement>("#dropzone")!;
const passphraseEl = document.querySelector<HTMLInputElement>("#passphrase")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const readyCard = document.querySelector<HTMLElement>("#ready-card")!;
const tokenCard = document.querySelector<HTMLElement>("#token-card")!;
const readyCopy = document.querySelector<HTMLParagraphElement>("#ready-copy")!;
const tokenMeta = document.querySelector<HTMLParagraphElement>("#token-meta")!;
const tokenEl = document.querySelector<HTMLTextAreaElement>("#token")!;
const buttons = {
  choose: document.querySelector<HTMLButtonElement>("#choose-file")!,
  decrypt: document.querySelector<HTMLButtonElement>("#decrypt")!,
  token: document.querySelector<HTMLButtonElement>("#get-token")!,
  copy: document.querySelector<HTMLButtonElement>("#copy")!,
  refresh: document.querySelector<HTMLButtonElement>("#refresh")!,
  toggle: document.querySelector<HTMLButtonElement>("#toggle-pass")!,
  search: document.querySelector<HTMLButtonElement>("#go-search")!,
};

let selectedPath: string | null = null;
let busy = false;

function setStatus(message: string, ok = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("ok", ok && message.length > 0);
}

function setBusy(next: boolean) {
  busy = next;
  for (const button of Object.values(buttons)) {
    button.disabled = next;
  }
  passphraseEl.disabled = next;
}

function selectFile(path: string) {
  selectedPath = path;
  const name = path.split(/[\\/]/).pop() ?? path;
  fileNameEl.textContent = name;
  readyCard.hidden = true;
  tokenCard.hidden = true;
  setStatus("");
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a short time";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

async function chooseFile() {
  if (busy) return;
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Choose encrypted Signal4 Beam credentials",
    filters: [
      { name: "Encrypted credentials", extensions: ["asc"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof selected === "string") {
    selectFile(selected);
  }
}

async function decrypt() {
  if (busy) return;
  if (!selectedPath) {
    setStatus("Choose the encrypted credentials file first.");
    return;
  }
  if (!passphraseEl.value) {
    setStatus("Enter your private key passphrase.");
    passphraseEl.focus();
    return;
  }

  setBusy(true);
  setStatus("");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const summary = await invoke<CredentialSummary>("unlock_credentials", {
      path: selectedPath,
      passphrase: passphraseEl.value,
    });
    passphraseEl.value = "";
    document.querySelector<HTMLElement>("#sum-file")!.textContent = summary.fileName;
    document.querySelector<HTMLElement>("#sum-id")!.textContent = summary.clientIdHint;
    document.querySelector<HTMLElement>("#sum-exp")!.textContent = summary.expiresAt;
    readyCopy.textContent =
      "Credentials are unlocked on this computer. Request a temporary API token when you are ready.";
    readyCard.hidden = false;
    tokenCard.hidden = true;
    setStatus("Decrypted. Confirm below to request a token.", true);
    readyCard.scrollIntoView({ block: "nearest" });
  } catch (error) {
    readyCard.hidden = true;
    tokenCard.hidden = true;
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function requestToken() {
  if (busy) return;
  setBusy(true);
  setStatus("");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const token = await invoke<TokenInfo>("request_token");
    tokenEl.value = token.accessToken;
    const kind = token.tokenType || "Bearer";
    tokenMeta.textContent = `${kind} token. It stays valid for ${formatDuration(token.expiresIn)} from this request. Open Search Signal4 Beam, or review the timer in Settings.`;
    tokenCard.hidden = false;
    setAppToken(token.accessToken, token.expiresIn);
    setStatus("Token ready. Open Search Signal4 Beam to query crash events.", true);
    tokenCard.scrollIntoView({ block: "nearest" });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function copyToken() {
  const value = tokenEl.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setStatus("Token copied.", true);
  } catch {
    tokenEl.focus();
    tokenEl.select();
    setStatus("Clipboard is blocked. The token is selected — press Ctrl+C.");
  }
}

buttons.choose.addEventListener("click", () => {
  void chooseFile();
});
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void chooseFile();
  }
});
buttons.decrypt.addEventListener("click", () => {
  void decrypt();
});
passphraseEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void decrypt();
  }
});
buttons.token.addEventListener("click", () => {
  void requestToken();
});
buttons.refresh.addEventListener("click", () => {
  void requestToken();
});
buttons.copy.addEventListener("click", () => {
  void copyToken();
});
buttons.search.addEventListener("click", () => {
  go("search");
});
buttons.toggle.addEventListener("click", () => {
  const showing = passphraseEl.type === "text";
  passphraseEl.type = showing ? "password" : "text";
  buttons.toggle.textContent = showing ? "Show" : "Hide";
  buttons.toggle.setAttribute("aria-pressed", String(!showing));
});

initSearch({ setStatus });

subscribe((session) => {
  if (session.source === "app" && session.token) {
    tokenEl.value = session.token;
  }
  if (!session.token) {
    tokenEl.value = "";
  }
});

if (isTauri()) {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "enter") {
      dropzone.classList.add("hot");
    }
    if (event.payload.type === "leave" || event.payload.type === "drop") {
      dropzone.classList.remove("hot");
    }
    if (event.payload.type === "drop") {
      const path =
        event.payload.paths.find((item) => item.toLowerCase().endsWith(".asc")) ??
        event.payload.paths[0];
      if (path) {
        go("token");
        selectFile(path);
      }
    }
  });
}
