# Portfolio Ledger

Local, offline desktop app for tracking investment accounts (FDs, policies,
bonds, etc.) across institutions — expiry, nominee, amount, returns, and
payment frequency — plus a tax projection on the interest and a tracker for
recurring bills and their payment history. All data stays on your machine in
a SQLite file; nothing is synced to the cloud.

The app has three tabs: **Portfolio** (your investments), **Tax projection**
and **Bills**.

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

## Tax projection

The **Tax projection** tab estimates the tax on your interest for an Indian
financial year (April–March). Each policy is taxed to its holder, joint
policies included. Enter each holder's other income and tax rate (include
cess, e.g. 31.2 for the 30% slab); if their total income is within the
section 87A limit (₹12 lakh by default, editable) the tax is nil. Tick
**Tax-exempt** on a policy (e.g. PPF) to leave its interest untaxed.

## Bills

The **Bills** tab tracks recurring bills and expenses (rent, electricity,
insurance, …) and every payment you make on them.

- **Add bill**: a name, how often it's due (monthly, every 2 months,
  quarterly, every 6 months or yearly), the next due date, how it's paid
  (**direct bank payment**, **check deposit** or **credit card**) and, optionally, the usual
  amount. Leave the amount blank for bills that vary from one period to the
  next (phone, electricity); they show as **Varies**. Bank / card details are
  required for a check deposit (the account it's deposited into) and optional
  for a bank payment or credit card (e.g. which card).
- **Record payment** saves a new entry in the payment history with the date,
  the amount actually paid, method, bank details and an optional note (e.g. a
  cheque number). The amount starts from the bill's usual amount, or for a
  bill that varies, the last payment; change it to what you paid this time. It
  also moves the bill's due date on by its frequency. Untick that for a one-off
  payment. A bill due on the 31st falls on the last day of shorter months and
  returns to the 31st after.
- **Last payment** on each bill is its most recent entry in the history, so it
  always matches it. Payments are never overwritten; each keeps the method and
  bank used at the time, even if the bill changes later.
- **Payment history** lists every payment, newest first; pick a bill (or use
  its **History** button) to look up just its payments. A payment entered by
  mistake can be deleted.
- **Archive** hides a bill you no longer pay but keeps its history; turn on
  **Show archived** to see or restore it.
- The tiles show the average paid out of the bank per month (a ₹12,000 yearly
  bill counts as ₹1,000; a bill that varies counts at its last payment), what's
  overdue or due in the next 7 days, and what you paid from the bank this
  month. Both money figures count only direct bank payments and check
  deposits: credit card amounts are left out (and shown separately) because the
  card's own bill, paid from the bank, already covers them. Add the card itself
  as a bill paid by bank payment. The monthly average goes by each bill's usual
  method; paid this month goes by the method recorded on each payment, so a
  one-off card payment on a bank-paid bill is left out, and vice versa.

## Email reminders before maturity and bill due dates (optional)

Off by default. Open **Reminders…** in the app, tick **Send email reminders**,
and fill in:

- **Send reminders to**: any address.
- **Send from (Gmail)** and a **Gmail app password**: create one at
  myaccount.google.com/apppasswords (needs 2-Step Verification on your Google
  account). It's stored encrypted with macOS Keychain or Windows DPAPI.
- **Days before maturity**, e.g. `30, 7, 1`: one email per threshold, bundled
  into a single digest when several policies are due.
- **Also remind me when bills are due** (optional) with **Days before a bill
  is due**, e.g. `3, 1` (or `0` for the due date itself). Bills due soon go
  into the same digest, in their own table: amount, due date, how it's paid
  and the bank details. Each reminder is sent once per due date. Recording a
  payment moves the due date on, so a paid bill isn't reminded again until its
  next due date, and a bill paid before its reminder doesn't get one.

Use **Send test email** to confirm the setup. Saving registers a daily
background check (macOS launchd agent / Windows Task Scheduler task) that
runs the app headless with `--check-reminders`, so reminders go out even when
the app is closed; the app also checks on launch and hourly while open. Each
reminder is sent once per policy (or bill due date) and threshold. Turning reminders off removes
the background job. Activity is logged to `reminders.log` in the app's data
folder.

In development the background job points at this repo's Electron binary, so
it stops working if the repo moves; re-save the settings to update it.

## Package as a desktop app (clickable installer)

```bash
npm run dist:linux   # → dist/Portfolio Ledger-0.1.0.AppImage
npm run dist:mac     # → dist/Portfolio Ledger-0.1.0-universal.dmg   (must run ON macOS)
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
- **macOS:** `dist/Portfolio Ledger-0.1.0-universal.dmg` — one file that
  runs on both Apple Silicon and Intel Macs. It opens a standard
  drag-to-Applications window. It's ad-hoc signed (no Apple Developer
  account), so other Macs need a one-time step before it opens — see
  [Installing on another Mac](#installing-on-another-mac) below.
- **Windows:** `dist/Portfolio Ledger Setup 0.1.0.exe` — a standard NSIS
  installer (Next → Next → Finish), adds a Start Menu entry. Unsigned by
  default, so Windows SmartScreen will show a warning the first time — "More
  info" → "Run anyway".

First run on any OS creates the database at the `userData` path listed above
and you're straight into the app — no separate setup step.

### Installing on another Mac

The app isn't signed with an Apple Developer ID or notarized, so when the
`.dmg` reaches another Mac (download, AirDrop, Messages, email, USB), macOS
marks it as downloaded and refuses to open it with **"Portfolio Ledger is
damaged and can't be opened"**. The app isn't actually damaged; that's how
macOS describes an unnotarized app from the internet. On each Mac, once:

1. Open the `.dmg` and drag **Portfolio Ledger** into **Applications**.
2. Open **Terminal** (Applications → Utilities) and run:

   ```bash
   xattr -cr "/Applications/Portfolio Ledger.app"
   ```

   This removes the "downloaded from the internet" flag. It needs no password.
3. Open Portfolio Ledger from Applications as usual.

Repeat step 2 after installing a newer build. The old "right-click → Open"
bypass no longer works for this error, and on macOS 15 (Sequoia) and later it
was removed altogether.

**Still won't open?**

- Check the build is signed as a whole: on the build machine,
  `codesign --verify --deep --strict "dist/mac-universal/Portfolio Ledger.app"`
  should print nothing. An error like *"code has no resources but signature
  indicates they must be present"* means it was built without the
  `"identity": "-"` setting in `package.json` — rebuild with `npm run dist:mac`.
- Check it's the universal build: `lipo -archs "/Applications/Portfolio
  Ledger.app/Contents/MacOS/Portfolio Ledger"` should list both `x86_64` and
  `arm64`. An `arm64`-only build won't run on an Intel Mac.

These settings in `package.json` (`build.mac`) produce the family-friendly
build: `"identity": "-"` signs the whole app ad-hoc, `"hardenedRuntime": false`
is required with ad-hoc signing so Electron's own framework still loads, and
`"arch": ["universal"]` covers both chip types.

### Before distributing beyond your own machine

- Add an app icon (`build.linux.icon` / `build.mac.icon` / `build.win.icon`
  in `package.json`, pointing at `.png`/`.icns`/`.ico` files) — otherwise it
  ships with the default Electron icon, as it does right now.
- Code-signing (Apple Developer ID for macOS, an Authenticode certificate for
  Windows) removes the Gatekeeper/SmartScreen warnings above, including the
  `xattr` step on Macs — worth doing if anyone outside the family will run
  this. On macOS that means an Apple Developer account ($99/year), a
  Developer ID certificate, and notarization (electron-builder can notarize
  during `npm run dist:mac`); switch `identity` back to your certificate and
  turn `hardenedRuntime` on at the same time.

## Test

```bash
npm test
```

Runs every suite in `test/` with Node's built-in test runner, no external
test framework needed: the data layer (`db.js`), Excel import, reminders and
scheduling, filtering, and the portfolio, tax and bills calculations. These
cover everything except the Electron GUI itself (window creation, IPC wiring,
the file-picker dialog), which can only be exercised by actually running the
app.

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
  renderer/     UI: index.html, styles.css, tabs.js (section tabs), and per tab:
                  Portfolio: renderer.js, filterPolicies.js, portfolioMath.js
                  Tax projection: taxView.js, taxMath.js
                  Bills: billsView.js, billsMath.js
                — the *Math.js / filterPolicies.js files are pure and unit tested
  shared/       Rules used by both processes (name casing, policy rules)
test/           Node test-runner suites, one per module
```
