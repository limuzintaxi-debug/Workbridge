/**
 * WORKBRIDGE end-to-end smoke test.
 *
 * Boots the real server against a throwaway data directory and exercises the
 * complete workflow over HTTP: role registration, listings with age buckets,
 * applications, agreements with electronic signatures, server-side invoice VAT,
 * institution approval gating and admin-only routes.
 *
 * Run with: npm test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ageBucket } from '../server/util.js';

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workbridge-test-'));

let passed = 0;
const failures = [];

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

/** Minimal cookie-jar client so each actor keeps its own session. */
function client() {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const pair = raw.split(';')[0];
      if (pair.startsWith('wb_session=')) cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }
  return {
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body),
    patch: (url, body) => call('PATCH', url, body),
    put: (url, body) => call('PUT', url, body)
  };
}

const stamp = Date.now();
const anon = client();
const worker = client();
const business = client();
const admin = client();

let jobId;
let workerId;
let agreementId;
let invoiceId;
let institutionId;

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server did not become ready');
}

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: 'test-secret-value-0123456789' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', () => {});
server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));

let exitCode = 0;

try {
  await waitForServer();
  console.log('\nWORKBRIDGE smoke test\n');

  await step('health and metadata endpoints respond', async () => {
    const health = await anon.get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const meta = await anon.get('/api/meta');
    assert.equal(meta.status, 200);
    assert.ok(meta.json.categories.includes('Driver'));
    assert.ok(meta.json.categories.includes('Electrician'));
    assert.equal(meta.json.support_email, 'Limuzin@196vip.si');
    assert.equal(meta.json.commission.enabled, false, 'commission must default to off');
  });

  await step('public admin registration is refused', async () => {
    const res = await anon.post('/api/auth/register', {
      role: 'admin',
      email: `evil${stamp}@workbridge.test`,
      password: 'Password#123',
      full_name: 'Not Allowed',
      phone: '+1000000'
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'role_not_allowed');
  });

  await step('worker registers with Aqama and skill category', async () => {
    const res = await worker.post('/api/auth/register', {
      role: 'worker',
      email: `worker${stamp}@workbridge.test`,
      password: 'Worker#12345',
      full_name: 'Demo Worker',
      phone: '+971500000001',
      category: 'Electrician',
      aqama: '784-1990-1234567-1',
      city: 'Dubai',
      experience_years: 4,
      skills: 'wiring, panels',
      bio: 'Demo worker profile'
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.user.role, 'worker');
    workerId = res.json.user.id;
    const me = await worker.get('/api/auth/me');
    assert.equal(me.json.user.email, `worker${stamp}@workbridge.test`);
  });

  await step('Aqama number is masked, never stored in clear text', async () => {
    const me = await worker.get('/api/auth/me');
    const stored = JSON.stringify(me.json);
    assert.ok(!stored.includes('784-1990-1234567-1'), 'raw Aqama must not be returned');
  });

  await step('worker rejects an invalid skill category', async () => {
    const res = await anon.post('/api/auth/register', {
      role: 'worker',
      email: `bad${stamp}@workbridge.test`,
      password: 'Worker#12345',
      full_name: 'Bad Category',
      phone: '+971500000009',
      category: 'Astronaut'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_category');
  });

  await step('business registers and creates a listing', async () => {
    const reg = await business.post('/api/auth/register', {
      role: 'business',
      email: `business${stamp}@workbridge.test`,
      password: 'Business#12345',
      full_name: 'Demo Business Owner',
      phone: '+971500000002',
      company_name: 'Demo Build LLC',
      country: 'United Arab Emirates',
      address: 'Demo Street 1'
    });
    assert.equal(reg.status, 201, reg.text);
    assert.equal(reg.json.user.profile.company_name, 'Demo Build LLC');

    const job = await business.post('/api/jobs', {
      title: 'Demo electrician for site works',
      category: 'Electrician',
      description: 'Install and test wiring on a demo site.',
      location: 'Dubai',
      pay_amount: 250,
      pay_period: 'day',
      requirements: 'Safety gear'
    });
    assert.equal(job.status, 201, job.text);
    jobId = job.json.job.id;
    assert.equal(job.json.job.status, 'open');
    assert.equal(job.json.job.age_label, 'New');
  });

  await step('worker sees the listing and applies', async () => {
    const list = await worker.get('/api/jobs');
    assert.equal(list.status, 200);
    const found = list.json.jobs.find((job) => job.id === jobId);
    assert.ok(found, 'new listing must be visible to workers');
    assert.equal(found.age_bucket, 'new');

    const apply = await worker.post(`/api/jobs/${jobId}/apply`, { message: 'Available immediately.' });
    assert.equal(apply.status, 201, apply.text);

    const again = await worker.post(`/api/jobs/${jobId}/apply`, { message: 'Duplicate' });
    assert.equal(again.status, 409, 'duplicate applications must be rejected');
  });

  await step('business receives and accepts the application', async () => {
    const apps = await business.get('/api/applications');
    assert.equal(apps.status, 200);
    assert.equal(apps.json.applications.length, 1);
    const appId = apps.json.applications[0].id;
    const res = await business.patch(`/api/applications/${appId}`, { status: 'accepted' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.application.status, 'accepted');
  });

  await step('worker cannot post a listing', async () => {
    const res = await worker.post('/api/jobs', { title: 'Nope', category: 'Driver', description: 'x' });
    assert.equal(res.status, 403);
  });

  await step('agreement is created with a unique reference', async () => {
    const res = await business.post('/api/agreements', {
      worker_id: workerId,
      job_id: jobId,
      scope: 'Install electrical wiring in the demo unit.',
      terms: 'Daily rate 250 AED, paid weekly. Safety rules apply.',
      pay_amount: 250,
      pay_period: 'day'
    });
    assert.equal(res.status, 201, res.text);
    agreementId = res.json.agreement.id;
    // Documented format: WB-AGR-YYYYMMDD-NNNN (date-stamped, sequential counter).
    assert.match(res.json.agreement.ref, /^WB-AGR-\d{8}-\d{4,}$/);
    assert.ok(res.json.agreement.created_at, 'agreement must carry a timestamp');

    const second = await business.post('/api/agreements', {
      worker_id: workerId,
      scope: 'Second demo agreement scope.',
      terms: 'Second demo agreement terms.',
      pay_amount: 100,
      pay_period: 'day'
    });
    assert.equal(second.status, 201, second.text);
    assert.notEqual(second.json.agreement.ref, res.json.agreement.ref, 'references must be unique');
  });

  await step('both parties sign the agreement electronically', async () => {
    const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const w = await worker.post(`/api/agreements/${agreementId}/sign`, { signature, name: 'Demo Worker' });
    assert.equal(w.status, 200, w.text);
    const b = await business.post(`/api/agreements/${agreementId}/sign`, { signature, name: 'Demo Business Owner' });
    assert.equal(b.status, 200, b.text);
    const doc = await worker.get(`/api/agreements/${agreementId}`);
    assert.equal(doc.json.agreement.status, 'signed');
    assert.ok(doc.json.agreement.signatures.worker.signed_at);
    assert.ok(doc.json.agreement.signatures.business.signed_at);
  });

  await step('agreement rejects a missing signature image', async () => {
    const res = await business.post(`/api/agreements/${agreementId}/sign`, { signature: 'not-an-image' });
    assert.equal(res.status, 400);
  });

  await step('invoice totals and VAT are computed on the server', async () => {
    const res = await business.post('/api/invoices', {
      issuer_name: 'Demo Build LLC',
      issuer_phone: '+971500000002',
      issuer_address: 'Demo Street 1',
      issuer_country: 'United Arab Emirates',
      client_name: 'Demo Client',
      client_country: 'United Arab Emirates',
      currency: 'AED',
      items: [
        { description: 'Wiring work', quantity: 2, unit_price: 100 },
        { description: 'Materials', quantity: 1, unit_price: 50 }
      ],
      vat_rate: 5,
      notes: 'Demo invoice'
    });
    assert.equal(res.status, 201, res.text);
    invoiceId = res.json.invoice.id;
    // Documented format: WB-INV-YYYYMM-NNNN (month-stamped, sequential counter).
    assert.match(res.json.invoice.serial, /^WB-INV-\d{6}-\d{4,}$/);
    assert.equal(res.json.invoice.subtotal, 250);
    assert.equal(res.json.invoice.vat_amount, 12.5);
    assert.equal(res.json.invoice.total, 262.5);
    assert.equal(res.json.invoice.commission, undefined, 'no commission line while disabled');
  });

  await step('institution registration stays pending and hidden from the public list', async () => {
    const res = await anon.post('/api/institutions', {
      name: `Demo Support Org ${stamp}`,
      type: 'NGO',
      email: `org${stamp}@workbridge.test`,
      contact_name: 'Demo Contact',
      phone: '+971500000003',
      address: 'Private Street 9',
      description: 'Demo institution for testing.'
    });
    assert.equal(res.status, 201, res.text);
    institutionId = res.json.institution.id;
    assert.equal(res.json.institution.status, 'pending');

    const publicList = await anon.get('/api/institutions');
    assert.equal(publicList.status, 200);
    const names = publicList.json.institutions.map((i) => i.name);
    assert.ok(!names.includes(`Demo Support Org ${stamp}`), 'pending institutions must not be public');
    for (const entry of publicList.json.institutions) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'type'], 'no contact details publicly');
    }
  });

  await step('worker cannot review institutions', async () => {
    const res = await worker.patch(`/api/admin/institutions/${institutionId}`, { status: 'approved' });
    assert.equal(res.status, 403);
  });

  await step('admin approves the institution and only its name becomes public', async () => {
    const login = await admin.post('/api/auth/login', {
      email: 'admin@workbridge.test',
      password: 'Admin#12345'
    });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.user.role, 'admin');

    const approve = await admin.patch(`/api/admin/institutions/${institutionId}`, { status: 'approved' });
    assert.equal(approve.status, 200, approve.text);

    const publicList = await anon.get('/api/institutions');
    const entry = publicList.json.institutions.find((i) => i.name === `Demo Support Org ${stamp}`);
    assert.ok(entry, 'approved institution must appear publicly');
    assert.equal(entry.phone, undefined);
    assert.equal(entry.address, undefined);
    assert.ok(!JSON.stringify(publicList.json).includes('Private Street 9'));
  });

  await step('admin overview, moderation and commission settings work', async () => {
    const overview = await admin.get('/api/admin/overview');
    assert.equal(overview.status, 200);
    assert.ok(overview.json.counts.workers >= 1);
    assert.equal(overview.json.commission.enabled, false);

    const settings = await admin.put('/api/admin/settings/commission', { enabled: true, rate: 2, payer: 'business' });
    assert.equal(settings.status, 200, settings.text);
    assert.equal(settings.json.commission.rate, 2);

    const meta = await anon.get('/api/meta');
    assert.equal(meta.json.commission.rate, 2);

    const badRate = await admin.put('/api/admin/settings/commission', { enabled: true, rate: 5, payer: 'business' });
    assert.equal(badRate.status, 400, 'only 1% or 2% are allowed');

    const reset = await admin.put('/api/admin/settings/commission', { enabled: false, rate: 1, payer: 'business' });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.commission.enabled, false);
  });

  await step('admin can suspend an account and the session stops working', async () => {
    const users = await admin.get('/api/admin/users?role=worker');
    const target = users.json.users.find((u) => u.id === workerId);
    assert.ok(target);
    const res = await admin.patch(`/api/admin/users/${workerId}`, { status: 'suspended' });
    assert.equal(res.status, 200);
    const me = await worker.get('/api/auth/me');
    assert.equal(me.json.user, null, 'suspended session must be dropped');
    await admin.patch(`/api/admin/users/${workerId}`, { status: 'active' });
  });

  await step('closing a listing keeps it visible with its age bucket', async () => {
    const close = await business.patch(`/api/jobs/${jobId}`, { status: 'closed' });
    assert.equal(close.status, 200, close.text);
    const all = await admin.get('/api/admin/jobs');
    const job = all.json.jobs.find((j) => j.id === jobId);
    assert.ok(job, 'closed listing must still exist — no automatic deletion');
    assert.equal(job.status, 'closed');
    assert.ok(job.age_label);
  });

  await step('listing age buckets match the required labels', async () => {
    const hours = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    assert.equal(ageBucket(hours(1)).label, 'New');
    assert.equal(ageBucket(hours(24)).label, '24 Hours Old');
    assert.equal(ageBucket(hours(48)).label, '48 Hours Old');
    assert.equal(ageBucket(hours(96)).label, 'Older');
  });

  await step('invoice and agreement lists are scoped per role', async () => {
    const businessInvoices = await business.get('/api/invoices');
    assert.ok(businessInvoices.json.invoices.some((i) => i.id === invoiceId));
    const workerAgreements = await worker.get('/api/agreements');
    assert.ok(workerAgreements.json.agreements.some((a) => a.id === agreementId));
    const workerInvoices = await worker.get('/api/invoices');
    assert.equal(workerInvoices.status, 200);
  });

  await step('business can search registered workers', async () => {
    const res = await business.get('/api/workers?q=Demo&category=Electrician');
    assert.equal(res.status, 200);
    assert.ok(res.json.workers.some((w) => w.id === workerId));
    assert.ok(!JSON.stringify(res.json).includes('784-1990-1234567-1'));
  });

  await step('PWA manifest, service worker and icons are served', async () => {
    const manifest = await fetch(`${BASE}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    const json = await manifest.json();
    assert.equal(json.short_name, 'WORKBRIDGE');
    assert.equal(json.display, 'standalone');
    assert.ok(json.icons.length >= 2);
    const sw = await fetch(`${BASE}/sw.js`);
    assert.equal(sw.status, 200);
    const logo = await fetch(`${BASE}/assets/logo.svg`);
    assert.equal(logo.status, 200);
  });
} catch (error) {
  console.error(`\nFatal: ${error.message}`);
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.message}`);
  exitCode = 1;
}
process.exit(exitCode);
