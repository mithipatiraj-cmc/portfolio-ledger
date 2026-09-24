'use strict';

const nodemailer = require('nodemailer');

// Gmail SMTP with an app password (https://myaccount.google.com/apppasswords —
// requires 2-Step Verification). Implicit TLS on 465.
const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465, secure: true };

/**
 * Send one email through Gmail. Throws with a readable message on failure
 * (bad password, no network, …) so callers can show or log it.
 */
async function sendMail({ gmailUser, appPassword, to, subject, text, html }) {
  const transport = nodemailer.createTransport({
    ...GMAIL_SMTP,
    auth: { user: gmailUser, pass: appPassword.replace(/\s+/g, '') }, // Google shows it in 4-letter groups
    connectionTimeout: 20000
  });
  try {
    await transport.sendMail({ from: `Portfolio Ledger <${gmailUser}>`, to, subject, text, html });
  } catch (err) {
    if (err.code === 'EAUTH') {
      throw new Error('Gmail rejected the login. Check the Gmail address and that you used an app password, not your normal password.');
    }
    throw new Error(`Could not send email: ${err.message}`);
  } finally {
    transport.close();
  }
}

module.exports = { sendMail };
