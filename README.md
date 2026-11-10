# Beam Token

Desktop app for turning a Signal4 Beam encrypted credentials file (`.asc`) into a short-lived OAuth access token, then searching crash events with that token.

The private key that matches the file must already be installed in GnuPG on this computer. Decrypted credentials and the passphrase are kept in process memory only for the session—they are not written to disk.

## What it does

1. **Select credentials file** — Pick or drag-and-drop the encrypted `.asc` file Signal4 emailed you (not your public key file).
2. **Unlock** — Enter the passphrase for your private key. The app runs GnuPG locally to decrypt the file and parses `client_id`, `client_secret`, and `expires_at` from the plaintext.
3. **Request token** — After a successful decrypt, confirm and call the Beam OAuth token endpoint with the `client_credentials` grant.
4. **Copy** — Copy the access token to the clipboard (or select it manually if the clipboard is blocked). You can request a fresh token without decrypting again until you close the app.
5. **Search crash events** — After a token is in memory, search `GET /crash-event/v1/search`. The form covers the query parameters in the Beam technical reference: `crash_date`, `s4_update_date`, and `page`.

### Crash event search

At least one of crash date or update time is required.

| Use case | What you set | Value sent |
| -------- | ------------ | ---------- |
| Crashes on one day | Crash date, single day | `YYYY-MM-DD` through today |
| Crashes across days | Crash date, date range | `YYYY-MM-DD~YYYY-MM-DD` |
| Records updated at one moment | Update time, single timestamp | `YYYY-MM-DDTHH:mm:ss` through now |
| Records updated during a window | Update time, time range | `YYYY-MM-DDTHH:mm:ss~YYYY-MM-DDTHH:mm:ss` |
| Crashes in one period that changed in another | Both filters | both parameters on one request |
| How many records match | **Get Overview Summary** | dates only; `page` is omitted |
| One block of records | **Search records**, Previous, Next, or Go | same dates plus `page` of 1 or higher |

Pages hold 500 records. The first page is 1. A page past the end returns an empty list. Using only the update time scans the full table and can be slow.

**Get Overview Summary** replaces the table with a read-only summary: `total_records`, `total_pages`, and `page_size`. **Open page 1**, or the pager, loads records again and reuses the last date filters.

The results table lists every crash-event field from the technical reference. It scrolls horizontally. **Columns** opens a checkbox list with a search box, **Check all**, and **Uncheck all**. Hidden columns are remembered in this browser profile. The table is read-only.

Service errors use the codes from the technical reference:

| Code | Message |
| ---- | ------- |
| 0 | Unknown server error |
| 1 | Missing required parameter |
| 2 | Invalid format for date range parameter |
| 3 | Character limit exceeded for parameter |
| 4 | Invalid value for date in parameter |
| 5 | Range values are inverted for date range parameter |

The error panel shows the code, message, details, and cause. An expired token is called out separately so you can request a new one.

### Backend (Rust / Tauri)

| Command | Purpose |
| -------- | -------- |
| `unlock_credentials(path, passphrase)` | Decrypt the `.asc` file via GnuPG, parse credentials, store them in app state, return a summary (file name, masked client id, expiry). |
| `request_token()` | POST to `https://beam.signal4lab.com/api/extract/oauth/token` with HTTP Basic auth using the stored client id and secret; returns `accessToken`, `tokenType`, and `expiresIn`. |
| `search_crash_events(accessToken, crashDate, s4UpdateDate, page)` | GET `https://beam.signal4lab.com/api/extract/crash-event/v1/search` with the bearer token. Omit `page` for the overview summary. |

GnuPG is resolved from `PATH`, or common Windows install paths under `Program Files\GnuPG\bin\gpg.exe`. If GnuPG is missing, the app prompts you to install [Gpg4win](https://www.gpg4win.org/).

### Frontend (TypeScript / Vite)

Single-page UI (`index.html`, `src/main.ts`, `src/search.ts`) that drives the token flow and the crash search. It uses the Tauri dialog plugin for file pickers and supports drag-and-drop when running inside the Tauri webview.

## Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| **Node.js** (LTS) and **npm** | Frontend tooling and Tauri CLI. |
| **Rust toolchain** | [rustup](https://rustup.rs/) — required for `tauri dev` and `tauri build`. |
| **Microsoft C++ Build Tools** | Typical on Windows for linking native code (Visual Studio Build Tools or equivalent). |
| **WebView2** | Usually present on Windows 10/11; Tauri uses it for the app shell. |
| **GnuPG (Gpg4win)** | Must be installed and your Signal4 private key imported before decrypt will work. |

## User workflow (typical)

1. Install and open **Beam Token**.
2. Drop or choose the latest encrypted credentials `.asc` from Signal4.
3. Enter your private-key passphrase and click **Decrypt credentials**.
4. Review the summary, then click **Get API token**.
5. Copy the token if you need it in another tool.
6. In **Search crash events**, set a crash date, an update time, or both, then click **Search records** or **Get Overview Summary**.

If decrypt fails, common causes are a wrong passphrase, a missing private key, or a file that is not an OpenPGP message. Token failures often mean outdated credentials—request a new `.asc` from Signal4 if you see authentication errors.

---

## Developer documentation

### Repository layout

```text
├── index.html          # App shell and step UI
├── src/
│   ├── main.ts         # Token flow and Tauri invoke calls
│   ├── search.ts       # Crash search form, pager, column picker, results
│   ├── crash-query.ts  # Date formats and query validation
│   ├── crash-fields.ts # Crash event columns from the technical reference
│   └── styles.css      # Styling
├── src-tauri/
│   ├── src/lib.rs      # GnuPG decrypt, token request, crash event search
│   ├── src/main.rs     # Binary entry point
│   ├── tauri.conf.json # App id, window, bundle settings
│   └── capabilities/   # Tauri permission scopes
├── dist/               # Production frontend build (created by npm run build)
└── package.json        # npm scripts
```

**Stack:** Tauri 2, Vite 8, TypeScript, Rust (`reqwest` for HTTPS).

### First-time setup

From the project root:

```powershell
npm install
```

Rust dependencies are fetched automatically the first time you run a Tauri or `cargo` command.

### Development environments

#### Full desktop app (recommended)

Runs Vite on port **1420** and launches the Tauri window with hot reload for the web UI:

```powershell
npm run tauri dev
```

`tauri.conf.json` sets `beforeDevCommand` to `npm run dev` and `devUrl` to `http://localhost:1420`. Vite is configured with `strictPort: true` on that port.

#### Frontend only (no Rust shell)

Useful for quick UI tweaks without compiling Rust. **GnuPG and token APIs will not work** in the browser alone—invoke calls require the Tauri backend.

```powershell
npm run dev
```

Then open `http://localhost:1420` in a browser (limited functionality).

#### Preview production frontend bundle

After a frontend build:

```powershell
npm run build
npm run preview
```

### Rust tests

Unit tests for credential parsing and client-id masking live in `src-tauri/src/lib.rs`:

```powershell
cd src-tauri
cargo test
```

### Building the Tauri app

Production build compiles the optimized frontend (`npm run build` → `dist/`) and then builds the release Rust binary and installers:

```powershell
npm run tauri build
```

Release profile settings in `src-tauri/Cargo.toml` enable LTO, stripping, and `panic = "abort"` for smaller binaries.

#### Where build output lives

| Artifact | Path (from repo root) |
| -------- | ------------------------ |
| Compiled frontend | `dist/` |
| Debug executable (after `tauri dev` / debug build) | `src-tauri/target/debug/beam-token.exe` |
| Release executable | `src-tauri/target/release/beam-token.exe` |
| **Windows MSI installer** | `src-tauri/target/release/bundle/msi/Beam Token_<version>_x64_en-US.msi` |
| **Windows NSIS installer** | `src-tauri/target/release/bundle/nsis/Beam Token_<version>_x64-setup.exe` |

Version and product name come from `package.json` / `tauri.conf.json` (currently `0.1.0`, product **Beam Token**). Other bundle targets may appear under `src-tauri/target/release/bundle/` if you change `bundle.targets` in `tauri.conf.json` (default is `all`).

Intermediate Rust build artifacts also accumulate under `src-tauri/target/`; only the `bundle/` installers and `release/beam-token.exe` are what you normally ship or run standalone.

### Useful npm scripts

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Vite dev server on port 1420 |
| `npm run build` | Typecheck and build frontend to `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm run tauri` | Passthrough to `@tauri-apps/cli` (e.g. `npm run tauri build`) |

### Security notes

- Passphrase input is cleared from the UI after a successful decrypt; secrets remain in memory until the process exits.
- The app does not log decrypted credentials or tokens to disk.
- Token requests require network access to `beam.signal4lab.com`.
- Only the masked client id (first/last four characters) is shown in the UI after unlock.

### Troubleshooting (development)

- **Port 1420 in use** — Stop the other process or change the port in `vite.config.ts` and `tauri.conf.json` together.
- **Rust compile errors after toolchain update** — Run `rustup update` and retry.
- **GnuPG works in a terminal but not in the app** — Ensure `gpg.exe` is on `PATH` or installed under `C:\Program Files\GnuPG\bin\`.
