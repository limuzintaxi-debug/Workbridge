#!/usr/bin/env node
/**
 * Focused browser check for the two reported issues.
 *
 * 1. Admin sign-in through the existing authentication system, including the
 *    first-run administrator path when no admin account exists yet.
 * 2. The Commission navigation link is addressed with the unambiguous
 *    topbar-scoped locator:
 *        page.locator('#topbar').getByRole('link', { name: 'Commission' })
 *
 * The previous locator a[href="#/admin/commission"] matches three links on the
 * admin overview page (topbar nav, the in-page tab list and the "Open commission
 * dashboard" button), so it must never be used again.
 *
 * Run with: npm run test:browser
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BROWSER_CHECK_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = 'admin@workbridge.test';
const ADMIN_PASSWORD = 'Admin#12345';
const BROWSER_MODULE =
  process.env.BROWSER_MODULE_PATH || '/opt/appjet/browser/node_modules/playwright/index.js';

const steps = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbridge-browser-'));
let serverLog = '';
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    DATA_DIR: dataDir,
    SETUP_TOKEN: '',
    SESSION_SECRET: 'browser-check-session-secret',
    // No demo seed: this run starts exactly like a fresh deployment.
    SEED_DEMO: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch (error) {
      // server not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

let browser = null;
try {
  const ready = await waitForServer();
  step(`local server ready on ${BASE}`, ready);
  if (!ready) throw new Error(`server did not start: ${serverLog.split('\n').slice(-4).join(' ')}`);

  // The shared browser runtime is a CommonJS package, so fall back to `default`.
  const playwright = await import(BROWSER_MODULE);
  const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
  if (!chromium) throw new Error(`Playwright chromium not available from ${BROWSER_MODULE}`);
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // 1. Admin sign-in page must offer the first-run administrator path.
  await page.goto(`${BASE}/#/admin/signin`);
  const setupLink = page
    .locator('#view')
    .getByRole('link', { name: /create the administrator account/i });
  await setupLink.waitFor({ state: 'visible', timeout: 15000 });
  step('admin sign-in offers the first-run administrator path', true);
  await setupLink.click();
  await page.locator('#setup-form').waitFor({ state: 'visible', timeout: 15000 });
  step('first-run administrator form opened', true);

  // 2. Create the administrator through the existing setup endpoint.
  await page.fill('#setup-form #full_name', 'WORKBRIDGE Administrator');
  await page.fill('#setup-form #email', ADMIN_EMAIL);
  await page.fill('#setup-form #password', ADMIN_PASSWORD);
  await page.locator('#setup-form button[type="submit"]').click();
  await page.waitForFunction(() => location.hash === '#/admin/signin', null, { timeout: 15000 });
  step('administrator created and redirected to admin sign-in', true);

  // 3. Admin sign-in with the existing authentication system.
  await page.fill('#auth-form #email', ADMIN_EMAIL);
  await page.fill('#auth-form #password', ADMIN_PASSWORD);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.waitForFunction(() => location.hash === '#/admin', null, { timeout: 15000 });
  await page.locator('#topbar').waitFor({ state: 'visible', timeout: 15000 });
  step('admin signed in and reached the admin dashboard', true);

  // 4. Commission link: prove the old locator is ambiguous, use the scoped one.
  const ambiguousCount = await page.locator('a[href="#/admin/commission"]').count();
  step('old locator a[href="#/admin/commission"] matches several links', ambiguousCount > 1, `${ambiguousCount} matches`);

  const commissionLink = page.locator('#topbar').getByRole('link', { name: 'Commission' });
  const scopedCount = await commissionLink.count();
  step(
    "locator('#topbar').getByRole('link', { name: 'Commission' }) is unique",
    scopedCount === 1,
    `${scopedCount} match(es)`
  );
  await commissionLink.click();
  await page.waitForFunction(() => location.hash === '#/admin/commission', null, { timeout: 15000 });
  await page
    .getByRole('heading', { name: 'Commission percentage' })
    .waitFor({ state: 'visible', timeout: 15000 });
  step('commission dashboard opened through the topbar-scoped link', true);

  step('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  step('browser check completed', false, String(error.message || error).split('\n')[0]);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failures = steps.filter((entry) => !entry.ok).length;
console.log(`\n${steps.length - failures}/${steps.length} browser checks passed.`);
process.exit(failures === 0 ? 0 : 1);
