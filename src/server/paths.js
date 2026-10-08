'use strict';

const os = require('node:os');
const path = require('node:path');

/**
 * Where the browser server keeps its data: the same folder the Electron app
 * uses when run with `npm start`, so both open the same database. Set
 * PORTFOLIO_LEDGER_DATA_DIR to use another folder.
 *   macOS   ~/Library/Application Support/portfolio-ledger
 *   Windows %APPDATA%\portfolio-ledger
 *   Linux   $XDG_CONFIG_HOME/portfolio-ledger (default ~/.config/portfolio-ledger)
 */
function defaultDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.PORTFOLIO_LEDGER_DATA_DIR) return env.PORTFOLIO_LEDGER_DATA_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'portfolio-ledger');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'portfolio-ledger');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'portfolio-ledger');
}

module.exports = { defaultDataDir };
