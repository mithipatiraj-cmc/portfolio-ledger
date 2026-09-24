# Portfolio Ledger

Local, offline desktop app for tracking investment accounts (FDs, policies,
bonds, etc.) across institutions — expiry, nominee, amount, returns, and
payment frequency. All data stays on your machine in a SQLite file; nothing
is synced to the cloud.

See the full spec and roadmap for design context. This repo currently
implements Phase 1 (core data + CRUD + Excel import).

## Requirements

- Node.js 22 or later, for running `npm test` and `npm start` in development
- No Node install is needed to *run* the packaged app — Electron ships its
  own Node runtime (v24 as of Electron 44, confirmed to include `node:sqlite`)

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

This launches the Electron app. On first run it creates an empty database
at your OS's standard per-app data folder:

- **Windows:** `%APPDATA%\portfolio-ledger\portfolio-ledger.sqlite`
- **macOS:** `~/Library/Application Support/portfolio-ledger/portfolio-ledger.sqlite`
- **Linux:** `~/.config/portfolio-ledger/portfolio-ledger.sqlite`

## Import your existing Excel sheet

Click **"Import from Excel"** in the app and pick your `.xlsx` file. Expected
columns (case-insensitive, any order): Policy No, Instrument, Date of taking
the policy, Maturity Date, Total Term, Institution, Branch, Holder, Joint
Holder, Nominee, Amount, ROI, Compounding periods per year, Mat
Amount, Expected (destination account), Proceeds directed to bank
(destination bank).

Re-running the import later is safe: unchanged rows are skipped, changed
rows update the existing policy (matched by Policy No), and new rows are
added. Rows missing a required field (Policy No, Institution, Amount,
Maturity Date) are reported back, not silently dropped.

## Email reminders before maturity (optional)

Off by default. Open **Reminders…** in the app, tick **Send email reminders**,
and fill in:

- **Send reminders to**: any address.
- **Send from (Gmail)** and a **Gmail app password**: create one at
  myaccount.google.com/apppasswords (needs 2-Step Verification on your Google
  account). It's stored encrypted with macOS Keychain or Windows DPAPI.
- **Days before maturity**, e.g. `30, 7, 1`: one email per threshold, bundled
  into a single digest when several policies are due.

Use **Send test email** to confirm the setup. Saving registers a daily
background check (macOS launchd agent / Windows Task Scheduler task) that
runs the app headless with `--check-reminders`, so reminders go out even when
the app is closed; the app also checks on launch and hourly while open. Each
reminder is sent once per policy and threshold. Turning reminders off removes
the background job. Activity is logged to `reminders.log` in the app's data
folder.

In development the background job points at this repo's Electron binary, so
it stops working if the repo moves; re-save the settings to update it.

## Package as a desktop app (clickable installer)

```bash
npm run dist:linux   # → dist/Portfolio Ledger-0.1.0.AppImage
npm run dist:mac     # → dist/Portfolio Ledger-0.1.0.dmg   (must run ON macOS)
npm run dist:win     # → dist/Portfolio Ledger Setup 0.1.0.exe   (must run ON Windows)
```

Each command must run **on the OS you're building for** — electron-builder
doesn't reliably cross-compile (a `.dmg` built on Linux won't be properly
signed for macOS Gatekeeper, and Windows builds need either Windows or Wine
installed). Run the matching command on your own machine and you'll get a
real double-clickable installer:

- **Linux:** `dist/Portfolio Ledger-0.1.0.AppImage` — mark it executable
  (`chmod +x`) and double-click, or run it directly. No installation step;
  it's a self-contained executable.
- **macOS:** `dist/Portfolio Ledger-0.1.0.dmg` — opens a standard drag-to-Applications
  installer window. Unsigned by default (no Apple Developer certificate
  configured), so macOS will initially block it — right-click the app →
  "Open" the first time to bypass Gatekeeper's warning.
- **Windows:** `dist/Portfolio Ledger Setup 0.1.0.exe` — a standard NSIS
  installer (Next → Next → Finish), adds a Start Menu entry. Unsigned by
  default, so Windows SmartScreen will show a warning the first time — "More
  info" → "Run anyway".

First run on any OS creates the database at the `userData` path listed above
and you're straight into the app — no separate setup step.

### Before distributing beyond your own machine

- Add an app icon (`build.linux.icon` / `build.mac.icon` / `build.win.icon`
  in `package.json`, pointing at `.png`/`.icns`/`.ico` files) — otherwise it
  ships with the default Electron icon, as it does right now.
- Code-signing (Apple Developer ID for macOS, an Authenticode certificate for
  Windows) removes the Gatekeeper/SmartScreen warnings above — worth doing
  if anyone besides you will run this, skippable for personal use.

## Test

```bash
npm test
```

Runs the data-layer (`src/main/db.js`) and Excel-import
(`src/import/excelImport.js`, `src/import/importRunner.js`) test suites
using Node's built-in test runner — 27 tests, no external test framework
needed. These cover everything except the Electron GUI itself (window
creation, IPC wiring, the file-picker dialog), which can only be exercised
by actually running the app.

## Known items to address

- **`xlsx` (SheetJS) dependency:** the version on npm (0.18.5) has two open
  advisories (prototype pollution, ReDoS) with no npm-published fix —
  SheetJS ships patches via their own CDN instead of npm. For a
  single-user app parsing only your own files, the practical risk is low,
  but if you want the patched build, install it directly from
  `https://cdn.sheetjs.com` per SheetJS's own instructions, in place of
  the npm package.
- **Duplicate handling on import** currently auto-resolves (skip identical /
  overwrite changed) rather than asking you per row, per spec §2 step 4 —
  a good next increment once the basic loop feels solid.
- **No app icon or code signing yet** — see "Before distributing beyond
  your own machine" above.

## Project layout

```
src/
  main/         Electron main process: window creation, IPC handlers, SQLite (db.js)
  import/       Excel parsing (excelImport.js) and import-commit logic (importRunner.js)
                — both plain Node modules, independent of Electron, fully unit tested
  renderer/     UI: index.html, renderer.js, styles.css
test/           Node test-runner suites for db.js, excelImport.js, importRunner.js
```
