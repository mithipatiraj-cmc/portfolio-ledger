#!/usr/bin/env node
'use strict';

// Runs Portfolio Ledger in a web browser instead of the Electron window.
// A small HTTP server on this computer only (127.0.0.1) serves the same page
// (src/renderer) and answers the same requests the Electron app handles over
// IPC, via appCore.js and the same database file. No login: nothing outside
// this computer can reach it, and requests that don't come from its own page
// are refused (see checkRequest).
//
//   npm run serve                     start and open the browser
//   npm run serve -- --port 6000      another port (default 5757)
//   npm run serve -- --no-open        don't open the browser
//   node src/server/server.js --check-reminders   one reminder check, then exit (used by the daily OS job)
//
// Packaged as a double-clickable app (scripts/build-web.js), it bundles the
// page inside the executable, and a double-click *launches* it: starts the
// server in the background if it isn't running, opens the browser, and exits.
// The page's Quit button stops the background server.

try {
  require('node:sqlite');
} catch {
  console.error(`Portfolio Ledger needs Node.js 22.13 or later (this is ${process.version}). Install a newer Node from nodejs.org.`);
  process.exit(1);
}

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createAppCore } = require('../main/appCore.js');
const { CHECK_FLAG } = require('../main/scheduler.js');
const { createSecretStore } = require('./secretStore.js');
const { defaultDataDir } = require('./paths.js');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5757;
const FOREGROUND_FLAG = '--foreground';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const WEB_API_FILE = path.join(__dirname, 'webApi.js');

// Packaged as a single executable (Node SEA), the page's files are bundled
// assets named 'renderer/<file>' and 'webApi.js' instead of files on disk.
const sea = (() => {
  try {
    return require('node:sea');
  } catch {
    return null;
  }
})();
const IS_PACKAGED = Boolean(sea?.isSea());

/** Inside a Chromebook's Linux environment, Chrome reaches the app at penguin.linux.test, not localhost. */
const IN_CHROMEBOOK_LINUX = process.platform === 'linux' && fs.existsSync('/opt/google/cros-containers');
const CHROMEBOOK_HOST = 'penguin.linux.test';

/** The page's files, from disk in development or from the executable when packaged. name → Buffer, or null. */
function readPageFile(name) {
  if (IS_PACKAGED) {
    const key = name === 'webApi.js' ? name : `renderer/${name}`;
    try {
      return Buffer.from(sea.getAsset(key));
    } catch {
      return null;
    }
  }
  const file = name === 'webApi.js' ? WEB_API_FILE : path.join(RENDERER_DIR, name);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
const API_HEADER = 'x-portfolio-ledger';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_KINDS = { import: '.xlsx', restore: '.sqlite' };
const HOUR_MS = 60 * 60 * 1000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The HTTP front end for an appCore. Exported for tests; main() below runs it.
 * Uploaded files (Excel imports, backups to restore) are kept in uploadDir
 * under random tokens until used, so the page never names a path on disk.
 * extraHosts are other names the page may be opened under (the Chromebook one);
 * onQuit runs after the page's Quit request has been answered.
 */
function createLedgerServer({
  core,
  port,
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-ledger-')),
  extraHosts = [],
  onQuit = () => {}
}) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...extraHosts.map((h) => `${h}:${port}`)]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const uploads = new Map(); // token → { kind, filePath }

  function uploadPath(token, kind) {
    const upload = uploads.get(token);
    if (!upload || upload.kind !== kind) throw new HttpError(400, 'That file is no longer available. Choose it again.');
    return upload.filePath;
  }

  function discardUpload(token) {
    const upload = uploads.get(token);
    if (!upload) return;
    uploads.delete(token);
    fs.rmSync(upload.filePath, { force: true });
  }

  // The page's requests: everything appCore handles, plus browser versions of
  // the three that use native dialogs in Electron (import, backup, restore).
  const handlers = {
    ...core.handlers,
    'import:previewUpload': ({ token }) => ({ ...core.previewImportFile(uploadPath(token, 'import')), filePath: token }),
    'import:previewSheet': ({ filePath, sheetName }) => ({
      ...core.previewImportFile(uploadPath(filePath, 'import'), sheetName),
      filePath
    }),
    'import:commitWithMapping': ({ filePath, ...options }) => {
      const result = core.commitImportFile(uploadPath(filePath, 'import'), options);
      discardUpload(filePath);
      return result;
    },
    'db:inspectUpload': ({ token }) => core.inspectRestore(uploadPath(token, 'restore')),
    'db:restoreUpload': ({ token }) => {
      const result = core.restoreFrom(uploadPath(token, 'restore'));
      discardUpload(token);
      return result;
    },
    'uploads:discard': ({ token }) => {
      discardUpload(token);
      return true;
    },
    // For the launcher (is it already running?) and the page's Quit button.
    'app:ping': () => ({ app: 'portfolio-ledger', packaged: IS_PACKAGED }),
    'app:quit': () => {
      setImmediate(onQuit); // after this response has gone out
      return true;
    }
  };

  /**
   * No login, so make sure a request really comes from this app's own page:
   * the Host must be this server (stops DNS-rebinding sites from reading it),
   * and API calls need our custom header (a cross-site page can't add one
   * without a CORS preflight, which this server never approves) and, when the
   * browser sends an Origin, our own origin.
   */
  function checkRequest(req, isApi) {
    if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    if (!isApi) return;
    if (req.headers[API_HEADER] !== '1') throw new HttpError(403, 'Forbidden');
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw new HttpError(403, 'Forbidden origin');
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new HttpError(413, 'That file is too large.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' });

  /** The page itself, with webApi.js loaded first so window.api exists for the other scripts. */
  function indexHtml() {
    const html = readPageFile('index.html').toString('utf8');
    const firstScript = html.indexOf('<script src=');
    return `${html.slice(0, firstScript)}<script src="webApi.js"></script>\n  ${html.slice(firstScript)}`;
  }

  function serveStatic(res, urlPath) {
    if (urlPath === '/' || urlPath === '/index.html') {
      return send(res, 200, indexHtml(), { 'Content-Type': CONTENT_TYPES['.html'] });
    }
    if (urlPath === '/favicon.ico') return send(res, 204, ''); // browsers ask; the app has no icon yet
    // Only the page's own files, by plain name: no subfolders, no '..'.
    const name = decodeURIComponent(urlPath.slice(1));
    const type = CONTENT_TYPES[path.extname(name)];
    const data = type && /^[\w.-]+$/.test(name) && !name.startsWith('.') ? readPageFile(name) : null;
    if (!data) throw new HttpError(404, 'Not found');
    return send(res, 200, data, { 'Content-Type': type });
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    const isApi = url.pathname.startsWith('/api/');
    checkRequest(req, isApi);

    if (!isApi) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return serveStatic(res, url.pathname);
    }

    // POST /api/call/<channel>  { payload } → { result }
    const call = /^\/api\/call\/([a-zA-Z]+:[a-zA-Z]+)$/.exec(url.pathname);
    if (call && req.method === 'POST') {
      const handler = Object.hasOwn(handlers, call[1]) ? handlers[call[1]] : null;
      if (!handler) throw new HttpError(404, `Unknown request: ${call[1]}`);
      const raw = await readBody(req, MAX_JSON_BYTES);
      let body;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        throw new HttpError(400, 'Request body is not valid JSON.');
      }
      // JSON has no undefined; the handlers' defaults (e.g. listPolicies(opts = {})) expect it, as over IPC.
      const result = await handler(body.payload ?? undefined);
      return sendJson(res, 200, { result: result === undefined ? null : result });
    }

    // POST /api/upload/<import|restore>  (file bytes) → { token }
    const upload = /^\/api\/upload\/(import|restore)$/.exec(url.pathname);
    if (upload && req.method === 'POST') {
      const kind = upload[1];
      const data = await readBody(req, MAX_UPLOAD_BYTES);
      if (data.length === 0) throw new HttpError(400, 'The file is empty.');
      const token = crypto.randomBytes(16).toString('hex');
      const filePath = path.join(uploadDir, `${token}${UPLOAD_KINDS[kind]}`);
      fs.writeFileSync(filePath, data);
      uploads.set(token, { kind, filePath });
      return sendJson(res, 200, { token });
    }

    // GET /api/backup → a consistent copy of the database, as a download
    if (url.pathname === '/api/backup' && req.method === 'GET') {
      const today = new Date().toISOString().slice(0, 10);
      const tempFile = path.join(uploadDir, `backup-${crypto.randomBytes(8).toString('hex')}.sqlite`);
      core.backupTo(tempFile);
      const data = fs.readFileSync(tempFile);
      fs.rmSync(tempFile, { force: true });
      return send(res, 200, data, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="portfolio-ledger-backup-${today}.sqlite"`
      });
    }

    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // A plain Error from a handler is a message for the user ("Enter the amount paid.");
      // anything else (TypeError, SQLite errors, …) is a bug worth logging.
      const isMessage = err instanceof HttpError || err.constructor === Error;
      const status = err instanceof HttpError ? err.status : isMessage ? 400 : 500;
      if (!isMessage) console.error(`${req.method} ${req.url}: ${err.stack ?? err}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    });
  });
  server.on('close', () => fs.rmSync(uploadDir, { recursive: true, force: true }));
  return server;
}

/** Make a request of an already-running server. Resolves its result, or null if none is listening. */
function callRunning(port, channel, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port,
        method: 'POST',
        path: `/api/call/${channel}`,
        headers: { Host: `${HOST}:${port}`, [API_HEADER]: '1', 'Content-Type': 'application/json' },
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).result ?? true);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end('{}');
  });
}

const isOurServer = async (port) => (await callRunning(port, 'app:ping', { timeout: 2000 }))?.app === 'portfolio-ledger';

/**
 * What a double-click on the packaged app does: open the browser on the
 * running server, starting one in the background first if needed. The
 * launcher itself then exits, so no window stays open.
 */
async function launch(options, userDataPath) {
  const url = browserUrl(options.port);
  if (await isOurServer(options.port)) {
    if (options.open) openBrowser(url);
    return;
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  const logPath = path.join(userDataPath, 'server.log');
  const log = fs.openSync(logPath, 'a');
  const args = [FOREGROUND_FLAG, '--no-open', '--port', String(options.port)];
  const child = spawn(process.execPath, IS_PACKAGED ? args : [__filename, ...args], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isOurServer(options.port)) {
      if (options.open) openBrowser(url);
      return;
    }
  }
  throw new Error(`Portfolio Ledger didn't start. Details are in ${logPath}`);
}

function browserUrl(port) {
  return `http://${IN_CHROMEBOOK_LINUX ? CHROMEBOOK_HOST : 'localhost'}:${port}/`;
}

function openBrowser(url) {
  const [command, args] = {
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '""', url]]
  }[process.platform] ?? ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

function parseArgs(argv) {
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : Number(process.env.PORT) || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${argv[portIndex + 1]}`);
  return {
    port,
    open: !argv.includes('--no-open'),
    checkReminders: argv.includes(CHECK_FLAG),
    foreground: argv.includes(FOREGROUND_FLAG)
  };
}

async function main() {
  if (!IS_PACKAGED) require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
  const options = parseArgs(process.argv.slice(2));
  const userDataPath = defaultDataDir();

  // The daily OS job: hand the check to a running server if there is one, else do it here.
  if (options.checkReminders) {
    if (await callRunning(options.port, 'reminders:checkNow')) {
      console.log(`${new Date().toISOString()} reminder check handed to the running app on port ${options.port}`);
      return;
    }
    const core = createAppCore({ userDataPath, launchCommand: () => launchCommand(options.port), secretStore: createSecretStore({ userDataPath }) });
    try {
      const result = await core.reminders.runCheck('scheduled');
      console.log(`${new Date().toISOString()} reminder check: ${result.ran ? (result.ok ? `sent ${result.sent}` : `failed: ${result.error}`) : 'reminders are off'}`);
    } finally {
      core.close();
    }
    return;
  }

  // A double-click on the packaged app: start in the background if needed, open the browser, exit.
  if (IS_PACKAGED && !options.foreground) return launch(options, userDataPath);

  const core = createAppCore({ userDataPath, launchCommand: () => launchCommand(options.port), secretStore: createSecretStore({ userDataPath }) });
  core.resetIfRequested();
  let hourly = null;
  const stop = () => {
    clearInterval(hourly);
    server.close();
    core.close();
    process.exit(0);
  };
  // In a Chromebook's Linux container, Chrome connects from ChromeOS through the
  // container's own network (not reachable from other devices), so listen there.
  const server = createLedgerServer({
    core,
    port: options.port,
    extraHosts: IN_CHROMEBOOK_LINUX ? [CHROMEBOOK_HOST] : [],
    onQuit: stop
  });
  const url = browserUrl(options.port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${options.port} is already in use. Portfolio Ledger may already be running at ${url}`);
      console.error('Or start it on another port: npm run serve -- --port 5758');
    } else {
      console.error(err.message);
    }
    core.close();
    process.exit(1);
  });

  server.listen(options.port, IN_CHROMEBOOK_LINUX ? '0.0.0.0' : HOST, () => {
    console.log(`${new Date().toISOString()} Portfolio Ledger is running at ${url}`);
    console.log(`Data: ${core.dbPath}`);
    console.log('Only this computer can open it. Quit from the app, or press Ctrl+C here.');
    if (options.open) openBrowser(url);
  });

  // Catch anything that came due while it wasn't running, then keep checking hourly.
  core.reminders.runCheck('startup');
  hourly = setInterval(() => core.reminders.runCheck('hourly'), HOUR_MS);

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** How the daily OS job runs a headless check in browser mode: this program with --check-reminders. */
function launchCommand(port) {
  const args = IS_PACKAGED ? [CHECK_FLAG] : [__filename, CHECK_FLAG];
  if (port !== DEFAULT_PORT) args.push('--port', String(port));
  return { command: process.execPath, args };
}

if (IS_PACKAGED || require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { createLedgerServer, parseArgs, DEFAULT_PORT };
