/**
 * Transactional email for password recovery.
 *
 * Delivery itself lives in server/email.js, which supports a Resend API key
 * (no mailbox password needed) or any SMTP provider, and always sends from
 * MAIL_FROM. The Help & Support mailbox is never used as a recovery sender or
 * recipient.
 */

import { config } from './config.js';
import {
  emailConfigured,
  emailProvider,
  senderAddress,
  sendMail
} from './email.js';

export { emailProvider, sendMail };

export function mailConfigured() {
  return emailConfigured();
}

export function mailSender() {
  return senderAddress();
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

/** Diagnostics for the admin settings screen; never exposes credentials. */
export function mailStatus() {
  return {
    configured: mailConfigured(),
    provider: emailProvider(),
    sender: mailSender() || null,
    support_email_in_use: Boolean(
      mailSender() && mailSender().toLowerCase().includes(config.supportEmail.toLowerCase())
    )
  };
}
