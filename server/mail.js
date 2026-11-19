/**
 * Transactional email for password recovery.
 *
 * Delivery uses SMTP when the server has credentials. For a Gmail account, set:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=<the Gmail address>
 *   SMTP_PASS=<16-character Google app password>
 *   MAIL_FROM=WORKBRIDGE <the Gmail address>
 *
 * The app password is read from the environment only; it is never written to
 * the repository or sent to the browser.
 */

import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;

export function mailConfigured() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

export function mailSender() {
  return config.mailFrom || config.smtpUser || '';
}

function getTransport() {
  if (!mailConfigured()) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPass },
      ...(config.smtpSecure ? {} : { requireTLS: true })
    });
  }
  return transport;
}

export async function sendMail({ to, subject, text, html }) {
  const tx = getTransport();
  if (!tx) {
    const error = new Error('mail_not_configured');
    error.code = 'mail_not_configured';
    throw error;
  }
  await tx.sendMail({ from: mailSender(), to, subject, text, html });
}

export async function sendPasswordResetEmail({ to, name, link, expiresMinutes = 30 }) {
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const text = [
    greeting,
    '',
    'We received a request to reset the password for your WORKBRIDGE account.',
    `Open this link to choose a new password (it works once and expires in ${expiresMinutes} minutes):`,
    link,
    '',
    'If you did not ask for this, you can ignore this email — your password stays unchanged.',
    '',
    'WORKBRIDGE — Booking • Agreement • Institutional & Social Support • Invoice Maker'
  ].join('\n');

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0B1F3A;line-height:1.5">
    <p>${greeting}</p>
    <p>We received a request to reset the password for your WORKBRIDGE account.</p>
    <p><a href="${link}" style="display:inline-block;background:#0B1F3A;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
    <p style="font-size:13px;color:#555">This link works once and expires in ${expiresMinutes} minutes. If you did not ask for this, ignore this email — your password stays unchanged.</p>
    <p style="font-size:13px;color:#555">If the button does not work, copy this address into your browser:<br />${link}</p>
    <hr style="border:none;border-top:1px solid #eee" />
    <p style="font-size:12px;color:#777">WORKBRIDGE — Booking • Agreement • Institutional &amp; Social Support • Invoice Maker</p>
  </div>`;

  await sendMail({ to, subject: 'WORKBRIDGE — reset your password', text, html });
}
