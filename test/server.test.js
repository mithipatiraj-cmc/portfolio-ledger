'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const XLSX = require('xlsx');
const { createAppCore } = require('../src/main/appCore.js');
const { createLedgerServer, parseArgs } = require('../src/server/server.js');
const { createSecretStore } = require('../src/server/secretStore.js');
const { defaultDataDir } = require('../src/server/paths.js');

const memoryKeyStorage = () => {
  let stored = null;
  return { read: () => stored, write: (hex) => { stored = hex; } };
};

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** A server on a free port with its own temporary data folder. */
async function startServer(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-server-'));
  const core = createAppCore({
    userDataPath,
    launchCommand: () => ({ command: 'node', args: [] }),
    secretStore: createSecretStore({ userDataPath, keyStorage: memoryKeyStorage() })
  });
  const port = await freePort();
  const server = createLedgerServer({ core, port });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => { core.close(); resolve(); })));
  const base = `http://127.0.0.1:${port}`;
  const call = async (channel, payload, headers = { 'X-Portfolio-Ledger': '1' }) => {
    const res = await fetch(`${base}/api/call/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ payload })
    });
    return { status: res.status, body: await res.json() };
  };
  return { base, port, call, core, userDataPath };
}

test('serves the page with the browser API loaded before the app scripts', async (t) => {
  const { base } = await startServer(t);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.indexOf('webApi.js') < html.indexOf('money.js'), 'webApi.js first');
  const res = await fetch(`${base}/billsView.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('only files directly in the page folder are served', async (t) => {
  const { base } = await startServer(t);
  for (const p of ['/../main/db.js', '/%2e%2e/main/db.js', '/..%2fmain%2fdb.js', '/nope.js', '/index']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
});

test('API calls run the same handlers as the desktop app, and errors come back as messages', async (t) => {
  const { call } = await startServer(t);
  const id = (await call('policies:add', { policyNumber: 'FD-1', institution: 'HDFC', amountInvested: 100000, roi: 7 })).body.result;
  const list = (await call('policies:list')).body.result;
  assert.deepEqual(list.map((p) => [p.id, p.policy_number, p.institution]), [[id, 'FD-1', 'HDFC']]);
  assert.equal((await call('settings:setCurrency', 'USD')).body.result, 'USD');

  const bad = await call('bills:add', { name: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Give the bill a name.');
  assert.equal((await call('nothing:here')).status, 404);
  assert.equal((await call('constructor:x')).status, 404, 'no prototype lookups');
});

test('requests not from the app\'s own page are refused', async (t) => {
  const { call, port } = await startServer(t);
  assert.equal((await call('policies:list', null, {})).status, 403, 'missing app header');
  assert.equal((await call('policies:list', null, { 'X-Portfolio-Ledger': '1', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('policies:list', null, { 'X-Portfolio-Ledger': '1', Origin: `http://localhost:${port}` })).status, 200);

  // A DNS-rebinding page reaches 127.0.0.1 but under its own host name.
  const http = require('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(status, 403);
});

test('Excel import works by upload: preview, then commit with a mapping', async (t) => {
  const { base, call } = await startServer(t);
  const ws = XLSX.utils.aoa_to_sheet([['Policy No', 'Institution', 'Amount', 'ROI'], ['UP-1', 'SBI', 50000, 7]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const res = await fetch(`${base}/api/upload/import`, {
    method: 'POST',
    headers: { 'X-Portfolio-Ledger': '1', 'Content-Type': 'application/octet-stream' },
    body: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  });
  const { token } = await res.json();
  const preview = (await call('import:previewUpload', { token })).body.result;
  assert.equal(preview.filePath, token, 'the page refers to the upload by token, never a path');
  assert.deepEqual(preview.headerRow, ['Policy No', 'Institution', 'Amount', 'ROI']);
  const result = (await call('import:commitWithMapping', { filePath: token, sheetName: 'Sheet1', columnMapping: {} })).body.result;
  assert.equal(result.added, 1);
  assert.equal((await call('import:previewSheet', { filePath: token })).status, 400, 'upload is used up after commit');
  assert.equal((await call('import:previewSheet', { filePath: '/etc/passwd' })).status, 400, 'no arbitrary paths');
});

test('backup downloads the database, and restore by upload replaces it after keeping a safety copy', async (t) => {
  const { base, call } = await startServer(t);
  await call('policies:add', { policyNumber: 'KEEP', institution: 'HDFC', amountInvested: 1 });
  const backup = await fetch(`${base}/api/backup`, { headers: { 'X-Portfolio-Ledger': '1' } });
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get('content-disposition'), /portfolio-ledger-backup-\d{4}-\d{2}-\d{2}\.sqlite/);
  const bytes = Buffer.from(await backup.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(`${base}/api/backup`)).status, 403, 'needs the app header');

  await call('policies:add', { policyNumber: 'LATER', institution: 'SBI', amountInvested: 2 });
  const upload = await fetch(`${base}/api/upload/restore`, {
    method: 'POST', headers: { 'X-Portfolio-Ledger': '1', 'Content-Type': 'application/octet-stream' }, body: bytes
  });
  const { token } = await upload.json();
  const info = (await call('db:inspectUpload', { token })).body.result;
  assert.deepEqual([info.ok, info.policyCount, info.currentCount], [true, 1, 2]);
  const restored = (await call('db:restoreUpload', { token })).body.result;
  assert.equal(restored.ok, true);
  assert.ok(fs.existsSync(restored.safetyPath));
  assert.deepEqual((await call('policies:list')).body.result.map((p) => p.policy_number), ['KEEP']);
});

test('the browser password store encrypts with a key kept outside the database', () => {
  const keyStorage = memoryKeyStorage();
  const store = createSecretStore({ userDataPath: os.tmpdir(), keyStorage });
  assert.equal(store.isAvailable(), true);
  const sealed = store.encrypt('abcd efgh ijkl mnop');
  assert.match(sealed, /^v1:/);
  assert.ok(!sealed.includes('abcd'));
  assert.equal(store.decrypt(sealed), 'abcd efgh ijkl mnop');
  assert.notEqual(store.settingsKey, 'reminders.appPassword', "kept apart from the Electron app's password");

  const otherKey = createSecretStore({ userDataPath: os.tmpdir(), keyStorage: memoryKeyStorage() });
  assert.throws(() => otherKey.decrypt(sealed), 'a different key cannot read it');
  const broken = createSecretStore({ userDataPath: os.tmpdir(), keyStorage: { read: () => null, write: () => { throw new Error('no keychain'); } } });
  assert.equal(broken.isAvailable(), false);
});

test('data folder matches the desktop app in development on each OS', () => {
  assert.equal(defaultDataDir({ platform: 'darwin', env: {}, home: '/Users/a' }), '/Users/a/Library/Application Support/portfolio-ledger');
  assert.equal(defaultDataDir({ platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.config/portfolio-ledger');
  assert.equal(defaultDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, home: 'C:\\Users\\a' }),
    path.join('C:\\Users\\a\\AppData\\Roaming', 'portfolio-ledger'));
  assert.equal(defaultDataDir({ platform: 'darwin', env: { PORTFOLIO_LEDGER_DATA_DIR: '/tmp/x' } }), '/tmp/x');
  assert.deepEqual(parseArgs(['--port', '6000', '--no-open']), { port: 6000, open: false, checkReminders: false });
  assert.throws(() => parseArgs(['--port', 'abc']), /Invalid port/);
});

test('calls with no payload use the handlers\' defaults, as over IPC', async (t) => {
  const { call } = await startServer(t);
  assert.equal((await call('policies:list')).status, 200);
  assert.equal((await call('bills:list', null)).status, 200);
  assert.equal((await call('bills:payments')).status, 200);
});
