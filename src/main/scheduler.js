'use strict';

// Registers a daily OS-level job that launches this app headless with
// --check-reminders, so expiry emails go out even when the app isn't open:
//   macOS   → a launchd agent in ~/Library/LaunchAgents
//   Windows → a Task Scheduler task (runs late if the PC was off at the time)
// The file builders are pure (unit tested); install/remove touch the OS.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LAUNCHD_LABEL = 'com.portfolioledger.reminders';
const WINDOWS_TASK_NAME = 'Portfolio Ledger Reminders';
const CHECK_FLAG = '--check-reminders';

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** launchd agent: run programArgs daily at hour:00 local time (and on wake if asleep then). */
function buildLaunchdPlist({ programArgs, hour, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** Quote a Windows command-line argument if it has spaces or quotes. */
function quoteWindowsArg(arg) {
  return /[\s"]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : arg;
}

/**
 * Task Scheduler XML: daily at hour:00, runs as the signed-in user,
 * StartWhenAvailable so a missed run (PC off) happens at next sign-in/boot.
 */
function buildWindowsTaskXml({ command, args, hour }) {
  const hh = String(hour).padStart(2, '0');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Emails Portfolio Ledger expiry reminders.</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T${hh}:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(args.map(quoteWindowsArg).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function launchctl(...args) {
  execFileSync('launchctl', args, { stdio: 'pipe' });
}

/**
 * Create or replace the daily job. command/args launch this app with
 * --check-reminders. Returns a short description for the settings screen.
 */
function installSchedule({ command, args, hour, logPath, platform = process.platform }) {
  if (platform === 'darwin') {
    const plistPath = launchdPlistPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, buildLaunchdPlist({ programArgs: [command, ...args], hour, logPath }));
    const domain = `gui/${process.getuid()}`;
    try { launchctl('bootout', `${domain}/${LAUNCHD_LABEL}`); } catch { /* not loaded yet */ }
    launchctl('bootstrap', domain, plistPath);
    return { supported: true, description: `Daily at ${hourLabel(hour)} via macOS launchd` };
  }
  if (platform === 'win32') {
    const xmlPath = path.join(os.tmpdir(), 'portfolio-ledger-task.xml');
    // schtasks expects UTF-16 LE with a byte-order mark for /XML.
    fs.writeFileSync(xmlPath, '﻿' + buildWindowsTaskXml({ command, args, hour }), 'utf16le');
    try {
      execFileSync('schtasks', ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', xmlPath, '/F'], { stdio: 'pipe' });
    } finally {
      fs.rmSync(xmlPath, { force: true });
    }
    return { supported: true, description: `Daily at ${hourLabel(hour)} via Windows Task Scheduler` };
  }
  return { supported: false, description: 'Daily background checks are available on macOS and Windows only; reminders are still checked while the app is open.' };
}

/** Remove the daily job if it exists. Safe to call when nothing is installed. */
function removeSchedule({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    try { launchctl('bootout', `gui/${process.getuid()}/${LAUNCHD_LABEL}`); } catch { /* not loaded */ }
    fs.rmSync(launchdPlistPath(), { force: true });
  } else if (platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], { stdio: 'pipe' });
    } catch { /* no such task */ }
  }
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

module.exports = {
  CHECK_FLAG,
  LAUNCHD_LABEL,
  WINDOWS_TASK_NAME,
  buildLaunchdPlist,
  buildWindowsTaskXml,
  quoteWindowsArg,
  installSchedule,
  removeSchedule
};
