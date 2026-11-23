#!/usr/bin/env node
/**
 * Regression coverage for the WORKBRIDGE feature upgrade.
 *
 * Boots the real server against a throwaway data directory and exercises:
 *   1. Owner Admin vs Primary Admin: admin application → owner approval with a
 *      regional scope → backend enforcement of that scope.
 *   2. Book Your Car: four categories, public booking, global ON/OFF and the
 *      per-worker ON/OFF switch (ordinary workers must never receive bookings).
 *   3. WORKBRIDGE MALL: vehicle buy & sell and electronic discount shops.
 *   4. Open agreements: a worker starts one, the business accepts it.
 *
 * Run with: npm run test:features
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_FEATURES_PORT || 3205);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-features-'));
const stamp = Date.now().toString(36);

// 1x1 PNG — enough to prove the image pipeline accepts a real data URL.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let child = null;
let passed = 0;

function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'features-test-session-secret-workbridge',
      NODE_ENV: 'test',
      // Deterministic first-run setup: ignore any SETUP_TOKEN from the host env.
      SETUP_TOKEN: '',
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
    },
    patch(url, body) {
      return this.call('PATCH', url, body);
    },
    del(url) {
      return this.call('DELETE', url);
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
const worker = client();
const worker2 = client();
const business = client();
const otherBusiness = client();
const regionalAdmin = client();

try {
  start();
  await waitForServer();
  console.log('\nWORKBRIDGE feature test\n');

  let workerId = null;

  await step('the first administrator is the platform owner', async () => {
    const created = await anon.post('/api/setup/admin', {
      email: `owner${stamp}@workbridge.test`,
      password: 'Owner#12345',
      full_name: 'Platform Owner'
    });
    assert.equal(created.status, 201, created.text);

    const login = await owner.post('/api/auth/login', {
      email: `owner${stamp}@workbridge.test`,
      password: 'Owner#12345'
    });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.user.role, 'owner');

    const panel = await owner.get('/api/admin/overview');
    assert.equal(panel.status, 200, 'the owner keeps full Primary Admin access');
  });

  await step('a worker and two businesses register', async () => {
    const w = await worker.post('/api/auth/register', {
      role: 'worker',
      email: `ride-worker${stamp}@workbridge.test`,
      password: 'Worker#12345',
      full_name: 'Ride Worker',
      phone: '+971500000111',
      category: 'Driver',
      aqama: '784-1990-1111111-1',
      city: 'Dubai',
      country: 'United Arab Emirates'
    });
    assert.equal(w.status, 201, w.text);
    const workerMe = await worker.get('/api/auth/me');
    workerId = workerMe.json.user.id;

    const w2 = await worker2.post('/api/auth/register', {
      role: 'worker',
      email: `plain-worker${stamp}@workbridge.test`,
      password: 'Worker#12345',
      full_name: 'Plain Worker',
      phone: '+971500000112',
      category: 'Laborer',
      aqama: '784-1990-2222222-2',
      city: 'Dubai',
      country: 'United Arab Emirates'
    });
    assert.equal(w2.status, 201, w2.text);

    const b = await business.post('/api/auth/register', {
      role: 'business',
      email: `mall-biz${stamp}@workbridge.test`,
      password: 'Business#12345',
      full_name: 'Mall Owner',
      phone: '+971500000222',
      company_name: 'Mall Demo LLC',
      country: 'United Arab Emirates',
      address: 'Demo Street 2'
    });
    assert.equal(b.status, 201, b.text);

    const b2 = await otherBusiness.post('/api/auth/register', {
      role: 'business',
      email: `other-biz${stamp}@workbridge.test`,
      password: 'Business#12345',
      full_name: 'Other Owner',
      phone: '+971500000333',
      company_name: 'Other Demo LLC',
      country: 'United Arab Emirates',
      address: 'Demo Street 3'
    });
    assert.equal(b2.status, 201, b2.text);
  });

  /* --------------------------------------------------- owner / admin scope */

  let regionalAdminId = null;

  await step('anyone can apply for admin access and it waits for the owner', async () => {
    const applied = await anon.post('/api/admin-applications', {
      email: `regional-admin${stamp}@workbridge.test`,
      password: 'Admin#12345',
      full_name: 'Regional Admin',
      phone: '+966500000444',
      country: 'Saudi Arabia',
      city: 'Riyadh',
      requested_scope: 'regional',
      note: 'Please allow me to manage Riyadh.'
    });
    assert.equal(applied.status, 201, applied.text);

    const queue = await owner.get('/api/admin-applications');
    assert.equal(queue.status, 200, queue.text);
    const entry = queue.json.admins.find(
      (a) => a.email === `regional-admin${stamp}@workbridge.test`
    );
    assert.ok(entry, 'the application must appear in the owner queue');
    assert.equal(entry.status, 'pending');
    regionalAdminId = entry.id;

    const before = await regionalAdmin.post('/api/auth/login', {
      email: `regional-admin${stamp}@workbridge.test`,
      password: 'Admin#12345'
    });
    assert.equal(before.status, 403, 'a pending admin application must not be able to sign in');
  });

  await step('only the owner can approve an admin', async () => {
    const denied = await worker.post(`/api/admin-applications/${regionalAdminId}/approve`, {
      scope: { level: 'global' }
    });
    assert.equal(denied.status, 403);

    const approved = await owner.post(`/api/admin-applications/${regionalAdminId}/approve`, {
      scope: { level: 'regional', country: 'Saudi Arabia', city: 'Riyadh' }
    });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json.admin.status, 'active');
    assert.equal(approved.json.admin.scope.level, 'regional');
  });

  await step('the approved regional admin signs in and reaches the admin panel', async () => {
    const login = await regionalAdmin.post('/api/auth/login', {
      email: `regional-admin${stamp}@workbridge.test`,
      password: 'Admin#12345'
    });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.user.role, 'admin');

    const overview = await regionalAdmin.get('/api/admin/overview');
    assert.equal(overview.status, 200, overview.text);
  });

  await step('regional scope is enforced by the backend, not just hidden in the UI', async () => {
    const global = await regionalAdmin.patch('/api/ride-booking/settings', { enabled: false });
    assert.equal(global.status, 403, 'a regional admin cannot change a global switch');

    const outOfScope = await regionalAdmin.patch(`/api/ride-booking/workers/${workerId}`, {
      enabled: true
    });
    assert.equal(outOfScope.status, 403);
    assert.equal(outOfScope.json.error, 'out_of_scope');

    const ownerOnly = await regionalAdmin.get('/api/admin-applications');
    assert.equal(ownerOnly.status, 403, 'admin applications are owner-only');
  });

  /* ---------------------------------------------------------- ride booking */

  let bookingId = null;
  let trackToken = null;

  await step('an ordinary worker never receives ride bookings', async () => {

    const list = await worker.get('/api/ride-bookings');
    assert.equal(list.status, 403, 'ride booking must be off until the admin enables it');
    assert.equal(list.json.error, 'ride_booking_disabled');
  });

  await step('admin enables ride booking for one specific worker', async () => {
    const enabled = await owner.patch(`/api/ride-booking/workers/${workerId}`, { enabled: true });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.worker.ride_booking_enabled, true);

    const settings = await owner.get('/api/ride-booking/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.json.enabled, true, 'ride booking is globally on by default');

    const now = await worker.get('/api/ride-bookings');
    assert.equal(now.status, 200, now.text);

    const stillOff = await worker2.get('/api/ride-bookings');
    assert.equal(stillOff.status, 403, 'the second worker was never enabled');
  });

  await step('a customer books a car in one step and the enabled worker sees it', async () => {
    // A ride is distributed only to drivers approved for its vehicle category,
    // so the owner approves this driver for VIP first.
    const approve = await owner.patch(`/api/admin/drivers/${workerId}/booking`, {
      booking_approved: true,
      vehicle_categories: ['VIP']
    });
    assert.equal(approve.status, 200, approve.text);

    const created = await anon.post('/api/ride-bookings', {
      category: 'VIP',
      details: 'Airport pickup at 18:00, two bags, terminal 3.',
      customer_name: 'Demo Customer',
      customer_phone: '+971500000999'
    });
    assert.equal(created.status, 201, created.text);
    assert.match(created.json.booking.ref, /^WB-RIDE-\d+$/);
    bookingId = created.json.booking.id;
    trackToken = created.json.track_token;

    const list = await worker.get('/api/ride-bookings');
    const found = list.json.bookings.find((b) => b.id === bookingId);
    assert.ok(found, 'the enabled worker must receive the booking');
    // The driver list returns the stored ride record, whose field is
    // vehicle_category (the customer view renames it to category).
    assert.equal(found.vehicle_category, 'VIP');

    // The driver answers with the two things the offer form asks for.
    const offer = await worker.post(`/api/bookings/${bookingId}/offers`, {
      vehicle_name: 'GMC Yukon',
      price: 250
    });
    assert.ok([200, 201].includes(offer.status), offer.text);

    const tracked = await anon.get(`/api/ride-bookings/track/${trackToken}`);
    assert.equal(tracked.status, 200, tracked.text);
    const offers = tracked.json.booking.offers || [];
    const picked = offers.find((o) => o.vehicle_name === 'GMC Yukon');
    assert.ok(picked, 'the customer sees the driver vehicle and price');
    assert.equal(Number(picked.price), 250);

    const selected = await anon.post(`/api/ride-bookings/track/${trackToken}/select`, {
      offer_id: picked.id
    });
    assert.equal(selected.status, 200, selected.text);

    const confirmed = await worker.post(`/api/bookings/${bookingId}/accept`);
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.json.booking.status, 'confirmed');
  });

  await step('all four vehicle categories are accepted and unknown ones rejected', async () => {
    for (const category of ['Small Car', 'Go', 'Business', 'VIP']) {
      const res = await anon.post('/api/ride-bookings', {
        category,
        details: `Booking for ${category}`
      });
      assert.equal(res.status, 201, `${category}: ${res.text}`);
      assert.equal(res.json.booking.category, category);
    }

    const bad = await anon.post('/api/ride-bookings', {
      category: 'Helicopter',
      details: 'Not a car'
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_category');
  });

  await step('the global OFF switch stops distributing ride bookings', async () => {
    const off = await owner.patch('/api/ride-booking/settings', { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.enabled, false);

    const blocked = await worker.get('/api/ride-bookings');
    assert.equal(blocked.status, 403, 'no new bookings while the global switch is off');

    const booking = await anon.post('/api/ride-bookings', {
      category: 'Go',
      details: 'Should be refused'
    });
    assert.equal(booking.status, 503);
    assert.equal(booking.json.error, 'ride_booking_disabled');

    await owner.patch('/api/ride-booking/settings', { enabled: true });
  });

  await step('disabling one worker leaves ordinary work requests untouched', async () => {
    const off = await owner.patch(`/api/ride-booking/workers/${workerId}`, { enabled: false });
    assert.equal(off.status, 200, off.text);

    const blocked = await worker.get('/api/ride-bookings');
    assert.equal(blocked.status, 403);

    const jobs = await worker.get('/api/jobs');
    assert.equal(jobs.status, 200, 'regular work requests keep working independently');
  });

  /* ------------------------------------------------------------------ mall */

  let shopId = null;
  let productId = null;
  let vehicleId = null;

  await step('a business posts a vehicle for sale with one photo and one text box', async () => {
    const created = await business.post('/api/mall/vehicles', {
      description: 'Toyota Corolla 2019, 90,000 km, AED 42,000, Dubai. Call for viewing.',
      price: 42000,
      currency: 'AED',
      location: 'Dubai',
      image: PNG,
      contact_phone: '+971500000222'
    });
    assert.equal(created.status, 201, created.text);
    vehicleId = created.json.vehicle.id;
    assert.equal(created.json.vehicle.image, PNG);

    const publicList = await anon.get('/api/mall/vehicles');
    const found = publicList.json.vehicles.find((v) => v.id === vehicleId);
    assert.ok(found, 'the published vehicle must be publicly visible');
    assert.match(found.description, /Toyota Corolla/);
    assert.equal(found.contact_phone, '+971500000222');
  });

  await step('only the seller or an admin can edit or remove a vehicle', async () => {
    const denied = await otherBusiness.patch(`/api/mall/vehicles/${vehicleId}`, {
      price: 1
    });
    assert.equal(denied.status, 403);

    const deniedDelete = await otherBusiness.del(`/api/mall/vehicles/${vehicleId}`);
    assert.equal(deniedDelete.status, 403);

    const edited = await business.patch(`/api/mall/vehicles/${vehicleId}`, { price: 40000 });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.vehicle.price, 40000);
  });

  await step('a shop is created with name, phone and address on one line', async () => {
    const created = await business.post('/api/mall/shops', {
      name: 'Demo Electronics',
      phone: '+971500000222',
      address: 'Shop 12, Demo Mall, Dubai'
    });
    assert.equal(created.status, 201, created.text);
    shopId = created.json.shop.id;

    const shops = await anon.get('/api/mall/shops');
    const found = shops.json.shops.find((s) => s.id === shopId);
    assert.ok(found, 'the shop must be publicly visible');
    assert.equal(found.phone, '+971500000222');
    assert.equal(found.address, 'Shop 12, Demo Mall, Dubai');
  });

  await step('a discounted product is marked as a DISCOUNT listing', async () => {
    const created = await business.post('/api/mall/products', {
      shop_id: shopId,
      title: 'Blender',
      details: '750W blender, original 200, now 120.',
      original_price: 200,
      discounted_price: 120,
      currency: 'AED',
      image: PNG
    });
    assert.equal(created.status, 201, created.text);
    productId = created.json.product.id;
    assert.equal(created.json.product.discount, true);

    const list = await anon.get(`/api/mall/products?shop_id=${shopId}`);
    const found = list.json.products.find((p) => p.id === productId);
    assert.ok(found, 'the product must be publicly visible');
    assert.equal(found.discount, true);
    assert.equal(found.original_price, 200);
    assert.equal(found.discounted_price, 120);
  });

  await step('non-discounted products are allowed and images are validated', async () => {
    const plain = await business.post('/api/mall/products', {
      shop_id: shopId,
      title: 'Cable',
      details: 'HDMI cable, 25.',
      original_price: 25,
      discounted_price: 0
    });
    assert.equal(plain.status, 201, plain.text);
    assert.equal(plain.json.product.discount, false);

    const bad = await business.post('/api/mall/products', {
      shop_id: shopId,
      details: 'Fake image',
      image: 'not-an-image'
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_image');
  });

  await step('shop owners manage their own listings and others cannot', async () => {
    const denied = await otherBusiness.patch(`/api/mall/products/${productId}`, {
      discounted_price: 1
    });
    assert.equal(denied.status, 403);

    const edited = await business.patch(`/api/mall/products/${productId}`, {
      discounted_price: 100
    });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.product.discounted_price, 100);

    const removed = await business.del(`/api/mall/products/${productId}`);
    assert.equal(removed.status, 200, removed.text);

    const list = await anon.get(`/api/mall/products?shop_id=${shopId}`);
    assert.ok(!list.json.products.some((p) => p.id === productId), 'removed products disappear');
  });

  /* ------------------------------------------------------ open agreements */

  let agreementId = null;

  await step('a worker can create an agreement at any time, without waiting', async () => {
    const created = await worker.post('/api/agreements/open', {
      counterparty_name: 'Mall Demo LLC',
      counterparty_phone: '+971500000222',
      counterparty_email: `mall-biz${stamp}@workbridge.test`,
      scope: 'Deliver goods between Dubai and Sharjah for two weeks.',
      terms: 'Payment every Friday. Fuel included. Vehicle provided by the business.',
      start_date: '2026-12-01',
      end_date: '2026-12-14',
      pay_amount: 1500,
      pay_period: 'week',
      currency: 'AED',
      stamp_image: PNG
    });
    assert.equal(created.status, 201, created.text);
    assert.match(created.json.agreement.ref, /^WB-AGR-/);
    assert.equal(created.json.agreement.acceptance_status, 'pending');
    assert.equal(created.json.agreement.stamp_image, PNG);
    agreementId = created.json.agreement.id;
  });

  await step('the agreement requires work description and terms', async () => {
    const missing = await worker.post('/api/agreements/open', {
      counterparty_name: 'Nobody',
      scope: '',
      terms: ''
    });
    assert.equal(missing.status, 400);
  });

  await step('the other party reviews and accepts the agreement', async () => {
    const list = await business.get('/api/agreements');
    const found = list.json.agreements.find((a) => a.id === agreementId);
    assert.ok(found, 'the invited business must see the agreement');
    assert.equal(found.acceptance_status, 'pending');

    const selfAccept = await worker.post(`/api/agreements/${agreementId}/respond`, {
      decision: 'accepted'
    });
    assert.equal(selfAccept.status, 403, 'the creator cannot accept on behalf of the other side');

    const accepted = await business.post(`/api/agreements/${agreementId}/respond`, {
      decision: 'accepted'
    });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.agreement.acceptance_status, 'accepted');

    const after = await worker.get(`/api/agreements/${agreementId}`);
    assert.equal(after.json.agreement.acceptance_status, 'accepted');
  });

  await step('a business can also start an agreement towards a worker', async () => {
    const created = await business.post('/api/agreements/open', {
      counterparty_name: 'Plain Worker',
      counterparty_email: `plain-worker${stamp}@workbridge.test`,
      scope: 'Warehouse shift work.',
      terms: 'Eight hours per day, paid weekly.',
      pay_amount: 300,
      pay_period: 'day'
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.agreement.acceptance_status, 'pending');

    const list = await worker2.get('/api/agreements');
    const found = list.json.agreements.find((a) => a.id === created.json.agreement.id);
    assert.ok(found, 'the invited worker must see the agreement');

    const rejected = await worker2.post(`/api/agreements/${created.json.agreement.id}/respond`, {
      decision: 'rejected'
    });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(rejected.json.agreement.acceptance_status, 'rejected');
  });

  console.log(`\n${passed} passed\n`);
} catch (error) {
  console.error(`\n${error.stack || error.message}\n`);
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(dataDir, { recursive: true, force: true });
}
