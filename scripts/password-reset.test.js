/**
 * WORKBRIDGE password-reset end-to-end test.
 *
 * Boots the real server with a throwaway data directory and a capture outbox
 * (EMAIL_CAPTURE_DIR) so the complete recovery flow can be verified for all
 * three account roles without real provider credentials:
 *
 *   admin    → own registered email
 *   business → own registered email
 *   worker   → own registered email
 *
 * For each role it asserts the message is addressed to that account only, the
 * sender is MAIL_FROM (never the Help & Support mailbox), the link resets the
 * password exactly once, and an expired link is rejected.
 *
 * Run with: npm run test:reset
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3467;
const BASE = `http://127.0.0.1:${PORT}`;
const UNCONFIGURED_PORT = 3468;
const UNCONFIGURED_BASE = `http://127.0.0.1:${UNCONFIGURED_PORT}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workbridge-reset-'));
const DATA_DIR = path.join(TMP, 'data');
const OUTBOX_DIR = path.join(TMP, 'outbox');
const OUTBOX = path.join(OUTBOX_DIR, 'outbox.jsonl');
const SUPPORT_EMAIL = 'Limuzin@196vip.si';
const MAIL_FROM = 'WORKBRIDGE <no-reply@workbridges.live>';
const RESET_TTL_MS = 6000;

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

/** Child env with no provider credentials, so the capture outbox is used. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'RESEND_API_KEY',
    'EMAIL_CAPTURE_DIR',
    'EMAIL_PROVIDER'
  ]) {
    delete env[key];
  }
  // Explicit values from the caller win, including EMAIL_CAPTURE_DIR.
  return { ...env, NODE_ENV: 'test', ...extra };
}

function startServer({ port, env }) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: childEnv({ PORT: String(port), ...env }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (!text.includes('ExperimentalWarning')) process.stderr.write(`[server] ${text}`);
  });
  return child;
}

async function waitFor(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/setup/status`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server on ${base} did not become ready`);
}

/** Minimal cookie-jar client so each actor keeps its own session. */
function client(base = BASE) {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const entry of setCookie) {
      const pair = entry.split(';')[0];
      if (pair.includes('=')) cookie = pair;
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, text };
  }
  return {
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body),
    put: (url, body) => call('PUT', url, body)
  };
}

function outbox() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs
    .readFileSync(OUTBOX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function messagesFor(address) {
  return outbox().filter((mail) => String(mail.to).toLowerCase() === address.toLowerCase());
}

function tokenFrom(mail) {
  const match = String(mail.text).match(/token=([a-f0-9]{64})/);
  assert.ok(match, 'reset email must contain a 64-character token');
  return match[1];
}

const stamp = Date.now().toString().slice(-6);
const accounts = {
  admin: { email: `admin${stamp}@workbridge.test`, password: 'AdminPass#2024', role: 'admin' },
  worker: { email: `worker${stamp}@workbridge.test`, password: 'WorkerPass#2024', role: 'worker' },
  business: { email: `business${stamp}@workbridge.test`, password: 'BizPass#2024', role: 'business' }
};
const NEW_PASSWORD = 'ResetPass#2024';

const server = startServer({
  port: PORT,
  env: {
    DATA_DIR,
    SESSION_SECRET: 'reset-test-secret-reset-test-secret',
    EMAIL_CAPTURE_DIR: OUTBOX_DIR,
    MAIL_FROM,
    RESET_TTL_MS: String(RESET_TTL_MS)
  }
});
const unconfigured = startServer({
  port: UNCONFIGURED_PORT,
  env: { DATA_DIR: path.join(TMP, 'data-unconfigured'), SESSION_SECRET: 'reset-test-secret-reset-test-secret' }
});

const admin = client();
const worker = client();
const business = client();
const anon = client();
const unconfiguredClient = client(UNCONFIGURED_BASE);

try {
  await waitFor(BASE);
  await waitFor(UNCONFIGURED_BASE);

  console.log('\nWORKBRIDGE password reset');

  await step('administrator account is created for the test run', async () => {
    const res = await admin.post('/api/setup/admin', {
      email: accounts.admin.email,
      password: accounts.admin.password,
      full_name: 'Reset Test Admin'
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.user.role, 'admin');
  });

  await step('registration is set to automatic so accounts are active', async () => {
    const res = await admin.put('/api/admin/settings/registration', { worker: 'auto', business: 'auto' });
    assert.equal(res.status, 200, res.text);
  });

  await step('worker and business accounts register', async () => {
    const w = await worker.post('/api/auth/register', {
      role: 'worker',
      email: accounts.worker.email,
      password: accounts.worker.password,
      full_name: 'Reset Test Worker',
      phone: '+971500000011',
      category: 'Electrician',
      aqama: '784-1990-7654321-1',
      city: 'Dubai'
    });
    assert.equal(w.status, 201, w.text);
    assert.equal(w.json.user.role, 'worker');

    const b = await business.post('/api/auth/register', {
      role: 'business',
      email: accounts.business.email,
      password: accounts.business.password,
      full_name: 'Reset Test Business',
      phone: '+971500000012',
      company_name: 'Reset Test LLC',
      country: 'United Arab Emirates',
      address: 'Test Street 1'
    });
    assert.equal(b.status, 201, b.text);
    assert.equal(b.json.user.role, 'business');
  });

  for (const role of ['admin', 'business', 'worker']) {
    const account = accounts[role];

    await step(`${role}: reset link is emailed to the account's own address`, async () => {
      const res = await anon.post('/api/auth/forgot-password', { email: account.email });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.email_sent, true, 'the endpoint must report a real send');
      assert.ok(!res.json.dev_reset_url, 'no reset link may be returned to the browser');

      const mails = messagesFor(account.email);
      assert.equal(mails.length, 1, `expected exactly one email for ${account.email}`);
      assert.equal(String(mails[0].to).toLowerCase(), account.email.toLowerCase());
    });

    await step(`${role}: email is sent from MAIL_FROM, never the support mailbox`, async () => {
      const [mail] = messagesFor(account.email);
      assert.equal(mail.from, MAIL_FROM);
      assert.ok(
        !String(mail.from).toLowerCase().includes(SUPPORT_EMAIL.toLowerCase()),
        'the Help & Support mailbox must never send recovery mail'
      );
      assert.ok(!String(mail.to).toLowerCase().includes(SUPPORT_EMAIL.toLowerCase()));
      assert.match(mail.subject, /reset your password/i);
    });

    await step(`${role}: link resets the password and the new password signs in`, async () => {
      const token = tokenFrom(messagesFor(account.email)[0]);
      const reset = await anon.post('/api/auth/reset-password', { token, password: NEW_PASSWORD });
      assert.equal(reset.status, 200, reset.text);

      const fresh = client();
      const login = await fresh.post('/api/auth/login', {
        email: account.email,
        password: NEW_PASSWORD
      });
      assert.equal(login.status, 200, login.text);
      assert.equal(login.json.user.role, role);

      const me = await fresh.get('/api/auth/me');
      assert.equal(me.json.user.email, account.email);
    });

    await step(`${role}: the old password no longer works`, async () => {
      const login = await client().post('/api/auth/login', {
        email: account.email,
        password: account.password
      });
      assert.equal(login.status, 401);
      assert.equal(login.json.error, 'invalid_credentials');
    });

    await step(`${role}: the same link cannot be used twice`, async () => {
      const token = tokenFrom(messagesFor(account.email)[0]);
      const again = await anon.post('/api/auth/reset-password', { token, password: 'Another#2024' });
      assert.equal(again.status, 400);
      assert.equal(again.json.error, 'invalid_token');
    });
  }

  await step('an expired link is rejected', async () => {
    const before = messagesFor(accounts.worker.email).length;
    const res = await anon.post('/api/auth/forgot-password', { email: accounts.worker.email });
    assert.equal(res.status, 200, res.text);
    const mails = messagesFor(accounts.worker.email);
    assert.equal(mails.length, before + 1, 'a fresh link must be issued');
    const token = tokenFrom(mails[mails.length - 1]);

    await new Promise((resolve) => setTimeout(resolve, RESET_TTL_MS + 700));
    const expired = await anon.post('/api/auth/reset-password', { token, password: 'Late#2024' });
    assert.equal(expired.status, 400);
    assert.equal(expired.json.error, 'expired_token');
  });

  await step('unknown addresses do not leak account existence', async () => {
    const res = await anon.post('/api/auth/forgot-password', { email: `nobody${stamp}@workbridge.test` });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(messagesFor(`nobody${stamp}@workbridge.test`).length, 0);
  });

  await step('without a provider the endpoint reports the problem instead of a false success', async () => {
    const res = await unconfiguredClient.post('/api/auth/forgot-password', {
      email: accounts.worker.email
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'email_not_configured');
  });

  await step('no recovery email ever targets the support mailbox', async () => {
    const leaked = outbox().filter(
      (mail) =>
        String(mail.to).toLowerCase().includes(SUPPORT_EMAIL.toLowerCase()) ||
        String(mail.from).toLowerCase().includes(SUPPORT_EMAIL.toLowerCase())
    );
    assert.equal(leaked.length, 0, `${leaked.length} message(s) used the support mailbox`);
  });
} finally {
  server.kill('SIGTERM');
  unconfigured.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.message}`);
  process.exitCode = 1;
}
