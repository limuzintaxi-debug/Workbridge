#!/usr/bin/env node
/**
 * Focused regression check for the final WORKBRIDGE requirements:
 *
 *  1. Email/password sessions keep working after the server restarts, because
 *     the session cookie is signed with the configured SESSION_SECRET.
 *  2. Password recovery issues a single-use token that really resets the
 *     password, and the old password stops working.
 *  3. The admin bootstrap creates exactly one administrator, that account can
 *     reach admin-only endpoints, and anonymous callers cannot.
 *  4. An invoice whose optional fields are empty and that has NO company stamp
 *     and NO signature still generates a valid PDF, and the record survives a
 *     restart (nothing about invoice generation may require a stamp).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-session-secret-for-workbridge-restart-verification';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-final-'));
// Capture outbox: recovery mail is written here instead of being sent, so the
// flow is verifiable without real provider credentials.
const outboxDir = path.join(dataDir, 'outbox');

let child = null;

function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: SECRET,
      NODE_ENV: 'test',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      EMAIL_CAPTURE_DIR: outboxDir,
      MAIL_FROM: 'WORKBRIDGE <no-reply@workbridges.live>'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
}

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/setup/status`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not start');
}

async function stop() {
  if (!child) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  child = null;
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map((value) => value.split(';')[0]).join('; ');
}

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text, cookie: cookiesFrom(res) };
}

const passed = [];
function pass(label) {
  passed.push(label);
  console.log(`  ok   ${label}`);
}

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}: ${error.message}`);
  }
}

try {
  start();
  await waitForServer();

  /* ---------------------------------------------------------------- admin */
  let adminCookie = '';

  await check('admin bootstrap issues a session', async () => {
    const res = await call('/api/setup/admin', {
      method: 'POST',
      body: { email: 'admin@workbridge.test', password: 'AdminPass123!', full_name: 'Workbridge Admin' }
    });
    assert.equal(res.status, 201, res.text);
    assert.ok(res.cookie.includes('wb_session'), 'expected a session cookie');
    adminCookie = res.cookie;
    pass('admin bootstrap issues a session');
  });

  await check('a second admin cannot be created', async () => {
    const res = await call('/api/setup/admin', {
      method: 'POST',
      body: { email: 'second@workbridge.test', password: 'AdminPass123!', full_name: 'Second Admin' }
    });
    assert.ok([400, 403, 409].includes(res.status), `unexpected ${res.status}: ${res.text}`);
    pass('a second admin cannot be created');
  });

  await check('admin reaches admin-only endpoints', async () => {
    const res = await call('/api/admin/overview', { cookie: adminCookie });
    assert.equal(res.status, 200, res.text);
    pass('admin reaches admin-only endpoints');
  });

  await check('admin endpoints reject anonymous callers', async () => {
    const res = await call('/api/admin/overview');
    assert.equal(res.status, 401, res.text);
    pass('admin endpoints reject anonymous callers');
  });

  /* ------------------------------------------------- worker + invoice */
  let workerCookie = '';
  let invoiceId = '';

  await check('worker registers with email and password', async () => {
    const res = await call('/api/auth/register', {
      method: 'POST',
      body: {
        role: 'worker',
        email: 'worker@workbridge.test',
        password: 'WorkerPass123!',
        full_name: 'Test Worker',
        phone: '+10000000000',
        category: 'Driver',
        aqama: '1234567890',
        city: 'Riyadh'
      }
    });
    assert.equal(res.status, 201, res.text);
    workerCookie = res.cookie;
    assert.ok(workerCookie.includes('wb_session'), 'expected a session cookie');
    pass('worker registers with email and password');
  });

  await check('invoice without stamp and with empty optional fields generates a PDF', async () => {
    const created = await call('/api/invoices', {
      method: 'POST',
      cookie: workerCookie,
      body: {
        issuer_name: '',
        client_name: 'Acme Trading',
        client_phone: '',
        client_address: '',
        client_country: '',
        currency: 'SAR',
        vat_rate: 0,
        notes: '',
        items: [{ description: 'Consulting', quantity: 1, unit_price: 100 }]
      }
    });
    assert.equal(created.status, 201, created.text);
    invoiceId = created.json.invoice.id;
    assert.ok(invoiceId, 'invoice id expected');

    const pdf = await fetch(`${BASE}/api/invoices/${invoiceId}/pdf`, {
      headers: { cookie: workerCookie }
    });
    assert.equal(pdf.status, 200, `PDF status ${pdf.status}`);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'expected a real PDF body');
    assert.ok(bytes.length > 800, 'PDF looks truncated');
    pass('invoice without stamp and with empty optional fields generates a PDF');
  });

  /* --------------------------------------------- restart persistence */
  await stop();
  start();
  await waitForServer();

  await check('session survives a server restart', async () => {
    const res = await call('/api/auth/me', { cookie: adminCookie });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.user && res.json.user.email, 'admin@workbridge.test');
    pass('session survives a server restart');
  });

  await check('invoice record survives a server restart', async () => {
    const res = await call('/api/invoices', { cookie: workerCookie });
    assert.equal(res.status, 200, res.text);
    assert.ok(
      res.json.invoices.some((invoice) => invoice.id === invoiceId),
      'invoice missing after restart'
    );
    pass('invoice record survives a server restart');
  });

  /* ------------------------------------------------- password reset */
  await check('password recovery resets the password with a single-use token', async () => {
    const forgot = await call('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'worker@workbridge.test' }
    });
    assert.equal(forgot.status, 200, forgot.text);
    assert.equal(forgot.json.email_sent, true, 'the reset email must reach the provider');

    const outbox = (await readFile(path.join(outboxDir, 'outbox.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const mail = outbox.filter((message) => message.to === 'worker@workbridge.test').pop();
    assert.ok(mail, `expected a reset email, outbox holds ${outbox.length} message(s)`);
    assert.match(mail.from, /no-reply@workbridges\.live/, 'sender must be MAIL_FROM');

    const match = /token=([A-Za-z0-9._-]+)/.exec(String(mail.text));
    assert.ok(match, `expected a reset link in the email, got ${mail.text}`);
    const token = match[1];

    const reset = await call('/api/auth/reset-password', {
      method: 'POST',
      body: { token, password: 'NewWorkerPass123!' }
    });
    assert.equal(reset.status, 200, reset.text);

    const reuse = await call('/api/auth/reset-password', {
      method: 'POST',
      body: { token, password: 'AnotherWorkerPass123!' }
    });
    assert.ok([400, 401, 410].includes(reuse.status), `reused token accepted (${reuse.status})`);

    const oldLogin = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'worker@workbridge.test', password: 'WorkerPass123!' }
    });
    assert.equal(oldLogin.status, 401, 'old password must stop working');

    const newLogin = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'worker@workbridge.test', password: 'NewWorkerPass123!' }
    });
    assert.equal(newLogin.status, 200, newLogin.text);
    pass('password recovery resets the password with a single-use token');
  });
} finally {
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed.length} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
