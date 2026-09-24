'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LAUNCHD_LABEL,
  buildLaunchdPlist,
  buildWindowsTaskXml,
  quoteWindowsArg,
  installSchedule
} = require('../src/main/scheduler.js');

test('buildLaunchdPlist runs the app with --check-reminders daily at the chosen hour', () => {
  const plist = buildLaunchdPlist({
    programArgs: ['/Applications/Portfolio Ledger.app/Contents/MacOS/Portfolio Ledger', '--check-reminders'],
    hour: 9,
    logPath: '/Users/me/Library/Application Support/portfolio-ledger/reminders.log'
  });
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<string>\/Applications\/Portfolio Ledger\.app\/Contents\/MacOS\/Portfolio Ledger<\/string>\s*<string>--check-reminders<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>9<\/integer>/);
  assert.match(plist, /reminders\.log/);
});

test('buildLaunchdPlist escapes XML special characters in paths', () => {
  const plist = buildLaunchdPlist({ programArgs: ['/tmp/a&b<c>'], hour: 0, logPath: '/tmp/log' });
  assert.match(plist, /\/tmp\/a&amp;b&lt;c&gt;/);
});

test('buildWindowsTaskXml: daily trigger, catch-up when missed, quoted arguments', () => {
  const xml = buildWindowsTaskXml({
    command: 'C:\\Program Files\\Portfolio Ledger\\Portfolio Ledger.exe',
    args: ['C:\\dev\\portfolio ledger', '--check-reminders'],
    hour: 7
  });
  assert.match(xml, /<StartBoundary>2026-01-01T07:00:00<\/StartBoundary>/);
  assert.match(xml, /<DaysInterval>1<\/DaysInterval>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<Command>C:\\Program Files\\Portfolio Ledger\\Portfolio Ledger\.exe<\/Command>/);
  assert.match(xml, /<Arguments>&quot;C:\\dev\\portfolio ledger&quot; --check-reminders<\/Arguments>/);
});

test('quoteWindowsArg only quotes when needed', () => {
  assert.equal(quoteWindowsArg('--check-reminders'), '--check-reminders');
  assert.equal(quoteWindowsArg('C:\\my app'), '"C:\\my app"');
});

test('installSchedule reports unsupported platforms without touching the OS', () => {
  const r = installSchedule({ command: 'x', args: [], hour: 9, logPath: '/tmp/x', platform: 'linux' });
  assert.equal(r.supported, false);
});
