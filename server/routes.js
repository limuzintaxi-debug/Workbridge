import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { data, persist, nextCounter, storeInfo } from './store.js';
import {
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  requireRole
} from './security.js';
import { publicUser, profileFor } from './middleware.js';
import { persistenceDriver, supabaseConfigured } from './supabase.js';
import { inScope } from './scope.js';
import {
  CATEGORIES,
  INSTITUTION_TYPES,
  PAY_PERIODS,
  ageBucket,
  maskAqama,
  round2,
  nowIso,
  isEmail,
  str,
  num
} from './util.js';
import { isValidCurrency, DEFAULT_CURRENCY } from './currency.js';
import {
  currentCommission,
  commissionQuote,
  isValidRate,
  normalizeRate,
  recordCommission,
  commissionLedger,
  commissionSummary
} from './commission.js';

const router = Router();

/* ------------------------------------------------------------------ helpers */

const id = () => crypto.randomUUID();

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function notify(userId, title, body, link) {
  data().notifications.unshift({
    id: id(),
    user_id: userId,
    title,
    body,
    link: link || null,
    read_at: null,
    created_at: nowIso()
  });
}

function sessionPayload(user) {
  return { user: publicUser(user, profileFor(user)) };
}

function jobView(job, viewer) {
  const db = data();
  const business = db.businessProfiles.find((b) => b.user_id === job.business_id);
  const owner = db.users.find((u) => u.id === job.business_id);
  const applications = db.applications.filter((a) => a.job_id === job.id);
  const bucket = ageBucket(job.created_at);
  return {
    id: job.id,
    title: job.title,
    category: job.category,
    description: job.description,
    location: job.location,
    pay_amount: job.pay_amount,
    pay_period: job.pay_period,
    requirements: job.requirements,
    status: job.status,
    created_at: job.created_at,
    closed_at: job.closed_at || null,
    age_bucket: bucket.key,
    age_label: bucket.label,
    hours_old: bucket.hours,
    business: {
      id: job.business_id,
      company_name: business?.company_name || 'Business',
      contact_name: business?.contact_name || owner?.full_name || '',
      country: business?.country || '',
      // Workers contact the business directly about a vacancy.
      phone: business?.phone || owner?.phone || ''
    },
    application_count: applications.length,
    my_application:
      viewer && viewer.role === 'worker'
        ? applications.find((a) => a.worker_id === viewer.id) || null
        : null
  };
}

function agreementView(agreement, viewer) {
  const db = data();
  const worker = db.users.find((u) => u.id === agreement.worker_id);
  const business = db.users.find((u) => u.id === agreement.business_id);
  const businessProfile = db.businessProfiles.find((b) => b.user_id === agreement.business_id);
  const workerProfile = db.workerProfiles.find((w) => w.user_id === agreement.worker_id);
  const job = agreement.job_id ? db.jobs.find((j) => j.id === agreement.job_id) : null;
  return {
    ...agreement,
    worker: {
      id: agreement.worker_id,
      full_name: worker?.full_name || 'Worker',
      phone: worker?.phone || '',
      category: workerProfile?.category || '',
      aqama_masked: workerProfile?.aqama_masked || null
    },
    business: {
      id: agreement.business_id,
      company_name: businessProfile?.company_name || business?.full_name || 'Business',
      contact_name: businessProfile?.contact_name || business?.full_name || '',
      phone: businessProfile?.phone || business?.phone || '',
      address: businessProfile?.address || '',
      country: businessProfile?.country || ''
    },
    job: job ? { id: job.id, title: job.title, category: job.category } : null,
    can_sign:
      !!viewer &&
      ((viewer.role === 'worker' && viewer.id === agreement.worker_id) ||
        (viewer.role === 'business' && viewer.id === agreement.business_id)) &&
      !agreement.signatures?.[viewer.role]
  };
}

function invoiceView(invoice) {
  // Commission is administrator-only bookkeeping. An invoice never carries or
  // displays commission fields.
  const {
    commission_applied,
    commission_rate,
    commission_amount,
    commission_payer,
    ...rest
  } = invoice;
  return rest;
}

/* --------------------------------------------------------------------- meta */

router.get('/health', (req, res) => {
  const info = storeInfo();
  const missingTables = info.sync.missing_tables || [];
  // Single source of truth for /api/health. `driver` is the intended backend and
  // `sync.last_error` is what the database actually answered on the last write,
  // so `degraded` is false only while writes really are reaching storage.
  const persistence = {
    driver: info.driver,
    auth_driver: info.auth_driver,
    degraded: info.degraded,
    degraded_reason: info.degraded_reason,
    missing_tables: missingTables
  };
  // Always HTTP 200: the container is up and serving, and a non-200 here would
  // fail the hosting health check. `status: 'degraded'` plus `ok: false` report
  // that Supabase is not storing every collection, so a JSON-cache fallback
  // stays visible to monitoring instead of looking like a healthy app.
  res.json({
    ok: !info.degraded,
    status: info.degraded ? 'degraded' : 'ok',
    service: 'workbridge',
    time: nowIso(),
    persistence,
    supabase_configured: supabaseConfigured(),
    storage: {
      driver: info.driver,
      degraded: info.degraded,
      missing_tables: missingTables,
      last_synced_at: info.sync.last_synced_at,
      last_error: info.sync.last_error,
      fallback_file: info.file
    }
  });
});

router.get('/meta', (req, res) => {
  const settings = data().settings;
  res.json({
    categories: CATEGORIES,
    institution_types: INSTITUTION_TYPES,
    pay_periods: PAY_PERIODS,
    support_email: config.supportEmail,
    commission: currentCommission(),
    currency: settings.currency,
    default_currency: settings.currency.default,
    languages: settings.languages,
    registration: settings.registration
  });
});

router.get('/support', (req, res) => {
  res.json({ email: config.supportEmail });
});

/* --------------------------------------------------------------------- auth */

router.post('/auth/register', (req, res) => {
  const body = req.body || {};
  const role = str(body.role, 20);
  if (!['worker', 'business'].includes(role)) {
    return fail(
      res,
      403,
      'role_not_allowed',
      'Admin accounts cannot be created here. Please contact support.'
    );
  }

  const email = str(body.email, 160).toLowerCase();
  const password = String(body.password || '');
  const fullName = str(body.full_name, 120);
  const phone = str(body.phone, 40);

  if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < 8)
    return fail(res, 400, 'weak_password', 'Password must be at least 8 characters.');
  if (!fullName) return fail(res, 400, 'missing_name', 'Full name is required.');
  if (!phone) return fail(res, 400, 'missing_phone', 'Phone number is required.');

  const db = data();
  if (db.users.some((u) => u.email === email)) {
    return fail(res, 409, 'email_taken', 'An account with this email already exists.');
  }

  const user = {
    id: id(),
    role,
    email,
    password_hash: hashPassword(password),
    full_name: fullName,
    phone,
    status: data().settings.registration[role] === 'review' ? 'pending' : 'active',
    created_at: nowIso()
  };

  if (role === 'worker') {
    const category = str(body.category, 60);
    if (!CATEGORIES.includes(category)) {
      return fail(res, 400, 'invalid_category', 'Choose a valid work category.');
    }
    db.workerProfiles.push({
      user_id: user.id,
      category,
      aqama_masked: maskAqama(body.aqama),
      city: str(body.city, 120),
      country: str(body.country, 80),
      experience_years: Math.max(0, Math.min(60, num(body.experience_years, 0))),
      skills: Array.isArray(body.skills)
        ? body.skills.map((s) => str(s, 60)).filter(Boolean).slice(0, 20)
        : str(body.skills, 400)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 20),
      bio: str(body.bio, 1000),
      available: true
    });
  } else {
    const companyName = str(body.company_name, 160) || fullName;
    db.businessProfiles.push({
      user_id: user.id,
      company_name: companyName,
      contact_name: fullName,
      phone,
      country: str(body.country, 80),
      address: str(body.address, 300),
      website: str(body.website, 200),
      about: str(body.about, 1000)
    });
  }

  db.users.push(user);
  persist();
  if (user.status === 'pending') {
    return res.status(201).json({
      ok: true,
      status: 'pending',
      message: 'Your registration was received and is awaiting administrator approval.'
    });
  }
  setSessionCookie(req, res, user);
  return res.status(201).json(sessionPayload(user));
});

router.post('/auth/login', (req, res) => {
  const email = str((req.body || {}).email, 160).toLowerCase();
  const password = String((req.body || {}).password || '');
  const db = data();
  const user = db.users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return fail(res, 401, 'invalid_credentials', 'Email or password is incorrect.');
  }
  if (user.status === 'pending') {
    return fail(res, 403, 'pending_approval', 'Your registration is awaiting administrator approval.');
  }
  if (user.status === 'rejected') {
    return fail(res, 403, 'registration_rejected', 'This registration was not approved. Please contact support.');
  }
  if (user.status !== 'active') {
    return fail(res, 403, 'account_suspended', 'This account is suspended. Please contact support.');
  }
  setSessionCookie(req, res, user);
  return res.json(sessionPayload(user));
});

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  return res.json(sessionPayload(req.user));
});

router.patch('/auth/profile', requireRole('worker', 'business'), (req, res) => {
  const body = req.body || {};
  const db = data();
  const user = db.users.find((u) => u.id === req.user.id);
  if (body.full_name) user.full_name = str(body.full_name, 120);
  if (body.phone) user.phone = str(body.phone, 40);

  if (user.role === 'worker') {
    const profile = db.workerProfiles.find((p) => p.user_id === user.id);
    if (profile) {
      if (body.category && CATEGORIES.includes(str(body.category, 60))) {
        profile.category = str(body.category, 60);
      }
      if (body.aqama !== undefined) profile.aqama_masked = maskAqama(body.aqama);
      if (body.city !== undefined) profile.city = str(body.city, 120);
      if (body.country !== undefined) profile.country = str(body.country, 80);
      if (body.bio !== undefined) profile.bio = str(body.bio, 1000);
      if (body.experience_years !== undefined) {
        profile.experience_years = Math.max(0, Math.min(60, num(body.experience_years, 0)));
      }
      if (body.available !== undefined) profile.available = Boolean(body.available);
      if (body.skills !== undefined) {
        profile.skills = (Array.isArray(body.skills) ? body.skills : String(body.skills).split(','))
          .map((s) => str(s, 60))
          .filter(Boolean)
          .slice(0, 20);
      }
    }
  } else {
    const profile = db.businessProfiles.find((p) => p.user_id === user.id);
    if (profile) {
      if (body.company_name) profile.company_name = str(body.company_name, 160);
      if (body.contact_name) profile.contact_name = str(body.contact_name, 120);
      if (body.phone) profile.phone = str(body.phone, 40);
      if (body.country !== undefined) profile.country = str(body.country, 80);
      if (body.address !== undefined) profile.address = str(body.address, 300);
      if (body.website !== undefined) profile.website = str(body.website, 200);
      if (body.about !== undefined) profile.about = str(body.about, 1000);
    }
  }
  persist();
  res.json(sessionPayload(user));
});

/* --------------------------------------------------------------------- jobs */

router.get('/jobs', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  const status = str(req.query.status, 20) || 'open';
  const category = str(req.query.category, 60);
  const q = str(req.query.q, 120).toLowerCase();

  let jobs = [...db.jobs];
  if (status !== 'all') jobs = jobs.filter((j) => j.status === status);
  if (category) jobs = jobs.filter((j) => j.category === category);
  if (q) {
    jobs = jobs.filter(
      (j) =>
        j.title.toLowerCase().includes(q) ||
        j.description.toLowerCase().includes(q) ||
        j.location.toLowerCase().includes(q)
    );
  }
  jobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ jobs: jobs.map((j) => jobView(j, req.user)) });
});

router.get('/jobs/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const job = data().jobs.find((j) => j.id === req.params.id);
  if (!job) return fail(res, 404, 'not_found', 'Listing not found.');
  const view = jobView(job, req.user);
  const isOwner = req.user.role === 'business' && job.business_id === req.user.id;
  if (isOwner || req.user.role === 'admin') {
    view.applications = data()
      .applications.filter((a) => a.job_id === job.id)
      .map((a) => {
        const worker = data().users.find((u) => u.id === a.worker_id);
        const profile = data().workerProfiles.find((p) => p.user_id === a.worker_id);
        return {
          ...a,
          worker_name: worker?.full_name || 'Worker',
          worker_phone: worker?.phone || '',
          worker_category: profile?.category || '',
          worker_city: profile?.city || ''
        };
      });
  }
  res.json({ job: view });
});

router.post('/jobs', requireRole('business'), (req, res) => {
  const body = req.body || {};
  const title = str(body.title, 160);
  const category = str(body.category, 60);
  const description = str(body.description, 4000);
  if (!title) return fail(res, 400, 'missing_title', 'Listing title is required.');
  if (!CATEGORIES.includes(category))
    return fail(res, 400, 'invalid_category', 'Choose a valid work category.');
  if (!description) return fail(res, 400, 'missing_description', 'Description is required.');

  const db = data();
  const job = {
    id: id(),
    business_id: req.user.id,
    title,
    category,
    description,
    location: str(body.location, 160),
    pay_amount: round2(num(body.pay_amount, 0)),
    pay_period: PAY_PERIODS.includes(str(body.pay_period, 20))
      ? str(body.pay_period, 20)
      : 'day',
    currency: isValidCurrency(str(body.currency, 8).toUpperCase())
      ? str(body.currency, 8).toUpperCase()
      : db.settings.currency.default,
    requirements: str(body.requirements, 1000),
    status: 'open',
    created_at: nowIso(),
    closed_at: null
  };
  db.jobs.unshift(job);

  // Notify workers whose category matches the new listing.
  for (const profile of db.workerProfiles) {
    if (profile.category !== category) continue;
    const worker = db.users.find((u) => u.id === profile.user_id && u.status === 'active');
    if (!worker) continue;
    notify(worker.id, `New ${category} listing`, `${title} was just posted.`, `#/worker/jobs/${job.id}`);
  }

  persist();
  res.status(201).json({ job: jobView(job, req.user) });
});

router.patch('/jobs/:id', requireRole('business', 'admin'), (req, res) => {
  const db = data();
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return fail(res, 404, 'not_found', 'Listing not found.');
  if (req.user.role !== 'admin' && job.business_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'You can only manage your own listings.');
  }
  const status = str((req.body || {}).status, 20);
  const allowed = req.user.role === 'admin' ? ['open', 'closed', 'removed'] : ['open', 'closed'];
  if (!allowed.includes(status)) {
    return fail(res, 400, 'invalid_status', 'That status change is not allowed.');
  }
  job.status = status;
  job.closed_at = status === 'open' ? null : nowIso();
  persist();
  res.json({ job: jobView(job, req.user) });
});

/* ------------------------------------------------------------- applications */

router.post('/jobs/:id/apply', requireRole('worker'), (req, res) => {
  const db = data();
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return fail(res, 404, 'not_found', 'Listing not found.');
  if (job.status !== 'open') return fail(res, 409, 'job_closed', 'This listing is no longer open.');
  if (db.applications.some((a) => a.job_id === job.id && a.worker_id === req.user.id)) {
    return fail(res, 409, 'already_applied', 'You have already applied for this listing.');
  }
  const application = {
    id: id(),
    job_id: job.id,
    worker_id: req.user.id,
    message: str((req.body || {}).message, 1000),
    status: 'pending',
    created_at: nowIso()
  };
  db.applications.unshift(application);
  notify(
    job.business_id,
    'New application received',
    `${req.user.full_name} applied for ${job.title}.`,
    `#/business/applications`
  );
  persist();
  res.status(201).json({ application });
});

router.get('/applications', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  let list = db.applications;
  if (req.user.role === 'worker') list = list.filter((a) => a.worker_id === req.user.id);
  if (req.user.role === 'business') {
    const own = new Set(db.jobs.filter((j) => j.business_id === req.user.id).map((j) => j.id));
    list = list.filter((a) => own.has(a.job_id));
  }
  const enriched = list.map((a) => {
    const job = db.jobs.find((j) => j.id === a.job_id);
    const worker = db.users.find((u) => u.id === a.worker_id);
    const profile = db.workerProfiles.find((p) => p.user_id === a.worker_id);
    return {
      ...a,
      job_title: job?.title || 'Listing removed',
      job_category: job?.category || '',
      job_status: job?.status || 'removed',
      business_id: job?.business_id || null,
      worker_name: worker?.full_name || 'Worker',
      worker_phone: req.user.role === 'worker' ? worker?.phone || '' : worker?.phone || '',
      worker_category: profile?.category || '',
      worker_city: profile?.city || ''
    };
  });
  enriched.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ applications: enriched });
});

router.patch('/applications/:id', requireRole('worker', 'business'), (req, res) => {
  const db = data();
  const application = db.applications.find((a) => a.id === req.params.id);
  if (!application) return fail(res, 404, 'not_found', 'Application not found.');
  const job = db.jobs.find((j) => j.id === application.job_id);
  const status = str((req.body || {}).status, 20);

  if (req.user.role === 'worker') {
    if (application.worker_id !== req.user.id) {
      return fail(res, 403, 'forbidden', 'You can only change your own applications.');
    }
    if (status !== 'withdrawn') {
      return fail(res, 400, 'invalid_status', 'Workers can only withdraw an application.');
    }
  } else {
    if (!job || job.business_id !== req.user.id) {
      return fail(res, 403, 'forbidden', 'You can only review applications for your listings.');
    }
    if (!['accepted', 'rejected', 'pending'].includes(status)) {
      return fail(res, 400, 'invalid_status', 'Choose accept, reject or pending.');
    }
  }

  application.status = status;
  application.updated_at = nowIso();
  notify(
    application.worker_id,
    `Application ${status}`,
    `Your application for ${job?.title || 'a listing'} is now ${status}.`,
    '#/worker/applications'
  );
  persist();
  res.json({ application });
});

/* ------------------------------------------------------------------ workers */

router.get('/workers', requireRole('business', 'admin'), (req, res) => {
  const db = data();
  const q = str(req.query.q, 120).toLowerCase();
  const category = str(req.query.category, 60);
  let rows = db.workerProfiles.map((profile) => {
    const user = db.users.find((u) => u.id === profile.user_id);
    return {
      id: profile.user_id,
      full_name: user?.full_name || 'Worker',
      phone: user?.phone || '',
      status: user?.status || 'active',
      category: profile.category,
      city: profile.city,
      experience_years: profile.experience_years,
      skills: profile.skills,
      bio: profile.bio,
      available: profile.available,
      aqama_masked: profile.aqama_masked,
      created_at: user?.created_at || null
    };
  });
  if (category) rows = rows.filter((w) => w.category === category);
  if (q) {
    rows = rows.filter(
      (w) =>
        w.full_name.toLowerCase().includes(q) ||
        w.category.toLowerCase().includes(q) ||
        (w.skills || []).join(' ').toLowerCase().includes(q) ||
        (w.city || '').toLowerCase().includes(q)
    );
  }
  res.json({ workers: rows });
});

/* ------------------------------------------------------------- notifications */

router.get('/notifications', requireRole('worker', 'business', 'admin'), (req, res) => {
  const list = data()
    .notifications.filter((n) => n.user_id === req.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ notifications: list, unread: list.filter((n) => !n.read_at).length });
});

router.post('/notifications/read-all', requireRole('worker', 'business', 'admin'), (req, res) => {
  for (const n of data().notifications) {
    if (n.user_id === req.user.id && !n.read_at) n.read_at = nowIso();
  }
  persist();
  res.json({ ok: true });
});

router.post('/notifications/:id/read', requireRole('worker', 'business', 'admin'), (req, res) => {
  const notification = data().notifications.find(
    (n) => n.id === req.params.id && n.user_id === req.user.id
  );
  if (!notification) return fail(res, 404, 'not_found', 'Notification not found.');
  notification.read_at = nowIso();
  persist();
  res.json({ notification });
});

/* --------------------------------------------------------------- agreements */

router.post('/agreements', requireRole('business', 'admin'), (req, res) => {
  const body = req.body || {};
  const db = data();
  const workerId = str(body.worker_id, 60);
  const worker = db.users.find((u) => u.id === workerId && u.role === 'worker');
  if (!worker) return fail(res, 400, 'invalid_worker', 'Choose a valid worker.');

  const businessId = req.user.role === 'admin' ? str(body.business_id, 60) : req.user.id;
  const businessProfile = db.businessProfiles.find((b) => b.user_id === businessId);
  if (!businessProfile) return fail(res, 400, 'invalid_business', 'Business profile not found.');

  const scope = str(body.scope, 4000);
  const terms = str(body.terms, 4000);
  if (!scope) return fail(res, 400, 'missing_scope', 'Work description is required.');
  if (!terms) return fail(res, 400, 'missing_terms', 'Agreed terms are required.');

  let jobId = null;
  if (body.job_id) {
    const job = db.jobs.find((j) => j.id === str(body.job_id, 60));
    if (job && job.business_id === businessId) jobId = job.id;
  }

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`;
  const serial = nextCounter('agreement');

  const agreement = {
    id: id(),
    ref: `WB-AGR-${stamp}-${serial}`,
    business_id: businessId,
    worker_id: worker.id,
    job_id: jobId,
    scope,
    terms,
    start_date: str(body.start_date, 20) || null,
    end_date: str(body.end_date, 20) || null,
    pay_amount: round2(num(body.pay_amount, 0)),
    pay_period: PAY_PERIODS.includes(str(body.pay_period, 20)) ? str(body.pay_period, 20) : 'month',
    currency: isValidCurrency(str(body.currency, 8).toUpperCase())
      ? str(body.currency, 8).toUpperCase()
      : db.settings.currency.default,
    status: 'pending_signatures',
    signatures: {},
    created_at: nowIso()
  };
  // Freeze the percentage in force today onto the agreement so both parties
  // can see it, and record the matching ledger row for the administrator.
  const quote = commissionQuote(agreement.pay_amount);
  agreement.commission_rate = quote ? quote.rate : 0;
  agreement.commission_amount = quote ? quote.amount : 0;
  agreement.commission_payer = quote ? quote.payer : null;

  db.agreements.unshift(agreement);
  if (quote) {
    recordCommission({
      docType: 'agreement',
      docId: agreement.id,
      ref: agreement.ref,
      amount: agreement.pay_amount,
      currency: agreement.currency,
      workerId: worker.id,
      workerName: worker.full_name,
      businessId,
      businessName: businessProfile.company_name,
      actorId: req.user.id
    });
  }

  notify(
    worker.id,
    'Agreement to sign',
    `${businessProfile.company_name} sent agreement ${agreement.ref}.`,
    `#/agreements/${agreement.id}`
  );
  persist();
  res.status(201).json({ agreement: agreementView(agreement, req.user) });
});

router.get('/agreements', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  let list = db.agreements;
  if (req.user.role === 'worker') list = list.filter((a) => a.worker_id === req.user.id);
  if (req.user.role === 'business') list = list.filter((a) => a.business_id === req.user.id);
  list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ agreements: list.map((a) => agreementView(a, req.user)) });
});

router.get('/agreements/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const agreement = data().agreements.find((a) => a.id === req.params.id);
  if (!agreement) return fail(res, 404, 'not_found', 'Agreement not found.');
  const participant =
    req.user.role === 'admin' ||
    agreement.worker_id === req.user.id ||
    agreement.business_id === req.user.id;
  if (!participant) return fail(res, 403, 'forbidden', 'You cannot view this agreement.');
  res.json({ agreement: agreementView(agreement, req.user) });
});

router.post('/agreements/:id/sign', requireRole('worker', 'business'), (req, res) => {
  const db = data();
  const agreement = db.agreements.find((a) => a.id === req.params.id);
  if (!agreement) return fail(res, 404, 'not_found', 'Agreement not found.');
  const role = req.user.role;
  if (
    (role === 'worker' && agreement.worker_id !== req.user.id) ||
    (role === 'business' && agreement.business_id !== req.user.id)
  ) {
    return fail(res, 403, 'forbidden', 'You are not a party to this agreement.');
  }
  const body = req.body || {};
  const signature = String(body.signature || '');
  const name = str(body.name, 120) || req.user.full_name;
  if (!signature.startsWith('data:image/')) {
    return fail(res, 400, 'missing_signature', 'Draw your signature before signing.');
  }
  if (signature.length > 1_500_000) {
    return fail(res, 413, 'signature_too_large', 'Signature image is too large.');
  }

  agreement.signatures = agreement.signatures || {};
  agreement.signatures[role] = { name, signature, signed_at: nowIso(), user_id: req.user.id };
  agreement.status =
    agreement.signatures.worker && agreement.signatures.business
      ? 'signed'
      : 'pending_signatures';

  const otherParty = role === 'worker' ? agreement.business_id : agreement.worker_id;
  notify(
    otherParty,
    'Agreement signed',
    `${name} signed agreement ${agreement.ref}.`,
    `#/agreements/${agreement.id}`
  );
  persist();
  res.json({ agreement: agreementView(agreement, req.user) });
});

/* ----------------------------------------------------------------- invoices */

function buildInvoiceTotals(items, vatRate) {
  const clean = items
    .map((item) => ({
      description: str(item.description, 300),
      quantity: Math.max(0, num(item.quantity, 0)),
      unit_price: round2(Math.max(0, num(item.unit_price, 0)))
    }))
    .filter((item) => item.description);
  const subtotal = round2(clean.reduce((sum, i) => sum + i.quantity * i.unit_price, 0));
  const vat = round2((subtotal * vatRate) / 100);
  return { items: clean, subtotal, vat_amount: vat, total: round2(subtotal + vat) };
}

router.post('/invoices', requireRole('worker', 'business'), (req, res) => {
  const body = req.body || {};
  const db = data();
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  if (!items.length) return fail(res, 400, 'missing_items', 'Add at least one invoice line.');

  const vatRate = Math.max(0, Math.min(100, num(body.vat_rate, 0)));
  const { items: cleanItems, subtotal, vat_amount, total } = buildInvoiceTotals(items, vatRate);

  const now = new Date();
  const period = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const serial = nextCounter('invoice');

  const profile = profileFor(req.user);
  const invoice = {
    id: id(),
    serial: `WB-INV-${period}-${serial}`,
    issuer_id: req.user.id,
    issuer_role: req.user.role,
    issuer_name: str(body.issuer_name, 160) || profile?.company_name || req.user.full_name,
    issuer_phone: str(body.issuer_phone, 40) || req.user.phone,
    issuer_address: str(body.issuer_address, 300) || profile?.address || '',
    issuer_country: str(body.issuer_country, 80) || profile?.country || '',
    client_name: str(body.client_name, 160),
    client_phone: str(body.client_phone, 40),
    client_address: str(body.client_address, 300),
    client_country: str(body.client_country, 80),
    currency: isValidCurrency(str(body.currency, 8).toUpperCase())
      ? str(body.currency, 8).toUpperCase()
      : data().settings.currency.default,
    items: cleanItems,
    vat_rate: vatRate,
    subtotal,
    vat_amount,
    total,
    notes: str(body.notes, 1000),
    signature: String(body.signature || '').slice(0, 1_500_000) || null,
    stamp: String(body.stamp || '').slice(0, 1_500_000) || null,
    commission_applied: false,
    created_at: nowIso()
  };
  if (!invoice.client_name) return fail(res, 400, 'missing_client', 'Client name is required.');

  // Record the administrator's commission for this invoice. The entry lives in
  // the admin ledger only; the invoice itself stays free of commission data.
  const workerIssuer = req.user.role === 'worker';
  const commission = recordCommission({
    docType: 'invoice',
    docId: invoice.id,
    ref: invoice.serial,
    amount: invoice.total,
    currency: invoice.currency,
    workerId: workerIssuer ? req.user.id : null,
    workerName: workerIssuer ? req.user.full_name : invoice.client_name,
    businessId: workerIssuer ? null : req.user.id,
    businessName: workerIssuer ? invoice.client_name : invoice.issuer_name,
    actorId: req.user.id
  });
  invoice.commission_applied = Boolean(commission);

  db.invoices.unshift(invoice);
  persist();
  res.status(201).json({ invoice: invoiceView(invoice) });
});

router.get('/invoices', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  let list = db.invoices;
  if (req.user.role !== 'admin') list = list.filter((i) => i.issuer_id === req.user.id);
  list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ invoices: list.map(invoiceListRow) });
});

router.get('/invoices/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const invoice = data().invoices.find((i) => i.id === req.params.id);
  if (!invoice) return fail(res, 404, 'not_found', 'Invoice not found.');
  if (req.user.role !== 'admin' && invoice.issuer_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'You cannot view this invoice.');
  }
  res.json({ invoice: invoiceView(invoice) });
});

/* ------------------------------------------------------------- institutions */

router.post('/institutions', (req, res) => {
  const body = req.body || {};
  const name = str(body.name, 160);
  const email = str(body.email, 160).toLowerCase();
  const contactName = str(body.contact_name, 120);
  if (!name) return fail(res, 400, 'missing_name', 'Institution name is required.');
  if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (!contactName) return fail(res, 400, 'missing_contact', 'Contact name is required.');

  const db = data();
  if (db.institutions.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
    return fail(res, 409, 'duplicate_institution', 'An institution with this name is already registered.');
  }

  const institution = {
    id: id(),
    name,
    type: INSTITUTION_TYPES.includes(str(body.type, 60))
      ? str(body.type, 60)
      : 'Social Support Organization',
    contact_name: contactName,
    email,
    phone: str(body.phone, 40),
    address: str(body.address, 300),
    description: str(body.description, 2000),
    status: 'pending',
    review_note: null,
    created_at: nowIso(),
    reviewed_at: null
  };
  db.institutions.unshift(institution);
  persist();
  res.status(201).json({
    institution: { id: institution.id, name: institution.name, status: institution.status },
    message: 'Registration submitted. An administrator will review it shortly.'
  });
});

// Public on purpose: only approved names/types are ever exposed. Contact
// details and addresses stay behind the admin-only endpoint.
router.get('/institutions', (req, res) => {
  const approved = data()
    .institutions.filter((i) => i.status === 'approved')
    .map((i) => ({ id: i.id, name: i.name, type: i.type }));
  res.json({ institutions: approved });
});

/* ------------------------------------------------------------------ reports */

router.post('/reports', requireRole('worker', 'business'), (req, res) => {
  const body = req.body || {};
  const targetType = str(body.target_type, 30);
  const targetId = str(body.target_id, 60);
  const reason = str(body.reason, 300);
  if (!['job', 'user', 'agreement', 'invoice'].includes(targetType)) {
    return fail(res, 400, 'invalid_target', 'Choose what you are reporting.');
  }
  if (!targetId) return fail(res, 400, 'missing_target', 'Target is required.');
  if (!reason) return fail(res, 400, 'missing_reason', 'Please describe the problem.');

  const report = {
    id: id(),
    reporter_id: req.user.id,
    reporter_role: req.user.role,
    target_type: targetType,
    target_id: targetId,
    reason,
    details: str(body.details, 2000),
    status: 'open',
    created_at: nowIso(),
    resolved_at: null
  };
  data().reports.unshift(report);
  persist();
  res.status(201).json({ report });
});

/* -------------------------------------------------------------------- admin */

router.get('/admin/overview', requireRole('admin'), (req, res) => {
  const db = data();
  res.json({
    counts: {
      workers: db.users.filter((u) => u.role === 'worker').length,
      businesses: db.users.filter((u) => u.role === 'business').length,
      jobs_open: db.jobs.filter((j) => j.status === 'open').length,
      jobs_closed: db.jobs.filter((j) => j.status === 'closed').length,
      jobs_removed: db.jobs.filter((j) => j.status === 'removed').length,
      applications: db.applications.length,
      agreements: db.agreements.length,
      invoices: db.invoices.length,
      institutions_pending: db.institutions.filter((i) => i.status === 'pending').length,
      institutions_approved: db.institutions.filter((i) => i.status === 'approved').length,
      reports_open: db.reports.filter((r) => r.status === 'open').length
    },
    commission: currentCommission(),
    commission_summary: commissionSummary()
  });
});

router.get('/admin/users', requireRole('admin'), (req, res) => {
  const db = data();
  const role = str(req.query.role, 20);
  // The owner account is never listed to an admin, and admins cannot see other
  // administrators either: only the owner sees administrator accounts.
  let users = db.users.filter((u) => u.role === 'worker' || u.role === 'business');
  if (role) users = users.filter((u) => u.role === role);
  // Regional admins only see accounts inside their assigned country/city.
  users = users.filter((u) => {
    const profile = profileFor(u) || {};
    return inScope(req.user, { country: profile.country, city: profile.city });
  });
  const rows = users.map((u) => ({
    ...publicUser(u, profileFor(u)),
    profile: profileFor(u) || null,
    applications: db.applications.filter((a) => a.worker_id === u.id).length,
    jobs: db.jobs.filter((j) => j.business_id === u.id).length
  }));
  res.json({ users: rows });
});

router.patch('/admin/users/:id', requireRole('admin'), (req, res) => {
  const db = data();
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return fail(res, 404, 'not_found', 'Account not found.');
  // Hard stops, enforced here rather than by hiding buttons: an admin may never
  // touch the owner, another admin, or their own administrator record.
  if (target.role === 'owner') {
    return fail(res, 403, 'owner_protected', 'The owner account cannot be accessed by an admin.');
  }
  if (target.role === 'admin') {
    return fail(res, 403, 'admin_protected', 'Admins cannot manage administrator accounts.');
  }
  if (target.role !== 'worker' && target.role !== 'business') {
    return fail(res, 403, 'forbidden', 'This account cannot be managed here.');
  }
  const targetProfile = profileFor(target) || {};
  if (!inScope(req.user, { country: targetProfile.country, city: targetProfile.city })) {
    return fail(res, 403, 'out_of_scope', 'This account is outside your assigned area.');
  }
  const user = target;
  const body = req.body || {};
  // An admin cannot promote anyone, change roles or widen their own authority.
  if (body.role !== undefined || body.admin_scope !== undefined) {
    return fail(res, 403, 'forbidden', 'Role and permission changes require the owner.');
  }

  const status = str(body.status, 20);
  if (status) {
    if (!['active', 'pending', 'suspended', 'rejected'].includes(status)) {
      return fail(res, 400, 'invalid_status', 'Choose approved, pending, rejected or suspended.');
    }
    user.status = status;
    if (status === 'active') user.approved_at = nowIso();
    // Suspension ends existing sessions because middleware only accepts an
    // 'active' account; reactivating lets the same user sign in again.
  }

  if (body.full_name !== undefined) {
    const fullName = str(body.full_name, 120);
    if (!fullName) return fail(res, 400, 'missing_name', 'Full name is required.');
    user.full_name = fullName;
  }
  if (body.phone !== undefined) {
    const phone = str(body.phone, 40);
    if (!phone) return fail(res, 400, 'missing_phone', 'Phone number is required.');
    user.phone = phone;
  }
  if (body.email !== undefined) {
    const email = str(body.email, 160).toLowerCase();
    if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
    if (db.users.some((u) => u.id !== user.id && u.email === email)) {
      return fail(res, 409, 'email_taken', 'Another account already uses that email.');
    }
    user.email = email;
  }

  if (user.role === 'worker') {
    const profile = db.workerProfiles.find((p) => p.user_id === user.id);
    if (profile) {
      if (body.category !== undefined) {
        const category = str(body.category, 60);
        if (!CATEGORIES.includes(category)) {
          return fail(res, 400, 'invalid_category', 'Choose a valid work category.');
        }
        profile.category = category;
      }
      if (body.city !== undefined) profile.city = str(body.city, 120);
      if (body.country !== undefined) profile.country = str(body.country, 80);
      if (body.bio !== undefined) profile.bio = str(body.bio, 1000);
      if (body.experience_years !== undefined) {
        profile.experience_years = Math.max(0, Math.min(60, num(body.experience_years, 0)));
      }
      if (body.available !== undefined) profile.available = Boolean(body.available);
      if (body.skills !== undefined) {
        const list = Array.isArray(body.skills) ? body.skills : String(body.skills).split(',');
        profile.skills = list.map((s) => str(s, 60)).filter(Boolean).slice(0, 20);
      }
    }
  } else {
    const profile = db.businessProfiles.find((p) => p.user_id === user.id);
    if (profile) {
      if (body.company_name !== undefined) {
        profile.company_name = str(body.company_name, 160) || profile.company_name;
      }
      if (body.contact_name !== undefined) {
        profile.contact_name = str(body.contact_name, 120) || user.full_name;
      }
      if (body.phone !== undefined) profile.phone = user.phone;
      if (body.country !== undefined) profile.country = str(body.country, 80);
      if (body.address !== undefined) profile.address = str(body.address, 300);
      if (body.website !== undefined) profile.website = str(body.website, 200);
      if (body.about !== undefined) profile.about = str(body.about, 1000);
    }
  }

  persist();
  res.json({ user: publicUser(user, profileFor(user)) });
});

router.get('/admin/institutions', requireRole('admin'), (req, res) => {
  const db = data();
  const status = str(req.query.status, 20);
  let list = [...db.institutions];
  if (status) list = list.filter((i) => i.status === status);
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ institutions: list });
});

router.patch('/admin/institutions/:id', requireRole('admin'), (req, res) => {
  const institution = data().institutions.find((i) => i.id === req.params.id);
  if (!institution) return fail(res, 404, 'not_found', 'Institution not found.');
  const body = req.body || {};
  const status = str(body.status, 20);
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return fail(res, 400, 'invalid_status', 'Choose approved, rejected or pending.');
  }
  institution.status = status;
  institution.review_note = str(body.note, 500) || null;
  institution.reviewed_at = nowIso();
  persist();
  res.json({ institution });
});

router.get('/admin/jobs', requireRole('admin'), (req, res) => {
  const db = data();
  const jobs = [...db.jobs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((j) => jobView(j, req.user));
  res.json({ jobs });
});

router.get('/admin/agreements', requireRole('admin'), (req, res) => {
  const list = [...data().agreements].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  res.json({ agreements: list.map((a) => agreementView(a, req.user)) });
});

/**
 * Commission recorded for one invoice. Exposed only through history lists: the
 * invoice document itself never carries commission fields.
 */
function invoiceCommission(invoice) {
  const entry = (data().commissions || []).find(
    (row) => row.doc_type === 'invoice' && row.doc_id === invoice.id
  );
  if (!entry) return null;
  return {
    rate: entry.rate,
    amount: entry.commission_amount,
    currency: entry.currency || invoice.currency,
    payer: entry.payer || 'business'
  };
}

function invoiceListRow(invoice) {
  return { ...invoiceView(invoice), commission: invoiceCommission(invoice) };
}

router.get('/admin/invoices', requireRole('admin'), (req, res) => {
  const list = [...data().invoices].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ invoices: list.map(invoiceListRow) });
});

router.get('/admin/reports', requireRole('admin'), (req, res) => {
  const list = [...data().reports].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ reports: list });
});

router.patch('/admin/reports/:id', requireRole('admin'), (req, res) => {
  const report = data().reports.find((r) => r.id === req.params.id);
  if (!report) return fail(res, 404, 'not_found', 'Report not found.');
  const status = str((req.body || {}).status, 20);
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    return fail(res, 400, 'invalid_status', 'Choose open, resolved or dismissed.');
  }
  report.status = status;
  report.resolved_at = status === 'open' ? null : nowIso();
  persist();
  res.json({ report });
});

router.get('/admin/settings/commission', requireRole('admin'), (req, res) => {
  res.json({ commission: currentCommission() });
});

router.get('/admin/commissions', requireRole('admin'), (req, res) => {
  const entries = commissionLedger();
  res.json({ commission: currentCommission(), entries, summary: commissionSummary(entries) });
});

router.put('/admin/settings/commission', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  if (!isValidRate(body.rate)) {
    return fail(
      res,
      400,
      'invalid_rate',
      'Choose a commission rate between 0% and 20% in 0.5% steps.'
    );
  }
  const rate = normalizeRate(body.rate);
  const enabled = body.enabled === undefined ? rate > 0 : Boolean(body.enabled);
  const payer = str(body.payer, 20) || 'business';
  if (!['business', 'worker', 'both'].includes(payer)) {
    return fail(res, 400, 'invalid_payer', 'Payer must be business, worker or both.');
  }
  if (enabled && rate === 0) {
    return fail(res, 400, 'invalid_rate', 'Choose a rate above 0% when commission is enabled.');
  }

  data().settings.commission = {
    enabled,
    rate: enabled ? rate : 0,
    payer,
    updated_at: nowIso()
  };
  persist();
  res.json({
    commission: currentCommission(),
    // Documents already created keep the rate they were recorded with.
    applies_to: 'new_documents'
  });
});

router.use((req, res) => fail(res, 404, 'not_found', 'Unknown API endpoint.'));

export default router;
