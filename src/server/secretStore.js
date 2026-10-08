'use strict';

// Protects the Gmail app password when running in the browser, where Electron's
// safeStorage isn't available. The password is encrypted with AES-256-GCM, and
// the key is kept by the operating system, never in the database:
//   macOS   → Keychain (security)
//   Linux   → Secret Service / GNOME Keyring (secret-tool)
//   Windows → a key file in the data folder, itself encrypted with DPAPI
// so a copied database (or backup) doesn't reveal the password.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVICE = 'Portfolio Ledger';
const ACCOUNT = 'reminders-encryption-key';
const FORMAT = 'v1';

const run = (cmd, args, input) =>
  execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }).trim();

const powershell = (script, input) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);

const DPAPI_PROTECT =
  'Add-Type -AssemblyName System.Security; $b = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());' +
  ' [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))';
const DPAPI_UNPROTECT =
  'Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  ' [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))';

/** The OS-specific place the key lives: { read() → hex or null, write(hex) }. */
function keyStorageFor(platform, userDataPath) {
  if (platform === 'darwin') {
    return {
      read: () => {
        try { return run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']); } catch { return null; }
      },
      // A random key, not the password, is what passes through the command line.
      write: (hex) => run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', hex])
    };
  }
  if (platform === 'linux') {
    return {
      read: () => {
        try { return run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]) || null; } catch { return null; }
      },
      write: (hex) => run('secret-tool', ['store', `--label=${SERVICE} reminders key`, 'service', SERVICE, 'account', ACCOUNT], hex)
    };
  }
  if (platform === 'win32') {
    const keyFile = path.join(userDataPath, 'reminders-key.dpapi');
    return {
      read: () => (fs.existsSync(keyFile) ? powershell(DPAPI_UNPROTECT, fs.readFileSync(keyFile, 'utf8')) : null),
      write: (hex) => fs.writeFileSync(keyFile, powershell(DPAPI_PROTECT, hex), { mode: 0o600 })
    };
  }
  return { read: () => null, write: () => { throw new Error(`No secure key storage on ${platform}.`); } };
}

/**
 * A secret store for reminderService.js. keyStorage can be injected for tests.
 * Its settingsKey differs from the Electron app's, since each encrypts its own way.
 */
function createSecretStore({ userDataPath, platform = process.platform, keyStorage = keyStorageFor(platform, userDataPath) }) {
  let key = null;
  function getKey() {
    if (key) return key;
    let hex = keyStorage.read();
    if (!/^[0-9a-f]{64}$/.test(hex ?? '')) {
      hex = crypto.randomBytes(32).toString('hex');
      keyStorage.write(hex);
      if (keyStorage.read() !== hex) throw new Error('The key could not be saved to the system keychain.');
    }
    key = Buffer.from(hex, 'hex');
    return key;
  }

  return {
    settingsKey: 'reminders.appPassword.browser',
    isAvailable() {
      try {
        getKey();
        return true;
      } catch {
        return false;
      }
    },
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
    },
    decrypt(stored) {
      const [format, body] = String(stored).split(':');
      if (format !== FORMAT || !body) throw new Error('The saved Gmail app password is unreadable. Enter it again under Reminders.');
      const raw = Buffer.from(body, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

module.exports = { createSecretStore, keyStorageFor };
