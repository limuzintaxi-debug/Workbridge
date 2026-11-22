#!/usr/bin/env node
/**
 * Administrator authentication regression coverage.
 *
 * Boots the real server against a throwaway data directory and proves:
 *   1. A fresh installation reports no administrator and offers recovery.
 *   2. Public registration can never create an admin/owner account.
 *   3. The first administrator created through the setup endpoint is the owner.
 *   4. Owner password recovery is refused without the server setup token and
 *      succeeds with it, invalidating the previous password.
 *   5. The recovered owner can sign in and reach the protected admin overview.
 *
 * Run with: npm run test:admin
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_ADMIN_PORT || 3207);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_TOKEN = 'admin-auth-test-setup-token-0001';
const OWNER_EMAIL = 'owner.admin.test@workbridge.test';
const FIRST_PASSWORD = 'OwnerFirst#2026';
const SECOND_PASSWORD = 'OwnerSecond#2026';
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-admin-auth-'));

let child = null;
let passed = 0;

function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'admin-auth-test-session-secret-workbridge',
      SETUP_TOKEN,
      NODE_ENV: 'test',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      EMAIL_CAPTURE_DIR: path.join(dataDir, 'outbox')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (data) => {
    const text = String(data);
    if (!text.includes('Supabase sync failed')) process.stderr.write(`[server] ${text}`);
  });
}

async function waitForServer() {
  for (let i = 0; i < 160; i += 1) {
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

function client() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(`${BASE}${url}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
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
    },
    get(url) {
      return this.call('GET', url);
    },
    post(url, body) {
      return this.call('POST', url, body);
    }
  };
}

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}`);
    throw error;
  }
}

const anon = client();
const owner = client();

try {
  start();
  await waitForServer();
  console.log('\nWORKBRIDGE administrator authentication test\n');

  await step('a fresh installation reports no administrator', async () => {
    const res = await anon.get('/api/auth/owner-status');
    assert.equal(res.status, 200);
    assert.equal(res.json.owner_exists, false);
    assert.equal(res.json.admin_count, 0);
    assert.equal(res.json.setup_required, true);
    assert.equal(res.json.recovery_enabled, true);
    assert.equal(res.json.owner_email_masked, '');
  });

  await step('public registration cannot create an admin account', async () => {
    const res = await anon.post('/api/auth/register', {
      role: 'admin',
      email: 'self.registered.admin@workbridge.test',
      password: 'SelfAdmin#2026',
      full_name: 'Self Registered Admin'
    });
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
    assert.notEqual(res.json && res.json.user && res.json.user.role, 'admin');
  });

  await step('public registration cannot create an owner account', async () => {
    const res = await anon.post('/api/auth/register', {
      role: 'owner',
      email: 'self.registered.owner@workbridge.test',
      password: 'SelfOwner#2026',
      full_name: 'Self Registered Owner'
    });
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  });

  await step('the first administrator created through setup is the owner', async () => {
    const res = await anon.post('/api/setup/admin', {
      email: OWNER_EMAIL,
      password: FIRST_PASSWORD,
      full_name: 'WORKBRIDGE Owner',
      setup_token: SETUP_TOKEN
    });
    assert.ok(res.status === 200 || res.status === 201, `setup failed with ${res.status}`);
    assert.equal(res.json.user.role, 'owner');
  });

  await step('the owner status endpoint masks the administrator email', async () => {
    const res = await anon.get('/api/auth/owner-status');
    assert.equal(res.json.owner_exists, true);
    assert.equal(res.json.setup_required, false);
    assert.ok(res.json.owner_email_masked.includes('***'));
    assert.ok(!res.json.owner_email_masked.includes(OWNER_EMAIL));
  });

  await step('a second setup attempt cannot create another administrator', async () => {
    const res = await anon.post('/api/setup/admin', {
      email: 'second.owner@workbridge.test',
      password: 'SecondOwner#2026',
      full_name: 'Second Owner',
      setup_token: SETUP_TOKEN
    });
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  });

  await step('the owner can sign in with the created password', async () => {
    const res = await owner.post('/api/auth/login', { email: OWNER_EMAIL, password: FIRST_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.role, 'owner');
  });

  await step('the owner session reaches the protected admin overview', async () => {
    const res = await owner.get('/api/admin/overview');
    assert.equal(res.status, 200);
    assert.ok(res.json && typeof res.json === 'object');
  });

  await step('owner recovery is refused without the setup token', async () => {
    const res = await anon.post('/api/auth/owner-recover', {
      email: OWNER_EMAIL,
      password: SECOND_PASSWORD
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'invalid_setup_token');
  });

  await step('owner recovery is refused with a wrong setup token', async () => {
    const res = await anon.post('/api/auth/owner-recover', {
      email: OWNER_EMAIL,
      password: SECOND_PASSWORD,
      setup_token: 'not-the-configured-token'
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'invalid_setup_token');
  });

  await step('owner recovery refuses a short password', async () => {
    const res = await anon.post('/api/auth/owner-recover', {
      email: OWNER_EMAIL,
      password: 'short',
      setup_token: SETUP_TOKEN
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'weak_password');
  });

  await step('owner recovery refuses a non-administrator email', async () => {
    const res = await anon.post('/api/auth/owner-recover', {
      email: 'worker@workbridge.test',
      password: SECOND_PASSWORD,
      setup_token: SETUP_TOKEN
    });
    assert.equal(res.status, 404);
  });

  await step('owner recovery with the setup token sets the new password', async () => {
    const res = await anon.post('/api/auth/owner-recover', {
      email: OWNER_EMAIL,
      password: SECOND_PASSWORD,
      setup_token: SETUP_TOKEN
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.role, 'owner');
  });

  await step('the previous owner password no longer works', async () => {
    const res = await anon.post('/api/auth/login', { email: OWNER_EMAIL, password: FIRST_PASSWORD });
    assert.equal(res.status, 401);
  });

  await step('the recovered owner password signs in to the admin panel', async () => {
    const recovered = client();
    const login = await recovered.post('/api/auth/login', { email: OWNER_EMAIL, password: SECOND_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.role, 'owner');
    const overview = await recovered.get('/api/admin/overview');
    assert.equal(overview.status, 200);
  });

  await step('a worker account is refused access to admin endpoints', async () => {
    const worker = client();
    const signup = await worker.post('/api/auth/register', {
      role: 'worker',
      email: 'admin-auth.worker@workbridge.test',
      password: 'WorkerPass#2026',
      full_name: 'Admin Auth Worker',
      phone: '+966500000000',
      category: 'Driver'
    });
    assert.ok(signup.status === 200 || signup.status === 201, `worker signup failed ${signup.status}`);
    const overview = await worker.get('/api/admin/overview');
    assert.equal(overview.status, 403);
  });

  console.log(`\n${passed} administrator authentication checks passed\n`);
} catch (error) {
  console.error(`\n${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
}
