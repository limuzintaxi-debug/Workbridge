/**
 * Email delivery for WORKBRIDGE password recovery.
 *
 * Two providers, and neither one uses the Help & Support mailbox:
 *
 *   1. Resend HTTP API (recommended — no mailbox password involved)
 *        RESEND_API_KEY=re_xxxxxxxx
 *        MAIL_FROM="WORKBRIDGE <no-reply@your-domain>"
 *
 *   2. Any SMTP provider you control
 *        SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *        MAIL_FROM="WORKBRIDGE <no-reply@your-domain>"
 *
 * Recovery mail is always addressed to the account's own registered email, and
 * the sender is always MAIL_FROM. There is deliberately no fallback to
 * SMTP_USER or to config.supportEmail, so the support inbox is never used as a
 * recovery sender or recipient.
 *
 * EMAIL_CAPTURE_DIR is a non-production test hook: it writes messages to
 * outbox.jsonl instead of sending, so the whole flow can be verified without
 * real provider credentials. It is ignored when NODE_ENV=production.
 */
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';

let smtpTransport = null;

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

function smtpReady() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

/** Which delivery path is active: 'resend' | 'smtp' | 'capture' | 'none'. */
export function emailProvider() {
  if (config.emailCaptureDir && config.nodeEnv !== 'production') return 'capture';
  if (config.emailProvider === 'resend') return config.resendApiKey ? 'resend' : 'none';
  if (config.emailProvider === 'smtp') return smtpReady() ? 'smtp' : 'none';
  if (config.resendApiKey) return 'resend';
  if (smtpReady()) return 'smtp';
  return 'none';
}

export function emailConfigured() {
  return emailProvider() !== 'none';
}

/** The only sender ever used for recovery mail. */
export function senderAddress() {
  return config.mailFrom || '';
}

function transport() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPass },
      ...(config.smtpSecure ? {} : { requireTLS: true })
    });
  }
  return smtpTransport;
}

async function sendWithResend({ from, to, subject, text, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Never include request headers here: they carry the API key.
    throw fail('email_provider_error', `resend_${response.status}: ${detail.slice(0, 300)}`);
  }
}

export async function sendMail({ to, subject, text, html }) {
  const provider = emailProvider();
  if (provider === 'none') {
    throw fail(
      'email_not_configured',
      'No email provider is configured. Set RESEND_API_KEY or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS plus MAIL_FROM.'
    );
  }

  const from = senderAddress();

  if (provider === 'capture') {
    const dir = config.emailCaptureDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'outbox.jsonl'),
      `${JSON.stringify({ from: from || '(unset)', to, subject, text, at: new Date().toISOString() })}\n`
    );
    return { captured: true };
  }

  if (!from) {
    throw fail('email_sender_missing', 'MAIL_FROM must be set to the verified sender address.');
  }

  if (provider === 'resend') {
    await sendWithResend({ from, to, subject, text, html });
    return { provider: 'resend' };
  }

  await transport().sendMail({ from, to, subject, text, html });
  return { provider: 'smtp' };
}
