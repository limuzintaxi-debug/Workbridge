import { Router } from 'express';
import crypto from 'node:crypto';
import { config, publicOrigin, supabaseAuthConfigured } from './config.js';
import {
  data,
  persist,
  getSettings,
  saveSettings,
  createAdmin,
  adminExists,
  audit,
  storeInfo
} from './store.js';
import { hashPassword, verifyPassword, requireRole, setSessionCookie } from './security.js';
import { mailConfigured, mailStatus, sendPasswordResetEmail } from './mail.js';
import { getLastEmailAttempt } from './email.js';
import { CURRENCY_CATALOG, DEFAULT_CURRENCY, isValidCurrency } from './currency.js';
import { auth as supaAuth, uploadDocument, signedDocumentUrl, persistenceDriver } from './supabase.js';
import { buildAgreementPdf, buildInvoicePdf } from './pdf.js';
import { isEmail, str, nowIso } from './util.js';

const router = Router();
const RESET_TTL_MS = config.resetTtlMs;
const id = () => crypto.randomUUID();

const fail = (res, status, error, message) => res.status(status).json({ error, message });
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/* -------------------------------------------------------------- currencies */

router.get('/currencies', (req, res) => {
  const settings = getSettings();
  res.json({
    catalog: CURRENCY_CATALOG,
    default: settings.currency.default,
    enabled: CURRENCY_CATALOG.filter((c) => settings.currency.enabled.includes(c.code)),
    all: CURRENCY_CATALOG.map((c) => c.code)
  });
});

/* ------------------------------------------------------------ setup status */

router.get('/setup/status', (req, res) => {
  const settings = getSettings();
  res.json({
    setup_required: !adminExists(),
    setup_token_required: Boolean(config.setupToken),
    persistence_driver: persistenceDriver(),
    auth_driver: supabaseAuthConfigured() ? 'supabase-auth' : 'local',
    supabase_configured: Boolean(config.supabaseUrl && config.supabaseServiceKey),
    currency: settings.currency,
    languages: settings.languages,
    registration: settings.registration
  });
});

router.post('/setup/admin', (req, res) => {
  if (adminExists()) {
    return fail(res, 409, 'already_configured', 'An administrator account already exists.');
  }
  const body = req.body || {};
  if (config.setupToken && str(body.setup_token, 200) !== config.setupToken) {
    return fail(res, 403, 'invalid_setup_token', 'The setup token is missing or incorrect.');
  }
  const email = str(body.email, 160).toLowerCase();
  const password = String(body.password || '');
  const fullName = str(body.full_name, 120) || 'Administrator';
  if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < 10) {
    return fail(res, 400, 'weak_password', 'Use at least 10 characters for the administrator password.');
  }

  const user = createAdmin({ email, password, fullName, phone: str(body.phone, 40) });
  audit(user.id, 'setup.admin_created', email);
  persist();
  setSessionCookie(req, res, user);
  res.status(201).json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
});

/* -------------------------------------------------------- password recovery */

router.post('/auth/forgot-password', async (req, res) => {
  const email = str((req.body || {}).email, 160).toLowerCase();
  const generic = {
    ok: true,
    message: 'If an account exists for that email, a reset link has been sent.'
  };
  if (!isEmail(email)) return res.json(generic);

  // Recovery mail is sent by WORKBRIDGE's own provider to the account's own
  // registered address. Supabase Auth is deliberately not used here: WORKBRIDGE
  // accounts live in the app's user store, so GoTrue has no identity to mail and
  // would answer 200 while sending nothing. This check is global and never
  // account-specific, so it cannot reveal which emails are registered.
  if (!mailConfigured()) {
    return fail(
      res,
      503,
      'email_not_configured',
      'Password recovery email is not configured yet, so no reset link can be sent. Please contact WORKBRIDGE support.'
    );
  }

  const user = data().users.find((u) => u.email === email);
  // No account, so nothing was sent. The wording stays neutral, but the client
  // is told the truth instead of showing a green "sent" for a typo or an
  // address that was never registered.
  if (!user) return res.json({ ...generic, email_sent: false, account_found: false });

  // A single-use, sha256-hashed token that expires after 30 minutes.
  const token = crypto.randomBytes(32).toString('hex');
  data().resetTokens = data().resetTokens.filter(
    (t) => new Date(t.expires_at).getTime() > Date.now() && !t.used_at
  );
  data().resetTokens.unshift({
    id: id(),
    user_id: user.id,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
    used_at: null,
    created_at: nowIso()
  });
  persist();

  const link = `${publicOrigin(req)}/#/reset-password?token=${token}`;

  // Deliver the single-use link to the account holder's own inbox only. The
  // generic wording above is kept so the endpoint never reveals which emails
  // have accounts.
  let delivery = null;
  try {
    delivery = await sendPasswordResetEmail({
      to: user.email,
      name: user.full_name,
      link,
      expiresMinutes: Math.max(1, Math.round(RESET_TTL_MS / 60000))
    });
  } catch (error) {
    console.error('[workbridge] password reset email failed:', error.message);
    // Answered as a normal JSON response, not a 5xx: an edge proxy replaces a
    // 502 body with its own error page, which would hide the reason from the
    // user. email_sent:false is explicit, and the real cause travels with it.
    return res.json({
      ...generic,
      email_sent: false,
      account_found: true,
      delivery_error: error.code || 'email_failed',
      message: `The reset email could not be delivered. ${error.message}`
    });
  }

  return res.json({
    ...generic,
    email_sent: true,
    account_found: true,
    delivery: delivery
      ? {
          provider: delivery.provider,
          sender: delivery.sender,
          fallback_sender: Boolean(delivery.fallback_sender)
        }
      : null
  });
});

router.post('/auth/reset-password', async (req, res) => {
  const body = req.body || {};
  const password = String(body.password || '');
  if (password.length < 8) {
    return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.');
  }

  if (body.access_token && supabaseAuthConfigured()) {
    try {
      await supaAuth.updatePassword(String(body.access_token), password);
    } catch (error) {
      return fail(res, 400, 'reset_failed', 'That reset link is invalid or has expired.');
    }
    const user = data().users.find((u) => u.email === str(body.email, 160).toLowerCase());
    if (user) {
      user.password_hash = hashPassword(password);
      user.session_epoch = (user.session_epoch || 0) + 1;
      persist();
    }
    return res.json({ ok: true, message: 'Password updated. You can sign in now.' });
  }

  const token = str(body.token, 200);
  if (!token) return fail(res, 400, 'missing_token', 'The reset link is incomplete.');
  const hash = sha256(token);
  const record = data().resetTokens.find((t) => t.token_hash === hash && !t.used_at);
  if (!record) return fail(res, 400, 'invalid_token', 'That reset link is invalid or already used.');
  if (new Date(record.expires_at).getTime() < Date.now()) {
    return fail(res, 400, 'expired_token', 'That reset link has expired. Request a new one.');
  }

  const user = data().users.find((u) => u.id === record.user_id);
  if (!user) return fail(res, 400, 'invalid_token', 'That reset link is invalid.');

  user.password_hash = hashPassword(password);
  user.session_epoch = (user.session_epoch || 0) + 1;
  record.used_at = nowIso();
  audit(user.id, 'auth.password_reset', user.email);
  persist();
  return res.json({ ok: true, message: 'Password updated. You can sign in now.' });
});

router.patch('/auth/password', requireRole('worker', 'business', 'admin'), (req, res) => {
  const body = req.body || {};
  const current = String(body.current_password || '');
  const next = String(body.new_password || '');
  const user = data().users.find((u) => u.id === req.user.id);
  if (!user || !verifyPassword(current, user.password_hash)) {
    return fail(res, 400, 'invalid_current_password', 'Your current password is incorrect.');
  }
  if (next.length < 8) return fail(res, 400, 'weak_password', 'Use at least 8 characters.');
  user.password_hash = hashPassword(next);
  user.session_epoch = (user.session_epoch || 0) + 1;
  audit(user.id, 'auth.password_changed', user.email);
  persist();
  setSessionCookie(req, res, user);
  res.json({ ok: true, message: 'Password updated.' });
});

/* --------------------------------------------- admin: password reset help */

// Fallback when a worker or business cannot complete self-service recovery:
// the administrator issues a single-use link (never sets a password directly).
router.post('/admin/users/:id/reset-link', requireRole('admin'), async (req, res) => {
  const db = data();
  const user = db.users.find((u) => u.id === req.params.id && u.role !== 'admin');
  if (!user) return fail(res, 404, 'not_found', 'Account not found.');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  db.resetTokens = db.resetTokens.filter(
    (t) => new Date(t.expires_at).getTime() > Date.now() && !t.used_at
  );
  db.resetTokens.unshift({
    id: id(),
    user_id: user.id,
    token_hash: sha256(token),
    expires_at: expiresAt,
    used_at: null,
    created_at: nowIso(),
    issued_by: req.user.id
  });
  audit(req.user.id, 'admin.password_reset_issued', user.email);
  persist();

  const resetUrl = `${publicOrigin(req)}/#/reset-password?token=${token}`;
  let emailed = false;
  let delivery = null;
  let deliveryError = null;
  if (mailConfigured()) {
    try {
      delivery = await sendPasswordResetEmail({
        to: user.email,
        name: user.full_name,
        link: resetUrl,
        expiresMinutes: Math.round(RESET_TTL_MS / 60000)
      });
      emailed = true;
    } catch (error) {
      deliveryError = error.message;
      console.error('[workbridge] admin reset email failed:', error.message);
    }
  }

  res.json({
    ok: true,
    email: user.email,
    expires_at: expiresAt,
    email_sent: emailed,
    delivery: emailed && delivery ? { provider: delivery.provider, sender: delivery.sender } : null,
    delivery_error: deliveryError,
    reset_url: resetUrl,
    message: emailed
      ? 'A single-use reset link was emailed to the account holder. It expires in 30 minutes.'
      : 'No email was delivered, so no link reached the account holder. Share the single-use link below; it expires in 30 minutes.'
  });
});

/* ------------------------------------------------------- admin: settings */

router.get('/admin/settings', requireRole('admin'), (req, res) => {
  res.json({
    settings: getSettings(),
    currencies: CURRENCY_CATALOG,
    drivers: storeInfo(),
    setup: {
      admin_exists: adminExists(),
      supabase_configured: Boolean(config.supabaseUrl && config.supabaseServiceKey),
      supabase_auth: supabaseAuthConfigured(),
      mail_configured: mailConfigured(),
      mail: mailStatus(),
      mail_last_attempt: getLastEmailAttempt(),
      app_url: config.appUrl || null
    }
  });
});

router.put('/admin/settings/currency', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const defaultCurrency = str(body.default, 8).toUpperCase();
  const enabled = Array.isArray(body.enabled)
    ? [...new Set(body.enabled.map((c) => str(c, 8).toUpperCase()))].filter(isValidCurrency)
    : getSettings().currency.enabled;

  if (!isValidCurrency(defaultCurrency)) {
    return fail(res, 400, 'invalid_currency', 'Choose a supported default currency.');
  }
  if (!enabled.length) {
    return fail(res, 400, 'no_currencies', 'Enable at least one currency.');
  }
  if (!enabled.includes(defaultCurrency)) {
    return fail(res, 400, 'default_not_enabled', 'The default currency must be one of the enabled currencies.');
  }

  const settings = saveSettings({ currency: { default: defaultCurrency, enabled } });
  audit(req.user.id, 'settings.currency_updated', defaultCurrency, { enabled });
  persist();
  res.json({ currency: settings.currency });
});

router.put('/admin/settings/registration', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const worker = str(body.worker, 10);
  const business = str(body.business, 10);
  for (const value of [worker, business]) {
    if (!['auto', 'review'].includes(value)) {
      return fail(res, 400, 'invalid_mode', 'Choose automatic approval or admin review.');
    }
  }
  const settings = saveSettings({ registration: { worker, business } });
  audit(req.user.id, 'settings.registration_updated', `${worker}/${business}`);
  persist();
  res.json({ registration: settings.registration });
});

router.get('/admin/audit', requireRole('admin'), (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ entries: data().auditLog.slice(0, limit) });
});

/* --------------------------------------------------------------- PDF files */

async function storeDocument(bucket, objectPath, buffer) {
  if (persistenceDriver() !== 'supabase') return null;
  try {
    const path = await uploadDocument(bucket, objectPath, buffer, 'application/pdf');
    return path;
  } catch (error) {
    console.error('[workbridge] document upload failed:', error.message);
    return null;
  }
}

router.get('/agreements/:id/pdf', requireRole('worker', 'business', 'admin'), async (req, res) => {
  const agreement = data().agreements.find((a) => a.id === req.params.id);
  if (!agreement) return fail(res, 404, 'not_found', 'Agreement not found.');

  const participant =
    req.user.role === 'admin' ||
    agreement.worker_id === req.user.id ||
    agreement.business_id === req.user.id;
  if (!participant) return fail(res, 403, 'forbidden', 'You cannot download this agreement.');

  const db = data();
  const worker = db.users.find((u) => u.id === agreement.worker_id);
  const business = db.users.find((u) => u.id === agreement.business_id);
  const businessProfile = db.businessProfiles.find((b) => b.user_id === agreement.business_id);
  const workerProfile = db.workerProfiles.find((w) => w.user_id === agreement.worker_id);

  const view = {
    ...agreement,
    worker: {
      full_name: worker?.full_name || 'Worker',
      phone: worker?.phone || '',
      category: workerProfile?.category || '',
      aqama_masked: workerProfile?.aqama_masked || null
    },
    business: {
      company_name: businessProfile?.company_name || business?.full_name || 'Business',
      contact_name: businessProfile?.contact_name || '',
      phone: businessProfile?.phone || business?.phone || '',
      address: businessProfile?.address || '',
      country: businessProfile?.country || ''
    }
  };

  const buffer = buildAgreementPdf(view);
  const objectPath = `agreements/${agreement.ref || agreement.id}.pdf`;
  const stored = await storeDocument('agreements', objectPath, buffer);
  if (stored && agreement.pdf_path !== stored) {
    agreement.pdf_path = stored;
    agreement.pdf_generated_at = nowIso();
    persist();
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${objectPath.split('/').pop()}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  return res.end(buffer);
});

router.get('/invoices/:id/pdf', requireRole('worker', 'business', 'admin'), async (req, res) => {
  const invoice = data().invoices.find((i) => i.id === req.params.id);
  if (!invoice) return fail(res, 404, 'not_found', 'Invoice not found.');
  if (req.user.role !== 'admin' && invoice.issuer_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'You cannot download this invoice.');
  }

  const buffer = buildInvoicePdf(invoice);
  const objectPath = `invoices/${invoice.serial || invoice.id}.pdf`;
  const stored = await storeDocument('invoices', objectPath, buffer);
  if (stored && invoice.pdf_path !== stored) {
    invoice.pdf_path = stored;
    invoice.pdf_generated_at = nowIso();
    persist();
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${objectPath.split('/').pop()}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  return res.end(buffer);
});

/** Signed, expiring link for a stored document (Supabase Storage only). */
router.get('/documents/link', requireRole('worker', 'business', 'admin'), async (req, res) => {
  const bucket = str(req.query.bucket, 30);
  const objectPath = str(req.query.path, 300);
  if (!['agreements', 'invoices'].includes(bucket) || !objectPath) {
    return fail(res, 400, 'invalid_request', 'Bucket and path are required.');
  }
  if (persistenceDriver() !== 'supabase') {
    return fail(res, 409, 'storage_unavailable', 'Supabase Storage is not configured.');
  }
  const url = await signedDocumentUrl(bucket, objectPath).catch(() => null);
  if (!url) return fail(res, 404, 'not_found', 'Document not found in storage.');
  res.json({ url });
});

export default router;
