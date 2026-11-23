#!/usr/bin/env node
/**
 * WORKBRIDGE — four panels, booking lifecycle and permission regression test.
 *
 * Boots the real server against a throwaway data directory and proves:
 *   1. Owner privacy, and owner-only creation/approval/suspension of admins with
 *      global or regional scope.
 *   2. Admin limits: cannot see or modify the owner, cannot manage another admin,
 *      cannot widen its own authority.
 *   3. Business bookings reach only eligible drivers (approved, right category,
 *      right region); ordinary workers never receive them.
 *   4. Driver offers, the four lowest offers shown to the business, and the
 *      business selecting the final driver (never automatic).
 *   5. The enforced stage order: accept → pickup → drop-off → complete order →
 *      payment → completed, with no way to skip a stage through the API.
 *   6. Contact details unlock only for the selected driver after acceptance.
 *   7. Commission recorded from the owner's setting, and financial records
 *      scoped to an admin's region.
 *
 * Run with: npm run test:bookings
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_BOOKINGS_PORT || 3207);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-bookings-'));
const stamp = Date.now().toString(36);

let child = null;
let passed = 0;

function start() {
  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'bookings-test-session-secret-workbridge',
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
    put(url, body) {
      return this.call('PUT', url, body);
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
    console.log(`  FAIL ${name}`);
    throw error;
  }
}

const anon = client();
const owner = client();
const globalAdmin = client();
const uaeAdmin = client();
const business = client();
const otherBusiness = client();
const drivers = [client(), client(), client(), client(), client()];
const farDriver = client();
const wrongCategoryDriver = client();

const OWNER_EMAIL = `owner${stamp}@workbridge.test`;
const OWNER_PASS = 'Owner#12345';
const GLOBAL_EMAIL = `global${stamp}@workbridge.test`;
const GLOBAL_PASS = 'GlobalAdmin#123';
const UAE_EMAIL = `uae${stamp}@workbridge.test`;
const UAE_PASS = 'UaeAdmin#1234';

try {
  start();
  await waitForServer();
  console.log('\nWORKBRIDGE booking & permission test\n');

  let ownerId = null;
  let uaeAdminId = null;
  let bookingId = null;
  let bookingRef = null;
  let selectedOffer = null;
  let selectedDriverIndex = -1;
  const driverIds = [];

  await step('the first account is the private platform owner', async () => {
    const created = await anon.post('/api/setup/admin', {
      email: OWNER_EMAIL,
      password: OWNER_PASS,
      full_name: 'Platform Owner'
    });
    assert.equal(created.status, 201, created.text);

    const login = await owner.post('/api/auth/login', { email: OWNER_EMAIL, password: OWNER_PASS });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.user.role, 'owner');
    ownerId = login.json.user.id;
  });

  await step('the owner creates a global admin and a regional admin', async () => {
    const global = await owner.post('/api/owner/admins/create', {
      email: GLOBAL_EMAIL,
      full_name: 'Global Admin',
      password: GLOBAL_PASS,
      scope: { level: 'global', mode: 'global' }
    });
    assert.equal(global.status, 201, global.text);
    assert.match(JSON.stringify(global.json.admin.admin_scope), /global/);

    const regional = await owner.post('/api/owner/admins/create', {
      email: UAE_EMAIL,
      full_name: 'UAE Admin',
      password: UAE_PASS,
      scope: { level: 'regional', mode: 'regional', country: 'United Arab Emirates', city: '' }
    });
    assert.equal(regional.status, 201, regional.text);
    uaeAdminId = regional.json.admin.id;

    const globalLogin = await globalAdmin.post('/api/auth/login', {
      email: GLOBAL_EMAIL,
      password: GLOBAL_PASS
    });
    assert.equal(globalLogin.status, 200, globalLogin.text);
    assert.equal(globalLogin.json.user.role, 'admin');

    const uaeLogin = await uaeAdmin.post('/api/auth/login', { email: UAE_EMAIL, password: UAE_PASS });
    assert.equal(uaeLogin.status, 200, uaeLogin.text);
    assert.equal(uaeLogin.json.user.role, 'admin');
  });

  await step('a regional admin cannot change platform-wide switches', async () => {
    const settings = await uaeAdmin.get('/api/ride-booking/settings');
    assert.equal(settings.status, 200, settings.text);
    assert.notEqual(settings.json.scope.level, 'global');

    const attempt = await uaeAdmin.patch('/api/ride-booking/settings', { enabled: true });
    assert.equal(attempt.status, 403, attempt.text);
  });

  await step('the owner account is invisible and untouchable to admins', async () => {
    const users = await globalAdmin.get('/api/admin/users');
    assert.equal(users.status, 200, users.text);
    const roles = users.json.users.map((u) => u.role);
    assert.ok(!roles.includes('owner'), 'the owner must never appear in admin listings');
    assert.ok(!roles.includes('admin'), 'admins must not manage other admins');

    const hijack = await globalAdmin.patch(`/api/admin/users/${ownerId}`, { full_name: 'Hijacked' });
    assert.equal(hijack.status, 403, hijack.text);
    assert.equal(hijack.json.error, 'owner_protected');

    const suspend = await globalAdmin.patch(`/api/admin/users/${ownerId}`, { status: 'suspended' });
    assert.equal(suspend.status, 403, suspend.text);
  });

  await step('an admin cannot manage another admin or widen its own scope', async () => {
    const patch = await globalAdmin.patch(`/api/admin/users/${uaeAdminId}`, { full_name: 'Hijacked' });
    assert.equal(patch.status, 403, patch.text);
    assert.equal(patch.json.error, 'admin_protected');

    const widen = await uaeAdmin.patch(`/api/owner/admins/${uaeAdminId}/access`, {
      scope: { level: 'global', mode: 'global' }
    });
    assert.equal(widen.status, 403, widen.text);

    const ownerPanel = await uaeAdmin.get('/api/owner/admins/list');
    assert.equal(ownerPanel.status, 403, ownerPanel.text);
  });

  await step('the owner enables ride booking and sets a 2% commission', async () => {
    const enabled = await owner.patch('/api/ride-booking/settings', { enabled: true });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.enabled, true);

    const rate = await owner.put('/api/admin/settings/commission', {
      enabled: true,
      rate: 2,
      payer: 'business'
    });
    assert.equal(rate.status, 200, rate.text);

    const read = await owner.get('/api/admin/settings/commission');
    assert.equal(read.json.commission.rate, 2);
    assert.equal(read.json.commission.enabled, true);
  });

  await step('a business registers in Saudi Arabia', async () => {
    const res = await business.post('/api/auth/register', {
      role: 'business',
      email: `biz${stamp}@workbridge.test`,
      password: 'BizPass#123',
      full_name: 'Riyadh Logistics',
      phone: '+966500000001',
      company_name: 'Riyadh Logistics',
      country: 'Saudi Arabia',
      address: 'King Fahd Road'
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.user.role, 'business');

    const other = await otherBusiness.post('/api/auth/register', {
      role: 'business',
      email: `biz2${stamp}@workbridge.test`,
      password: 'BizPass#123',
      full_name: 'Second Business',
      phone: '+966500000002',
      company_name: 'Second Business',
      country: 'Saudi Arabia'
    });
    assert.equal(other.status, 201, other.text);
  });

  await step('five Riyadh drivers register and an admin approves them for VIP', async () => {
    for (let i = 0; i < 5; i += 1) {
      const reg = await drivers[i].post('/api/auth/register', {
        role: 'worker',
        email: `driver${i}${stamp}@workbridge.test`,
        password: 'Driver#1234',
        full_name: `Driver ${i + 1}`,
        phone: `+966500001${String(i).padStart(2, '0')}`,
        category: 'Driver',
        aqama: `12345678${i}0`,
        city: 'Riyadh',
        country: 'Saudi Arabia'
      });
      assert.equal(reg.status, 201, reg.text);
      driverIds.push(reg.json.user.id);

      const approved = await globalAdmin.patch(`/api/admin/drivers/${reg.json.user.id}/booking`, {
        booking_approved: true,
        vehicle_categories: ['VIP'],
        vehicle_name: `Vehicle ${i + 1}`
      });
      assert.equal(approved.status, 200, approved.text);
      assert.equal(approved.json.driver.booking_approved, true);
    }
  });

  await step('a driver outside the region and a wrong-category driver are approved but not eligible', async () => {
    const far = await farDriver.post('/api/auth/register', {
      role: 'worker',
      email: `fardriver${stamp}@workbridge.test`,
      password: 'Driver#1234',
      full_name: 'Dubai Driver',
      phone: '+971500000001',
      category: 'Driver',
      aqama: '9876543210',
      city: 'Dubai',
      country: 'United Arab Emirates'
    });
    assert.equal(far.status, 201, far.text);
    const farOk = await globalAdmin.patch(`/api/admin/drivers/${far.json.user.id}/booking`, {
      booking_approved: true,
      vehicle_categories: ['VIP'],
      vehicle_name: 'Dubai VIP'
    });
    assert.equal(farOk.status, 200, farOk.text);

    const wrong = await wrongCategoryDriver.post('/api/auth/register', {
      role: 'worker',
      email: `smallcar${stamp}@workbridge.test`,
      password: 'Driver#1234',
      full_name: 'Small Car Only',
      phone: '+966500002000',
      category: 'Driver',
      aqama: '1111222233',
      city: 'Riyadh',
      country: 'Saudi Arabia'
    });
    assert.equal(wrong.status, 201, wrong.text);
    const wrongOk = await globalAdmin.patch(`/api/admin/drivers/${wrong.json.user.id}/booking`, {
      booking_approved: true,
      vehicle_categories: ['Small Car'],
      vehicle_name: 'Small Car'
    });
    assert.equal(wrongOk.status, 200, wrongOk.text);
  });

  await step('a business booking is distributed to eligible drivers only', async () => {
    const res = await business.post('/api/bookings', {
      pickup: 'Riyadh Airport',
      destination: 'Kingdom Centre',
      date: '2026-12-01',
      time: '09:30',
      vehicle_category: 'VIP',
      requirements: 'Two passengers',
      details: 'Flight SV123'
    });
    assert.equal(res.status, 201, res.text);
    bookingId = res.json.booking.id;
    bookingRef = res.json.booking.ref;
    assert.equal(res.json.booking.status, 'created');
    assert.equal(
      res.json.notified_drivers,
      5,
      'only the five approved Riyadh VIP drivers may receive it'
    );
  });

  await step('an ordinary worker can neither see nor offer on the booking', async () => {
    const available = await wrongCategoryDriver.get('/api/bookings/available');
    assert.equal(available.status, 200, available.text);
    assert.equal(available.json.bookings.length, 0, 'wrong category must not receive the booking');

    const farAvailable = await farDriver.get('/api/bookings/available');
    assert.equal(farAvailable.json.bookings.length, 0, 'another country must not receive it');

    const offer = await wrongCategoryDriver.post(`/api/bookings/${bookingId}/offers`, {
      vehicle_name: 'Corolla',
      vehicle_category: 'VIP',
      price: 100
    });
    assert.equal(offer.status, 403, offer.text);
    assert.equal(offer.json.error, 'not_eligible');

    const create = await wrongCategoryDriver.post('/api/bookings', {
      pickup: 'A',
      destination: 'B',
      date: '2026-12-01',
      time: '09:30',
      vehicle_category: 'VIP'
    });
    assert.equal(create.status, 403, create.text);
  });

  await step('eligible drivers submit offers and the business sees the four lowest', async () => {
    const prices = [500, 400, 300, 450, 600];
    for (let i = 0; i < 5; i += 1) {
      const res = await drivers[i].post(`/api/bookings/${bookingId}/offers`, {
        vehicle_name: `Vehicle ${i + 1}`,
        vehicle_category: 'VIP',
        price: prices[i]
      });
      assert.ok([200, 201].includes(res.status), res.text);
    }

    const mine = await business.get('/api/bookings/mine');
    assert.equal(mine.status, 200, mine.text);
    const booking = mine.json.bookings.find((b) => b.id === bookingId);
    assert.ok(booking, 'the business must see its own booking');
    assert.equal(booking.offers.length, 4, 'only four offers are shown');
    assert.deepEqual(booking.offers.map((o) => o.price), [300, 400, 450, 500]);
    assert.equal(booking.status, 'offers', 'received offers move the booking to the offers stage');
    assert.ok(!booking.selected_driver_id, 'the cheapest offer is never selected automatically');

    selectedOffer = booking.offers.find((o) => o.price === 400);
    selectedDriverIndex = prices.indexOf(400);
  });

  await step('the business selects a driver and only that driver gets the business contact', async () => {
    const select = await business.post(`/api/bookings/${bookingId}/select`, {
      offer_id: selectedOffer.id
    });
    assert.equal(select.status, 200, select.text);
    // Selection assigns the booking to that driver and asks them to confirm it.
    assert.equal(select.json.booking.status, 'selected');
    assert.equal(select.json.booking.selected_driver_name, 'Driver 2');
    assert.equal(select.json.booking.selected_vehicle, 'Vehicle 2');
    assert.equal(select.json.booking.selected_price, 400);

    const asDriver = await drivers[selectedDriverIndex].get(`/api/bookings/${bookingId}`);
    assert.equal(asDriver.status, 200, asDriver.text);
    assert.equal(asDriver.json.booking.status, 'selected');
    assert.equal(asDriver.json.booking.can.accept, true, 'the selected driver gets the Confirm Booking action');
    const businessContact = asDriver.json.booking.business;
    assert.ok(
      businessContact && businessContact.phone,
      'the chosen driver receives the business contact as soon as they are selected'
    );

    // A driver who offered but was not chosen may track the booking, yet the
    // business contact must never reach them.
    const otherIndex = (selectedDriverIndex + 1) % drivers.length;
    const notSelected = await drivers[otherIndex].get(`/api/bookings/${bookingId}`);
    assert.equal(notSelected.status, 200, notSelected.text);
    const notSelectedBusiness = notSelected.json.booking.business;
    assert.ok(
      !notSelectedBusiness || !notSelectedBusiness.phone,
      'a non-selected driver must not receive the business contact'
    );
  });

  await step('the ride cannot skip stages and only the selected driver acts', async () => {
    const skipComplete = await drivers[selectedDriverIndex].post(
      `/api/bookings/${bookingId}/complete-order`,
      {}
    );
    assert.equal(skipComplete.status, 409, 'order completion cannot precede pickup and drop-off');

    const outsider = await drivers[0].post(`/api/bookings/${bookingId}/accept`, {});
    assert.equal(outsider.status, 403, outsider.text);
    assert.equal(outsider.json.error, 'not_selected');

    const earlyPayment = await business.post(`/api/bookings/${bookingId}/payment`, {
      amount: 400,
      reference: 'TX-EARLY'
    });
    assert.equal(earlyPayment.status, 409, earlyPayment.text);

    // Drop-off cannot precede pickup either; pickup itself is exercised next.
    const skipDropoff = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/dropoff`, {});
    assert.equal(skipDropoff.status, 409, 'drop-off cannot precede pickup');
  });

  await step('the selected driver confirms the booking and both contacts unlock', async () => {
    const accept = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/accept`, {});
    assert.equal(accept.status, 200, accept.text);
    assert.equal(accept.json.booking.status, 'confirmed', 'Confirm Booking moves the ride to confirmed');

    // Confirming twice is harmless for a client that retries.
    const again = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/accept`, {});
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.booking.status, 'confirmed');

    const driverView = await drivers[selectedDriverIndex].get(`/api/bookings/${bookingId}`);
    assert.ok(driverView.json.booking.business?.phone, 'the driver sees the business phone');

    const businessView = await business.get('/api/bookings/mine');
    const booking = businessView.json.bookings.find((b) => b.id === bookingId);
    assert.ok(booking.driver?.phone, 'the business sees the selected driver phone');
  });

  await step('booking chat opens only for the business and the selected driver', async () => {
    const businessChat = await business.get(`/api/bookings/${bookingId}/chat`);
    assert.equal(businessChat.status, 200, businessChat.text);
    assert.equal(businessChat.json.chat_open, true, 'chat is available once the booking is confirmed');
    assert.equal(businessChat.json.messages.length, 0);

    const driverChat = await drivers[selectedDriverIndex].get(`/api/bookings/${bookingId}/chat`);
    assert.equal(driverChat.status, 200, driverChat.text);

    // An unselected driver who did offer on the ride still has no conversation.
    const outsiderIndex = (selectedDriverIndex + 1) % drivers.length;
    const outsiderRead = await drivers[outsiderIndex].get(`/api/bookings/${bookingId}/chat`);
    assert.equal(outsiderRead.status, 403, 'an unselected driver cannot open the conversation');
    const outsiderWrite = await drivers[outsiderIndex].post(`/api/bookings/${bookingId}/chat/messages`, {
      text: 'let me in'
    });
    assert.equal(outsiderWrite.status, 403, 'an unselected driver cannot post to the conversation');
  });

  await step('business and driver exchange messages with unread counts', async () => {
    const sent = await business.post(`/api/bookings/${bookingId}/chat/messages`, {
      text: 'Pickup at gate 4 please.'
    });
    assert.equal(sent.status, 201, sent.text);
    const own = sent.json.messages.find((m) => m.text === 'Pickup at gate 4 please.');
    assert.ok(own, 'the sender sees the stored message');
    assert.equal(own.mine, true);

    const driverChat = await drivers[selectedDriverIndex].get(`/api/bookings/${bookingId}/chat`);
    const received = driverChat.json.messages.find((m) => m.text === 'Pickup at gate 4 please.');
    assert.ok(received, 'the selected driver receives the message');
    assert.equal(received.mine, false);
    assert.equal(driverChat.json.unread, 1, 'the message is unread for the driver');

    const reply = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/chat/messages`, {
      text: 'On my way.'
    });
    assert.equal(reply.status, 201, reply.text);

    const read = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/chat/read`, {});
    assert.equal(read.status, 200, read.text);
    const after = await drivers[selectedDriverIndex].get(`/api/bookings/${bookingId}/chat`);
    assert.equal(after.json.unread, 0, 'opening the conversation clears the driver badge');
  });

  await step('the notification bell reports events, unread counts and the sound setting', async () => {
    const bell = await business.get('/api/notifications');
    assert.equal(bell.status, 200, bell.text);
    assert.ok(bell.json.notifications.length >= 1, 'booking events reach the business bell');
    assert.equal(bell.json.sound, true, 'sound defaults to on');
    assert.ok(bell.json.unread >= 1, 'the business has unread notifications');

    const driverBell = await drivers[selectedDriverIndex].get('/api/notifications');
    assert.ok(driverBell.json.notifications.length >= 1, 'the selected driver is notified too');

    const off = await business.patch('/api/notifications/prefs', { sound: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.sound, false, 'the sound preference is stored');
    const reloaded = await business.get('/api/notifications');
    assert.equal(reloaded.json.sound, false, 'the preference survives a page reload');

    const readAll = await business.post('/api/notifications/read-all', {});
    assert.equal(readAll.status, 200, readAll.text);
    const cleared = await business.get('/api/notifications');
    assert.equal(cleared.json.unread, 0, 'mark all read clears the badge');
  });

  await step('the bell needs a session and the push key is public', async () => {
    const anonymous = await anon.get('/api/notifications');
    assert.equal(anonymous.status, 401, 'the bell requires a signed-in user');
    const key = await anon.get('/api/push/public-key');
    assert.equal(key.status, 200, key.text);
    assert.ok(typeof key.json.key === 'string' && key.json.key.length > 40, 'a VAPID public key is served');
  });

  await step('pickup, drop-off and completion are separate recorded steps', async () => {
    const pickup = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/pickup`, {});
    assert.equal(pickup.status, 200, pickup.text);
    assert.equal(pickup.json.booking.status, 'pickup');

    const doublePickup = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/pickup`, {});
    assert.equal(doublePickup.status, 409, 'a stage cannot be repeated');

    const dropoff = await drivers[selectedDriverIndex].post(`/api/bookings/${bookingId}/dropoff`, {});
    assert.equal(dropoff.status, 200, dropoff.text);
    assert.equal(dropoff.json.booking.status, 'dropoff');

    const complete = await drivers[selectedDriverIndex].post(
      `/api/bookings/${bookingId}/complete-order`,
      {}
    );
    assert.equal(complete.status, 200, complete.text);
    assert.equal(complete.json.booking.status, 'complete_order');

    const earlyFinalize = await drivers[selectedDriverIndex].post(
      `/api/bookings/${bookingId}/finalize`,
      {}
    );
    assert.equal(earlyFinalize.status, 409, 'completion needs payment first');
  });

  await step('payment records the commission from the owner setting', async () => {
    const pay = await business.post(`/api/bookings/${bookingId}/payment`, {
      amount: 400,
      reference: 'TX-400-OK',
      method: 'bank_transfer'
    });
    assert.equal(pay.status, 200, pay.text);
    assert.equal(pay.json.booking.status, 'paid');
    assert.equal(pay.json.booking.payment.commission_rate, 2);
    assert.equal(pay.json.booking.payment.commission_amount, 8);
    assert.equal(
      pay.json.booking.payment.payable_amount,
      400,
      'the driver receives the full fare; commission is recorded separately and never deducted'
    );

    const otherPay = await otherBusiness.post(`/api/bookings/${bookingId}/payment`, {
      amount: 400,
      reference: 'TX-HIJACK'
    });
    assert.equal(otherPay.status, 403, 'another business cannot pay this booking');
  });

  await step('the booking completes only after payment', async () => {
    const finalize = await business.post(`/api/bookings/${bookingId}/finalize`, {});
    assert.equal(finalize.status, 200, finalize.text);
    assert.equal(finalize.json.booking.status, 'completed');

    const mine = await business.get('/api/bookings/mine');
    const booking = mine.json.bookings.find((b) => b.id === bookingId);
    const stages = booking.events.map((event) => event.status);
    for (const expected of ['created', 'selected', 'confirmed', 'pickup', 'dropoff', 'complete_order', 'paid', 'completed']) {
      assert.ok(stages.includes(expected), `missing recorded stage: ${expected}`);
    }

    // Completing the booking withdraws the phone numbers from the business
    // dashboard as well, while the record and payment stay readable.
    assert.equal(booking.contact_hidden, true, 'the business view flags the removal');
    assert.ok(!booking.driver?.phone, 'the driver phone is removed from the business dashboard');
    assert.ok(!booking.customer?.phone, 'the customer phone is removed from the business dashboard');
    assert.ok(booking.ref, 'the booking reference is kept');
    assert.ok(booking.selected_price, 'the agreed price is kept');
    assert.ok(booking.payment?.amount, 'the payment record is kept');

    const driverDone = await drivers[selectedDriverIndex].get(`/api/bookings/${bookingId}`);
    assert.ok(
      !driverDone.json.booking.business?.phone,
      'the business phone is removed from the driver dashboard'
    );
    assert.ok(driverDone.json.booking.ref, 'the driver keeps the booking record');
  });

  await step('commission is recorded for the owner and scoped for admins', async () => {
    const ledger = await owner.get('/api/admin/commissions');
    assert.equal(ledger.status, 200, ledger.text);
    const entry = ledger.json.entries.find((row) => row.ref === bookingRef);
    assert.ok(entry, 'the booking commission must appear in the ledger');
    assert.equal(entry.amount, 400);
    assert.equal(entry.commission_amount, 8);
    assert.equal(entry.rate, 2);

    const platform = await owner.get('/api/owner/platform');
    assert.equal(platform.status, 200, platform.text);

    const globalBookings = await globalAdmin.get('/api/admin/bookings');
    assert.equal(globalBookings.status, 200, globalBookings.text);
    assert.ok(
      globalBookings.json.bookings.some((b) => b.id === bookingId),
      'a global admin sees the booking'
    );

    const regionalBookings = await uaeAdmin.get('/api/admin/bookings');
    assert.equal(regionalBookings.status, 200, regionalBookings.text);
    assert.ok(
      !regionalBookings.json.bookings.some((b) => b.id === bookingId),
      'a UAE admin must not see a Saudi booking'
    );

    const regionalPayments = await uaeAdmin.get('/api/admin/payments');
    assert.equal(regionalPayments.status, 200, regionalPayments.text);
    assert.ok(
      !regionalPayments.json.payments.some((row) => row.ref === bookingRef),
      'a UAE admin must not see Saudi financial records'
    );

    const globalPayments = await globalAdmin.get('/api/admin/payments');
    assert.ok(
      globalPayments.json.payments.some((row) => row.ref === bookingRef),
      'a global admin sees the payment record'
    );
  });

  await step('suspending a driver stops their access immediately', async () => {
    const suspend = await owner.patch(`/api/admin/users/${driverIds[0]}`, { status: 'suspended' });
    assert.ok([200, 204].includes(suspend.status), suspend.text);

    const afterSuspend = await drivers[0].get('/api/bookings/available');
    assert.ok(
      [401, 403].includes(afterSuspend.status),
      `a suspended session must stop working, got ${afterSuspend.status}`
    );
  });

  await step('business offer rows identify driver, vehicle, category and price', async () => {
    const list = await business.get('/api/bookings/mine');
    assert.equal(list.status, 200, list.text);
    const booking = list.json.bookings.find((row) => row.id === bookingId);
    assert.ok(booking, 'the booking must be visible to its business');

    assert.equal(booking.offers.length, 4, 'the four lowest offers are shown');
    assert.ok(
      Number(booking.offer_count) >= 4,
      `offer_count must report every valid offer, got ${booking.offer_count}`
    );
    assert.ok(
      Number(booking.eligible_driver_count) >= 4,
      `eligible_driver_count must report the approved drivers reached, got ${booking.eligible_driver_count}`
    );

    for (const offer of booking.offers) {
      assert.ok(offer.driver_name, 'each offer names the driver');
      assert.ok(offer.vehicle_name, 'each offer names the vehicle model');
      assert.ok(offer.vehicle_category, 'each offer names the vehicle category');
      assert.ok(Number(offer.price) > 0, 'each offer carries the driver price');
    }

    const prices = booking.offers.map((offer) => Number(offer.price));
    assert.deepEqual(
      prices,
      [...prices].sort((a, b) => a - b),
      'offers must be ordered lowest price first'
    );
    assert.equal(
      booking.selected_offer_id,
      selectedOffer.id,
      'the recorded selection is the driver the business chose, not the cheapest offer'
    );
    assert.ok(booking.selected_driver_id, 'a driver is assigned only after an explicit business selection');
    assert.notEqual(
      booking.offers[0].price,
      selectedOffer.price,
      'the test proves a non-cheapest offer can be selected'
    );
  });

  await step('the public admin entry point exposes no owner identity', async () => {
    const status = await fetch(`${BASE}/api/auth/owner-status`);
    assert.equal(status.status, 200);
    const body = await status.json();
    const serialized = JSON.stringify(body);

    assert.ok(
      !Object.keys(body).some((key) => /owner/i.test(key)),
      `owner-related fields must not be returned: ${serialized}`
    );
    assert.ok(!serialized.includes('@'), `no email address may be returned: ${serialized}`);
    assert.ok(
      body.setup_required !== undefined || body.recovery_enabled !== undefined,
      'only setup state is returned'
    );

    // The shipped frontend bundle must not carry the old masked-owner hint either.
    const bundle = await fetch(`${BASE}/views/public.js`);
    assert.equal(bundle.status, 200);
    const source = await bundle.text();
    assert.ok(!source.includes('owner_email_masked'), 'the masked owner email must be gone from the frontend');
    assert.ok(!source.includes('Owner account on file'), 'the owner hint must be gone from the admin login');
    assert.ok(
      source.includes('export async function ownerSigninView'),
      'owner sign-in must be a separate view from admin sign-in'
    );
  });

  await step('every panel ships its own share-link login target', async () => {
    const asset = await fetch(`${BASE}/views/common.js`);
    assert.equal(asset.status, 200);
    const source = await asset.text();

    for (const target of ['#/worker/signin', '#/business/signin', '#/admin/signin', '#/owner/signin']) {
      assert.ok(source.includes(target), `missing share target ${target}`);
    }
    assert.ok(source.includes('data-share-url'), 'the panel shell must render a share control');

    // A shared link only reaches a login form: no panel data is readable without a session.
    for (const guarded of ['/api/bookings/mine', '/api/admin/drivers', '/api/owner/admins/list']) {
      const res = await fetch(`${BASE}${guarded}`);
      assert.ok(
        [401, 403].includes(res.status),
        `${guarded} must require authentication, got ${res.status}`
      );
    }
  });

  await step('the assigned driver can receive payment and complete a business booking', async () => {
    // A second booking proves the driver-side buttons end to end: an offer with
    // only a price and a vehicle name, acceptance, the ride stages, then payment
    // and completion recorded by the driver.
    const created = await business.post('/api/bookings', {
      pickup: 'King Fahd Road',
      destination: 'Airport Terminal 5',
      date: '2030-03-04',
      time: '09:15',
      vehicle_category: 'VIP',
      details: 'Two large suitcases'
    });
    assert.equal(created.status, 201, created.text);
    const secondId = created.json.booking.id;

    // The offer form asks for price and vehicle name only — no category field.
    const offer = await drivers[selectedDriverIndex].post(`/api/bookings/${secondId}/offers`, {
      vehicle_name: 'Toyota Fortuner',
      price: 275
    });
    assert.equal(offer.status, 201, offer.text);

    const listed = await business.get('/api/bookings/mine');
    const second = listed.json.bookings.find((row) => row.id === secondId);
    const myOffer = (second.offers || [])[0];
    assert.ok(myOffer, 'the driver offer reaches the business dashboard');
    assert.equal(myOffer.vehicle_name, 'Toyota Fortuner', 'the vehicle name travels with the offer');
    assert.equal(myOffer.vehicle_category, 'VIP', 'the category is taken from the booking');
    assert.equal(myOffer.price, 275);

    const select = await business.post(`/api/bookings/${secondId}/select`, { offer_id: myOffer.id });
    assert.equal(select.status, 200, select.text);
    assert.equal(select.json.booking.status, 'selected', 'selection asks the chosen driver to confirm');

    const confirm = await drivers[selectedDriverIndex].post(`/api/bookings/${secondId}/accept`, {});
    assert.equal(confirm.status, 200, confirm.text);
    assert.equal(confirm.json.booking.status, 'confirmed', 'the driver confirms with Confirm Booking');

    // The chosen driver is notified at once and asked to confirm.
    const notified = await drivers[selectedDriverIndex].get('/api/notifications');
    assert.equal(notified.status, 200, notified.text);
    assert.ok(
      notified.text.includes('Confirm this booking'),
      'the selected driver is asked to confirm the booking'
    );

    // "Pick Up Customer" → "Drop-off Customer" → "Order Completed"
    for (const [path, expected] of [
      ['pickup', 'pickup'],
      ['dropoff', 'dropoff'],
      ['complete-order', 'complete_order']
    ]) {
      const moved = await drivers[selectedDriverIndex].post(`/api/bookings/${secondId}/${path}`, {});
      assert.equal(moved.status, 200, moved.text);
      assert.equal(moved.json.booking.status, expected);
    }

    // "Receive Payment" — the assigned driver records the fare they collected.
    const pay = await drivers[selectedDriverIndex].post(`/api/bookings/${secondId}/payment`, {
      amount: 275,
      reference: 'DRV-275-OK',
      method: 'cash'
    });
    assert.equal(pay.status, 200, pay.text);
    assert.equal(pay.json.booking.status, 'paid');
    assert.equal(pay.json.booking.payment.commission_rate, 2);
    assert.equal(pay.json.booking.payment.commission_amount, 5.5);
    assert.equal(pay.json.booking.payment.payable_amount, 275, 'the driver keeps the full 275 fare');

    const doublePay = await drivers[selectedDriverIndex].post(`/api/bookings/${secondId}/payment`, {
      amount: 275,
      reference: 'DRV-DUP'
    });
    assert.equal(doublePay.status, 409, 'payment cannot be recorded twice');

    // "Booking Completed"
    const done = await drivers[selectedDriverIndex].post(`/api/bookings/${secondId}/finalize`, {});
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.booking.status, 'completed');

    // Business and driver dashboards agree on the final status.
    const after = await business.get('/api/bookings/mine');
    const asBusiness = after.json.bookings.find((row) => row.id === secondId);
    assert.equal(asBusiness.status, 'completed', 'the business dashboard shows the completed status');
    assert.ok(!asBusiness.driver?.phone, 'phones stay hidden after completion');
    const asDriver = await drivers[selectedDriverIndex].get(`/api/bookings/${secondId}`);
    assert.equal(asDriver.json.booking.status, 'completed', 'the driver dashboard agrees');
  });

  await step('the dashboard renders the stages once and the driver actions only', async () => {
    // The stage list is client-rendered, so assert on the template itself: it
    // belongs at the top of the page once, never under an individual booking.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../public/views/bookings.js', import.meta.url), 'utf8');
    const businessCard = src.slice(
      src.indexOf('function businessCard'),
      src.indexOf('export async function businessBookingsView')
    );
    assert.ok(businessCard.length > 200, 'the business card template is present');
    assert.ok(!businessCard.includes('progress('), 'no stage list inside a business booking');
    assert.ok(!businessCard.includes('stage-list'), 'no numbered stage list under a booking');
    assert.ok(!businessCard.includes('data-stage'), 'action buttons stay out of the business dashboard');
    assert.ok(src.includes('function stageStrip'), 'the business dashboard keeps one compact status line');
    assert.ok(src.includes('${stageStrip()}'), 'the status line is placed on the business dashboard');

    // The driver dashboard replaced the list with real action buttons.
    const driverStart = src.indexOf('export async function driverBookingsView');
    const driverNext = src.indexOf('export async function', driverStart + 10);
    const driverView = src.slice(driverStart, driverNext === -1 ? undefined : driverNext);
    assert.ok(driverView.length > 200, 'the driver view template is present');
    assert.ok(!driverView.includes('stageStrip()'), 'no stage list on the driver dashboard');

    // The driver action labels live in DRIVER_ACTIONS and are rendered by
    // driverStageActions, which driverCard calls — assert across that whole block.
    const driverCard = src.slice(src.indexOf('const DRIVER_ACTIONS'), src.indexOf('function offerForm'));
    assert.ok(driverCard.includes('driverStageActions(booking)'), 'the driver card renders the actions');
    for (const label of [
      'Confirm Booking',
      'Pick Up Customer',
      'Drop-off Customer',
      'Order Completed',
      'Receive Payment',
      'Booking Completed'
    ]) {
      assert.ok(driverCard.includes(label), `driver action missing: ${label}`);
    }
    assert.ok(!driverCard.includes('Accept Booking'), 'no separate accept step remains');
    assert.ok(!driverCard.includes('progress('), 'the driver card does not repeat the stage list');
  });

  console.log(`\n${passed} passed\n`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (child) child.kill();
  await rm(dataDir, { recursive: true, force: true });
}
