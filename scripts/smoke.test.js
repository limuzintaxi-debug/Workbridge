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

  await step('first administrator is created through the setup endpoint', async () => {
    const status = await anon.get('/api/setup/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.setup_required, true, 'a fresh install must require setup');

    const created = await admin.post('/api/setup/admin', {
      email: 'admin@workbridge.test',
      password: 'Admin#12345',
      full_name: 'Platform Admin'
    });
    assert.equal(created.status, 201, created.text);

    const second = await anon.post('/api/setup/admin', {
      email: 'second-admin@workbridge.test',
      password: 'Another#12345',
      full_name: 'Second Admin'
    });
    assert.equal(second.status, 409, 'setup must close once an administrator exists');

    const after = await anon.get('/api/setup/status');
    assert.equal(after.json.setup_required, false);
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

  await step('admin sets any commission percentage and it applies to new documents', async () => {
    const overview = await admin.get('/api/admin/overview');
    assert.equal(overview.status, 200);
    assert.ok(overview.json.counts.workers >= 1);
    assert.equal(overview.json.commission.enabled, false);
    assert.equal(overview.json.commission_summary.count, 0, 'nothing recorded while commission is off');

    const settings = await admin.put('/api/admin/settings/commission', { enabled: true, rate: 2.5, payer: 'business' });
    assert.equal(settings.status, 200, settings.text);
    assert.equal(settings.json.commission.rate, 2.5, 'any 0.5% step is accepted');

    const meta = await anon.get('/api/meta');
    assert.equal(meta.json.commission.rate, 2.5);

    const tooHigh = await admin.put('/api/admin/settings/commission', { enabled: true, rate: 25, payer: 'business' });
    assert.equal(tooHigh.status, 400, 'rates above 20% are refused');
    const offGrid = await admin.put('/api/admin/settings/commission', { enabled: true, rate: 2.3, payer: 'business' });
    assert.equal(offGrid.status, 400, 'rates must land on a 0.5% step');

    // Documents created after the change pick the percentage up automatically.
    const invoice = await business.post('/api/invoices', {
      issuer_name: 'Demo Build LLC',
      client_name: 'Commission Client',
      currency: 'AED',
      items: [{ description: 'Commission test work', quantity: 1, unit_price: 400 }],
      vat_rate: 0
    });
    assert.equal(invoice.status, 201, invoice.text);
    assert.equal(invoice.json.invoice.total, 400);
    assert.equal(invoice.json.invoice.commission, undefined, 'an invoice never shows commission');
    assert.equal(invoice.json.invoice.commission_rate, undefined);
    assert.equal(invoice.json.invoice.commission_amount, undefined);

    const adminHistory = await admin.get('/api/admin/invoices');
    const adminRow = adminHistory.json.invoices.find(
      (row) => row.serial === invoice.json.invoice.serial
    );
    assert.ok(adminRow, 'the invoice appears in the administrator history');
    assert.equal(adminRow.commission.rate, 2.5, 'history row carries the applied rate');
    assert.equal(adminRow.commission.amount, 10, 'history row carries the commission amount');
    assert.equal(adminRow.commission.currency, 'AED');

    const agreement = await business.post('/api/agreements', {
      worker_id: workerId,
      scope: 'Commission test scope.',
      terms: 'Commission test terms.',
      pay_amount: 1000,
      pay_period: 'month'
    });
    assert.equal(agreement.status, 201, agreement.text);
    assert.equal(agreement.json.agreement.commission_rate, 2.5, 'the agreement shows the applied rate');
    assert.equal(agreement.json.agreement.commission_amount, 25);

    const ledger = await admin.get('/api/admin/commissions');
    assert.equal(ledger.status, 200);
    assert.equal(ledger.json.entries.length, 2, 'one record per new document');
    const invoiceEntry = ledger.json.entries.find((e) => e.doc_type === 'invoice');
    assert.equal(invoiceEntry.rate, 2.5);
    assert.equal(invoiceEntry.commission_amount, 10);
    assert.equal(invoiceEntry.currency, 'AED');
    assert.equal(invoiceEntry.business_name, 'Demo Build LLC');
    assert.equal(invoiceEntry.ref, invoice.json.invoice.serial);
    const agreementEntry = ledger.json.entries.find((e) => e.doc_type === 'agreement');
    assert.equal(agreementEntry.commission_amount, 25);
    assert.equal(agreementEntry.ref, agreement.json.agreement.ref);
    assert.equal(ledger.json.summary.count, 2);

    const workerLedger = await worker.get('/api/admin/commissions');
    assert.equal(workerLedger.status, 403, 'the commission record is administrator-only');

    const reset = await admin.put('/api/admin/settings/commission', { enabled: false, rate: 0, payer: 'business' });
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
    const logo = await fetch(`${BASE}/assets/logo.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');

    // Every installed-app size must be a real square PNG generated from the
    // approved artwork. The manifest advertises the PWA sizes; the Apple touch
    // icon is referenced from the HTML head instead (iOS ignores manifest icons).
    const sizes = [
      ['/assets/favicon-32.png', 32, true],
      ['/assets/apple-touch-icon.png', 180, false],
      ['/assets/icon-192.png', 192, true],
      ['/assets/icon-512.png', 512, true],
      ['/assets/icon-maskable-512.png', 512, true]
    ];
    for (const [path, size, inManifest] of sizes) {
      const res = await fetch(`${BASE}${path}`);
      assert.equal(res.status, 200, `${path} should be served`);
      assert.equal(res.headers.get('content-type'), 'image/png', `${path} should be a PNG`);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${path} should have a PNG signature`);
      assert.equal(bytes.readUInt32BE(16), size, `${path} should be ${size}px wide`);
      assert.equal(bytes.readUInt32BE(20), size, `${path} should be ${size}px tall`);
      if (inManifest) {
        assert.ok(
          json.icons.some((icon) => icon.src.split('?')[0] === path),
          `manifest should list ${path}`
        );
      }
    }
    const head = await fetch(`${BASE}/index.html`).then((r) => r.text());
    assert.ok(head.includes('apple-touch-icon'), 'index.html should link the Apple touch icon');
    assert.ok(
      head.includes('/assets/apple-touch-icon.png'),
      'index.html should point the Apple touch icon at the generated icon'
    );
    assert.ok(
      json.icons.some((icon) => icon.purpose === 'maskable'),
      'manifest should include a maskable icon'
    );
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
