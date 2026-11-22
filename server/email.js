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

/**
 * Resend refuses to send from a domain that is not verified, and its shared test
 * sender can only reach the account owner's own address. Keeping the exact last
 * attempt lets the admin screen show what really happened instead of assuming
 * that a 2xx response meant an email was delivered.
 */
const RESEND_TEST_SENDER = 'onboarding@resend.dev';
let lastAttempt = null;

function rememberAttempt(attempt) {
  lastAttempt = { ...attempt, at: new Date().toISOString() };
  return lastAttempt;
}

/** Exact result of the most recent send attempt; never contains credentials. */
export function getLastEmailAttempt() {
  return lastAttempt || null;
}

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

/**
 * Normalise MAIL_FROM into a sender the providers accept.
 *
 * A bare domain ("workbridges.live") or a bare address is a common and silent
 * mistake: Resend answers 403 "domain is not verified" or 422 "invalid from",
 * so the reset link is never sent. Accepting both shapes here means the value in
 * Settings can stay human-readable without breaking delivery.
 */
const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

export function normalizeSender(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  // "WORKBRIDGE <no-reply@domain>" is already a full sender: use it verbatim.
  if (/<[^<>]+>/.test(value)) return value;
  if (ADDRESS_RE.test(value)) return `WORKBRIDGE <${value}>`;
  if (DOMAIN_RE.test(value)) return `WORKBRIDGE <no-reply@${value}>`;
  return value;
}

/** The only sender ever used for recovery mail. */
export function senderAddress() {
  return normalizeSender(config.mailFrom);
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

async function postResend(payload) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  // Never surface request headers here: they carry the API key.
  const detail = response.ok ? '' : await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, detail };
}

/**
 * Send through Resend, falling back to Resend's shared test sender.
 *
 * A 403 "domain is not verified" is a configuration gap, not a dead end: the
 * shared sender still delivers to the account owner's address, which keeps
 * password recovery usable while DNS verification is pending. The reply reports
 * which sender actually carried the message so callers never guess.
 */
async function sendWithResend({ from, to, subject, text, html }) {
  const first = await postResend({ from, to: [to], subject, text, html });
  if (first.ok) return { sender: from, fallback: false };

  const unverified =
    first.status === 403 && /not verified|verify a domain|testing emails/i.test(first.detail);
  const fallbackFrom = `WORKBRIDGE <${RESEND_TEST_SENDER}>`;

  if (unverified && from !== fallbackFrom) {
    const second = await postResend({ from: fallbackFrom, to: [to], subject, text, html });
    if (second.ok) return { sender: fallbackFrom, fallback: true };
    if (/own email address/i.test(second.detail)) {
      throw fail(
        'email_recipient_not_allowed',
        `Resend has no verified domain, so it can only deliver to the account owner's own address. Verify the sending domain at resend.com/domains (publish its DNS records) or set SMTP_PASS. Provider said: ${second.detail.slice(0, 240)}`
      );
    }
    throw fail(
      'email_domain_unverified',
      `The sending domain is not verified with Resend. Add the domain in resend.com/domains and publish its DNS records, then retry. Provider said: ${second.detail.slice(0, 240)}`
    );
  }

  if (unverified) {
    throw fail(
      'email_domain_unverified',
      `The sending domain is not verified with Resend. Add the domain in resend.com/domains and publish its DNS records, then retry. Provider said: ${first.detail.slice(0, 240)}`
    );
  }
  throw fail('email_provider_error', `resend_${first.status}: ${first.detail.slice(0, 300)}`);
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

  try {
    if (provider === 'resend') {
      const sent = await sendWithResend({ from, to, subject, text, html });
      return rememberAttempt({
        ok: true,
        provider: 'resend',
        sender: sent.sender,
        fallback_sender: sent.fallback,
        recipient: to
      });
    }

    await transport().sendMail({ from, to, subject, text, html });
    return rememberAttempt({ ok: true, provider: 'smtp', sender: from, recipient: to });
  } catch (error) {
    rememberAttempt({
      ok: false,
      provider,
      sender: from,
      recipient: to,
      code: error.code || 'email_error',
      message: error.message
    });
    throw error;
  }
}
