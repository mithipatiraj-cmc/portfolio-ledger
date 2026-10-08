#!/usr/bin/env node
'use strict';

// Builds double-clickable downloads of the browser version: one executable per
// OS with Node built in (a Node "single executable application"), so users need
// no repository, Node or npm. Double-clicking starts the app in the background
// and opens it in the browser (see src/server/server.js).
//
//   npm run dist:web                 every target
//   npm run dist:web -- mac linux    only some: mac, windows, linux, chromebook
//
// Output in dist/web/:
//   Portfolio-Ledger-macOS.zip              Portfolio Ledger.app (universal: Apple silicon + Intel), ad-hoc signed
//   Portfolio-Ledger-Windows-x64.zip        Portfolio Ledger.exe
//   portfolio-ledger-linux-x64.tar.gz       the executable, plus the .desktop launcher file
//   portfolio-ledger-linux-arm64.tar.gz
//   portfolio-ledger_<version>_amd64.deb    for Chromebooks (Linux) and Debian/Ubuntu: double-click to install
//   portfolio-ledger_<version>_arm64.deb    the same for ARM Chromebooks
//
// macOS signing needs this to run on a Mac (codesign, lipo, ditto). The other
// targets build anywhere. Node binaries come from nodejs.org, checked against
// the published SHA-256 sums, and are cached in dist/web/.cache.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'web');
const WORK = path.join(OUT, '.work');
const CACHE = path.join(OUT, '.cache');
const NODE_VERSION = 'v25.9.0'; // the Node built into the executables (needs node:sqlite and SEA)
const APP_NAME = 'Portfolio Ledger';
const pkg = require(path.join(ROOT, 'package.json'));

const TARGETS = {
  mac: ['darwin-arm64', 'darwin-x64'],
  windows: ['win-x64'],
  linux: ['linux-x64', 'linux-arm64'],
  chromebook: ['linux-x64', 'linux-arm64']
};

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const step = (msg) => console.log(`• ${msg}`);

// --- Node binaries from nodejs.org ---
let shasums = null;
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The official node binary for a platform-arch, downloaded once and verified. */
async function nodeBinary(target) {
  const isWin = target.startsWith('win');
  const archive = `node-${NODE_VERSION}-${target}.${isWin ? 'zip' : 'tar.gz'}`;
  const dir = path.join(CACHE, `node-${NODE_VERSION}-${target}`);
  const binary = isWin ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
  if (fs.existsSync(binary)) return binary;

  shasums ??= (await fetchBuffer(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).toString('utf8');
  const expected = shasums.split('\n').find((l) => l.endsWith(`  ${archive}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`No published checksum for ${archive}`);
  step(`Downloading ${archive}`);
  const data = await fetchBuffer(`https://nodejs.org/dist/${NODE_VERSION}/${archive}`);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${archive}`);

  fs.mkdirSync(CACHE, { recursive: true });
  const archivePath = path.join(CACHE, archive);
  fs.writeFileSync(archivePath, data);
  if (isWin) run('unzip', ['-q', '-o', archivePath, '-d', CACHE]);
  else run('tar', ['xzf', archivePath, '-C', CACHE]);
  fs.rmSync(archivePath);
  if (!fs.existsSync(binary)) throw new Error(`Unpacked ${archive} but found no ${binary}`);
  return binary;
}

/** A node binary that can run on this machine, to do the building. */
async function hostNode() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const target = { darwin: `darwin-${arch}`, linux: `linux-${arch}`, win32: `win-${arch}` }[process.platform];
  if (!target) throw new Error(`Can't build on ${process.platform}`);
  return nodeBinary(target);
}

// --- Bundle: the server and its dependencies in one file, plus the page as assets ---
async function bundle() {
  step('Bundling the server');
  const esbuild = require('esbuild');
  const bundleFile = path.join(WORK, 'portfolio-ledger.js');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'server', 'server.js')],
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
    legalComments: 'none'
  });
  const assets = { 'webApi.js': path.join(ROOT, 'src', 'server', 'webApi.js') };
  const rendererDir = path.join(ROOT, 'src', 'renderer');
  for (const name of fs.readdirSync(rendererDir)) {
    if (/\.(html|js|css)$/.test(name)) assets[`renderer/${name}`] = path.join(rendererDir, name);
  }
  return { bundleFile, assets };
}

/** One single-executable file for a target, built from the bundle. */
async function buildExecutable(target, { bundleFile, assets }, builder) {
  const isWin = target.startsWith('win');
  const output = path.join(WORK, target, isWin ? 'portfolio-ledger.exe' : 'portfolio-ledger');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const config = path.join(WORK, `sea-${target}.json`);
  fs.writeFileSync(config, JSON.stringify({
    main: bundleFile,
    output,
    executable: await nodeBinary(target),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // must be off when building for another OS or CPU
    assets
  }, null, 2));
  step(`Building the ${target} executable`);
  run(builder, ['--build-sea', config]);
  return output;
}

// --- macOS: a universal, ad-hoc signed .app in a zip ---
async function packageMac(executables) {
  if (process.platform !== 'darwin') throw new Error('The macOS app has to be built on a Mac (it needs codesign).');
  step('Packaging Portfolio Ledger.app');
  for (const exe of executables) run('codesign', ['--sign', '-', '--force', exe]);
  const app = path.join(WORK, `${APP_NAME}.app`);
  fs.rmSync(app, { recursive: true, force: true });
  const macosDir = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  const binary = path.join(macosDir, APP_NAME);
  run('lipo', ['-create', ...executables, '-output', binary]);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.portfolioledger.web</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- The launcher exits as soon as the browser opens; no Dock icon or menu bar. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);
  run('codesign', ['--sign', '-', '--force', '--deep', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const zip = path.join(OUT, 'Portfolio-Ledger-macOS.zip');
  fs.rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  return zip;
}

// --- Windows: the .exe in a zip ---
function packageWindows(exe) {
  step('Packaging the Windows download');
  const dir = path.join(WORK, 'windows');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(exe, path.join(dir, `${APP_NAME}.exe`));
  const zip = path.join(OUT, 'Portfolio-Ledger-Windows-x64.zip');
  fs.rmSync(zip, { force: true });
  run('zip', ['-q', '-j', zip, path.join(dir, `${APP_NAME}.exe`)]);
  return zip;
}

// --- Linux: a tarball, and a .deb (which is what Chromebooks install) ---
const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Track investments, tax and bills; opens in your browser
Exec=/opt/portfolio-ledger/portfolio-ledger
Icon=portfolio-ledger
Terminal=false
Categories=Office;Finance;
`;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#2f6f4e"/>
  <rect x="14" y="34" width="8" height="16" rx="2" fill="#fff"/>
  <rect x="28" y="24" width="8" height="26" rx="2" fill="#fff"/>
  <rect x="42" y="14" width="8" height="36" rx="2" fill="#fff"/>
</svg>
`;

/** Files as they'd be installed, under root. */
function stageLinux(root, exe) {
  const files = {
    'opt/portfolio-ledger/portfolio-ledger': { from: exe, mode: 0o755 },
    'usr/share/applications/portfolio-ledger.desktop': { text: DESKTOP_ENTRY, mode: 0o644 },
    'usr/share/icons/hicolor/scalable/apps/portfolio-ledger.svg': { text: ICON_SVG, mode: 0o644 }
  };
  for (const [rel, f] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.from) fs.copyFileSync(f.from, dest);
    else fs.writeFileSync(dest, f.text);
    fs.chmodSync(dest, f.mode);
  }
}

/** tar.gz of dir's contents, owned by root, without macOS extended attributes. */
function tarGz(dir, out, entries) {
  const args = ['-czf', out, '-C', dir];
  if (process.platform === 'darwin') args.unshift('--no-mac-metadata', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root');
  else args.unshift('--owner=0', '--group=0', '--numeric-owner');
  run('tar', [...args, ...entries], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
}

/** A Unix ar archive (the .deb container): global header, then 60-byte member headers. */
function arArchive(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const { name, data } of members) {
    const field = (v, width) => String(v).padEnd(width, ' ');
    // name (padded, no '/', as dpkg-deb writes it), mtime, owner, group, mode, size, then the 2-byte magic.
    const header = field(name, 16) + field(Math.floor(Date.now() / 1000), 12) +
      field(0, 6) + field(0, 6) + field('100644', 8) + field(data.length, 10) + '`\n';
    parts.push(Buffer.from(header, 'ascii'), data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

function packageLinux(target, exe) {
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64';
  const debArch = arch === 'arm64' ? 'arm64' : 'amd64';
  const stage = path.join(WORK, `linux-${arch}-root`);
  fs.rmSync(stage, { recursive: true, force: true });
  stageLinux(stage, exe);

  step(`Packaging the Linux ${arch} tarball`);
  const tarball = path.join(OUT, `portfolio-ledger-linux-${arch}.tar.gz`);
  const flat = path.join(WORK, `linux-${arch}-flat`, 'portfolio-ledger');
  fs.rmSync(path.dirname(flat), { recursive: true, force: true });
  fs.mkdirSync(flat, { recursive: true });
  fs.copyFileSync(exe, path.join(flat, 'portfolio-ledger'));
  fs.chmodSync(path.join(flat, 'portfolio-ledger'), 0o755);
  fs.writeFileSync(path.join(flat, 'portfolio-ledger.desktop'), DESKTOP_ENTRY.replace('/opt/portfolio-ledger/portfolio-ledger', 'portfolio-ledger'));
  tarGz(path.dirname(flat), tarball, ['portfolio-ledger']);

  step(`Packaging the ${debArch} .deb`);
  const installedKb = Math.ceil(fs.statSync(exe).size / 1024) + 8;
  const control = path.join(WORK, `deb-${debArch}-control`);
  fs.rmSync(control, { recursive: true, force: true });
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(control, 'control'), [
    'Package: portfolio-ledger',
    `Version: ${pkg.version}`,
    `Architecture: ${debArch}`,
    `Maintainer: ${pkg.author ?? 'Portfolio Ledger'}`,
    `Installed-Size: ${installedKb}`,
    'Section: misc',
    'Priority: optional',
    `Description: ${pkg.description}`,
    ' Opens in your web browser; all data stays on this computer.',
    ''
  ].join('\n'));
  const controlTar = path.join(WORK, `deb-${debArch}-control.tar.gz`);
  const dataTar = path.join(WORK, `deb-${debArch}-data.tar.gz`);
  tarGz(control, controlTar, ['./control']);
  tarGz(stage, dataTar, ['./opt', './usr']);
  const deb = path.join(OUT, `portfolio-ledger_${pkg.version}_${debArch}.deb`);
  fs.writeFileSync(deb, arArchive([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: fs.readFileSync(controlTar) },
    { name: 'data.tar.gz', data: fs.readFileSync(dataTar) }
  ]));
  return [tarball, deb];
}

async function main() {
  const requested = process.argv.slice(2);
  for (const r of requested) if (!TARGETS[r]) throw new Error(`Unknown target "${r}". Use: ${Object.keys(TARGETS).join(', ')}`);
  const wanted = new Set(requested.length ? requested : Object.keys(TARGETS));

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const builder = await hostNode();
  const built = await bundle();
  const outputs = [];

  if (wanted.has('mac')) {
    const exes = [];
    for (const t of TARGETS.mac) exes.push(await buildExecutable(t, built, builder));
    outputs.push(await packageMac(exes));
  }
  if (wanted.has('windows')) outputs.push(packageWindows(await buildExecutable('win-x64', built, builder)));
  if (wanted.has('linux') || wanted.has('chromebook')) {
    for (const t of TARGETS.linux) outputs.push(...packageLinux(t, await buildExecutable(t, built, builder)));
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('\nBuilt:');
  for (const f of outputs) console.log(`  ${path.relative(ROOT, f)}  (${(fs.statSync(f).size / 1024 / 1024).toFixed(0)} MB)`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
