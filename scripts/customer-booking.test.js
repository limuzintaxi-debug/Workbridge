#!/usr/bin/env node
/**
 * WORKBRIDGE — customer "Book Your Car" → four driver offers → customer picks.
 *
 * Boots the real server against a throwaway data directory and proves the whole
 * customer flow with one customer and FOUR separate driver accounts:
 *   1. A customer booking reaches every eligible, approved driver.
 *   2. Each of the four drivers submits their own price offer.
 *   3. The customer sees all four offers with driver, vehicle and price.
 *   4. The customer selects a driver (deliberately not the cheapest).
 *   5. Only the selected driver is assigned; the other offers close and those
 *      drivers can no longer read or act on the booking.
 *   6. The selected driver accepts and both sides see the confirmed status.
 *   7. Admin can monitor the booking and its status.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.CUSTOMER_TEST_PORT || 3209);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-customer-'));
const stamp = Date.now().toString(36);

const OWNER = { email: `cowner${stamp}@workbridge.test`, password: 'OwnerPass#123' };
const ADMIN = { email: `cadmin${stamp}@workbridge.test`, password: 'AdminPass#123' };
const CUSTOMER = { name: 'Test Customer', phone: '+966500007777' };

let child = null;
let passed = 0;
let failed = 0;

function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'customer-booking-test-secret-workbridge',
      NODE_ENV: 'test',
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
    if (!text.includes('Supabase sync failed') && !text.includes('Supabase load failed')) {
      process.stderr.write(`[server] ${text}`);
    }
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
    }
  };
}

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

const anon = client();
const owner = client();
const admin = client();
const drivers = [client(), client(), client(), client()];
const driverIds = [];
let token = null;
let bookingId = null;

console.log('\nWORKBRIDGE — customer booking to four driver offers\n');

await start();
await waitForServer();

await step('owner setup, a global admin, and ride booking enabled', async () => {
  const created = await anon.post('/api/setup/admin', {
    email: OWNER.email,
    password: OWNER.password,
    full_name: 'Platform Owner'
  });
  assert.equal(created.status, 201, created.text);

  const login = await owner.post('/api/auth/login', OWNER);
  assert.equal(login.status, 200, login.text);

  const madeAdmin = await owner.post('/api/owner/admins/create', {
    email: ADMIN.email,
    full_name: 'Global Admin',
    password: ADMIN.password,
    scope: { level: 'global', mode: 'global' }
  });
  assert.equal(madeAdmin.status, 201, madeAdmin.text);

  const adminLogin = await admin.post('/api/auth/login', ADMIN);
  assert.equal(adminLogin.status, 200, adminLogin.text);
  assert.equal(adminLogin.json.user.role, 'admin');

  const enabled = await owner.patch('/api/ride-booking/settings', { enabled: true });
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.enabled, true);
});

await step('the public booking flag is open while admin settings stay protected', async () => {
  // A brand-new client: `anon` already carries the owner session cookie from setup.
  const visitor = client();

  const open = await visitor.get('/api/ride-bookings/open');
  assert.equal(open.status, 200, open.text);
  assert.equal(open.json.open, true);
  assert.deepEqual(open.json.categories, ['Small Car', 'Go', 'Business', 'VIP']);
  assert.equal(open.json.workers, undefined, 'the public flag never exposes worker data');

  // The admin settings endpoint stays behind the admin role: 401 without a session.
  const settings = await visitor.get('/api/ride-booking/settings');
  assert.equal(settings.status, 401, settings.text);
});

await step('four separate drivers register in Riyadh and admin approves them for VIP', async () => {
  for (let i = 0; i < 4; i += 1) {
    const reg = await drivers[i].post('/api/auth/register', {
      role: 'worker',
      email: `cdriver${i}${stamp}@workbridge.test`,
      password: 'Driver#1234',
      full_name: `Customer Flow Driver ${i + 1}`,
      phone: `+966500009${String(i).padStart(2, '0')}`,
      category: 'Driver',
      aqama: `32345678${i}0`,
      city: 'Riyadh',
      country: 'Saudi Arabia'
    });
    assert.equal(reg.status, 201, reg.text);
    driverIds.push(reg.json.user.id);

    const approved = await admin.patch(`/api/admin/drivers/${reg.json.user.id}/booking`, {
      booking_approved: true,
      vehicle_categories: ['VIP'],
      vehicle_name: `Customer Vehicle ${i + 1}`
    });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.json.driver.booking_approved, true);
  }
});

await step('a customer booking reaches all four eligible drivers', async () => {
  const res = await anon.post('/api/ride-bookings', {
    category: 'VIP',
    pickup: 'Riyadh Airport Terminal 5',
    destination: 'Kingdom Centre',
    date: '2026-12-05',
    time: '14:30',
    details: 'Two passengers, one suitcase. Flight SV553.',
    customer_name: CUSTOMER.name,
    customer_phone: CUSTOMER.phone
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.booking.status, 'created');
  assert.equal(res.json.notified_drivers, 4, 'all four eligible drivers must be notified');
  assert.ok(res.json.track_token, 'the customer receives a private tracking token');
  token = res.json.track_token;
  bookingId = res.json.booking.id;

  for (let i = 0; i < 4; i += 1) {
    const available = await drivers[i].get('/api/bookings/available');
    assert.equal(available.status, 200, available.text);
    const ids = available.json.bookings.map((b) => b.id);
    assert.ok(ids.includes(bookingId), `driver ${i + 1} must receive the customer booking`);
  }
});

await step('each of the four drivers submits their own price offer', async () => {
  const prices = [500, 400, 300, 450];
  for (let i = 0; i < 4; i += 1) {
    const res = await drivers[i].post(`/api/bookings/${bookingId}/offers`, {
      vehicle_name: `Customer Vehicle ${i + 1}`,
      vehicle_category: 'VIP',
      price: prices[i]
    });
    assert.ok([200, 201].includes(res.status), res.text);
  }
});

await step('the customer sees every offer with driver, vehicle and price', async () => {
  const res = await anon.get(`/api/ride-bookings/track/${token}`);
  assert.equal(res.status, 200, res.text);
  const booking = res.json.booking;
  assert.equal(booking.status, 'offers');
  assert.equal(booking.offers.length, 4, 'the customer must see all four offers');
  const prices = booking.offers.map((o) => Number(o.price)).sort((a, b) => a - b);
  assert.deepEqual(prices, [300, 400, 450, 500]);
  assert.ok(
    booking.offers.every((o) => o.vehicle_name && o.driver_name),
    'each offer names the driver and the vehicle'
  );
  assert.ok(booking.currency, 'the offers carry the configured currency');
});

await step('the customer selects a driver (deliberately not the cheapest)', async () => {
  const view = await anon.get(`/api/ride-bookings/track/${token}`);
  const target = view.json.booking.offers.find((o) => Number(o.price) === 400);
  assert.ok(target, 'the 400 offer must be visible to the customer');

  const res = await anon.post(`/api/ride-bookings/track/${token}/select`, { offer_id: target.id });
  assert.equal(res.status, 200, res.text);
  // Selection assigns the booking to that one driver and asks them to confirm.
  assert.equal(res.json.booking.status, 'selected');
  assert.equal(
    res.json.booking.selected_driver_id,
    driverIds[1],
    'the booking is assigned to the chosen driver only'
  );

  const after = await anon.get(`/api/ride-bookings/track/${token}`);
  assert.equal(after.json.booking.offers.length, 1, 'the other offers are closed');
  assert.equal(Number(after.json.booking.offers[0].price), 400);
  assert.equal(after.json.booking.closed_offer_count, 3, 'the three losing offers are closed');
  assert.ok(
    after.json.booking.selected_driver.phone,
    'the chosen driver contact is shared as soon as the customer selects them'
  );
});

await step('non-selected drivers cannot act and never receive contact details', async () => {
  const accept = await drivers[0].post(`/api/bookings/${bookingId}/accept`, {});
  assert.equal(accept.status, 403, accept.text);
  assert.equal(accept.json.error, 'not_selected');

  // An offering driver may track the booking, but the customer's private phone
  // number must never reach a driver who was not chosen.
  const view = await drivers[0].get(`/api/bookings/${bookingId}`);
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.booking.status, 'selected');
  assert.ok(
    !view.text.includes(CUSTOMER.phone),
    'a non-selected driver must not receive the customer phone number'
  );

  const available = await drivers[0].get('/api/bookings/available');
  assert.equal(available.status, 200, available.text);
  assert.ok(
    !available.json.bookings.some((b) => b.id === bookingId),
    'a selected booking is no longer open for offers'
  );
});

await step('the selected driver confirms the booking and both sides see it', async () => {
  const accept = await drivers[1].post(`/api/bookings/${bookingId}/accept`, {});
  assert.equal(accept.status, 200, accept.text);
  assert.equal(accept.json.booking.status, 'confirmed', 'Confirm Booking confirms the ride');

  const twice = await drivers[1].post(`/api/bookings/${bookingId}/accept`, {});
  assert.equal(twice.status, 200, 'confirmation stays idempotent');
  assert.equal(twice.json.booking.status, 'confirmed');

  const mine = await drivers[1].get('/api/bookings/driver/mine');
  assert.equal(mine.status, 200, mine.text);
  const assigned = mine.json.bookings.find((b) => b.id === bookingId);
  assert.ok(assigned, 'the selected driver sees the booking');
  assert.equal(assigned.status, 'confirmed');

  const customer = await anon.get(`/api/ride-bookings/track/${token}`);
  assert.equal(customer.json.booking.status, 'confirmed');
  assert.equal(
    customer.json.booking.selected_driver.name,
    'Customer Flow Driver 2',
    'the customer sees the driver they chose'
  );
  assert.ok(
    customer.json.booking.selected_driver.phone,
    'the customer receives the driver phone number after confirmation'
  );
});

await step('admin can monitor the booking and its status', async () => {
  const res = await admin.get('/api/admin/bookings');
  assert.equal(res.status, 200, res.text);
  const row = res.json.bookings.find((b) => b.id === bookingId);
  assert.ok(row, 'admin must see the customer booking');
  assert.equal(row.status, 'confirmed');
  assert.equal(row.selected_driver_id, driverIds[1]);
});

await step('the chosen driver receives the complete booking details', async () => {
  const mine = await drivers[1].get('/api/bookings/driver/mine');
  const assigned = mine.json.bookings.find((b) => b.id === bookingId);
  assert.ok(assigned, 'the chosen driver sees the booking');
  assert.equal(assigned.status, 'confirmed');
  assert.equal(assigned.kind, 'customer');
  assert.ok(assigned.pickup, 'pickup is shown to the driver');
  assert.ok(assigned.destination, 'destination is shown to the driver');
  assert.ok(assigned.date, 'the date is shown to the driver');
  assert.ok(assigned.vehicle_category, 'the vehicle category is shown');
  assert.ok(assigned.selected_price, 'the agreed price is shown');
  assert.ok(
    assigned.customer && assigned.customer.phone,
    'the chosen driver receives the customer phone number'
  );
  assert.equal(assigned.contact_hidden, false, 'contacts are visible while the ride is running');
});

await step('completing the booking removes the phone numbers but keeps the record', async () => {
  for (const stage of ['pickup', 'dropoff', 'complete-order']) {
    const res = await drivers[1].post(`/api/bookings/${bookingId}/${stage}`, {});
    assert.equal(res.status, 200, `${stage}: ${res.text}`);
  }

  // A public customer booking has no business account, so its driver records
  // the fare received before the booking can be completed.
  const paid = await drivers[1].post(`/api/bookings/${bookingId}/payment`, {
    amount: 300,
    reference: 'CASH-TEST-1',
    method: 'cash'
  });
  assert.equal(paid.status, 200, paid.text);

  const done = await drivers[1].post(`/api/bookings/${bookingId}/finalize`, {});
  assert.equal(done.status, 200, done.text);

  // Driver dashboard: the customer's number is gone, everything else remains.
  const mine = await drivers[1].get('/api/bookings/driver/mine');
  const assigned = mine.json.bookings.find((b) => b.id === bookingId);
  assert.equal(assigned.status, 'completed');
  assert.equal(assigned.contact_hidden, true);
  assert.equal(
    assigned.customer.phone,
    '',
    'the customer phone number is removed from the driver dashboard'
  );
  assert.ok(assigned.ref, 'the booking reference is kept');
  assert.ok(assigned.pickup && assigned.destination, 'the route is kept');
  assert.ok(assigned.selected_price, 'the agreed price is kept');
  assert.ok(assigned.payment && assigned.payment.amount, 'the payment record is kept');

  // Customer page: the driver's number is gone, the booking stays readable.
  const customer = await anon.get(`/api/ride-bookings/track/${token}`);
  const booking = customer.json.booking;
  assert.equal(booking.status, 'completed');
  assert.equal(booking.contact_hidden, true);
  assert.equal(
    booking.selected_driver.phone,
    '',
    'the driver phone number is removed from the customer dashboard'
  );
  assert.ok(booking.ref, 'the customer keeps the booking reference');
  assert.ok(booking.selected_driver.name, 'the customer keeps the driver name');
});

if (child) child.kill();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
