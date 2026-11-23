#!/usr/bin/env node
/**
 * WORKBRIDGE — driver profile id mapping regression test.
 *
 * Reproduces both reported failures at their shared root cause: a worker account
 * whose worker_profiles row is missing, or is keyed only by its own id. Before
 * the fix that row could not be keyed through Supabase, so:
 *   - the availability save skipped the whole update and still answered 200
 *     ("Enable for Work" reverted after reopening the profile), and
 *   - the admin driver assignment answered 404 "Driver profile not found."
 *
 * Run with: node scripts/profile-mapping.test.js
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-profile-map-'));
// Must be set before importing config.js, which reads them at import time.
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'profile-mapping-test-session-secret';

const { data } = await import('../server/store.js');
const { driverProfile, ensureWorkerProfile, eligibleDriver } = await import('../server/bookings.js');
const { profileFor } = await import('../server/middleware.js');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok   ${name}`);
}

const driver = {
  id: 'u-driver-map-1',
  role: 'worker',
  status: 'active',
  full_name: 'Mapping Driver',
  phone: '+10000000001',
  email: 'driver.map@workbridge.test',
  ride_booking_enabled: true
};

const db = data();
db.users = [driver];
db.workerProfiles = [];

// The condition the admin panel hit: the worker account exists, its profile row
// does not. This is what produced "Driver Profile Not Found".
assert.equal(driverProfile(driver.id), null);
ok('a worker without a profile row is genuinely absent before repair');

// Admin driver selection must repair it instead of failing with 404.
const created = ensureWorkerProfile(driver);
assert.ok(created, 'admin driver assignment must not fail with 404');
assert.equal(created.id, driver.id, 'profile row carries the primary key Supabase needs');
assert.equal(created.user_id, driver.id);
ok('admin driver selection creates the missing profile instead of "not found"');

// BUG 1: the availability write the profile route performs must land on the row
// the next request reads back.
created.available = true;
assert.equal(driverProfile(driver.id).available, true);
ok('Enable for Work is stored on the repaired profile');

// A legacy row keyed only by its own id still belongs to that driver.
db.workerProfiles = [{ id: driver.id, available: false }];
assert.equal(driverProfile(driver.id).available, false);
assert.equal(profileFor(driver).available, false);
ok('an id-only profile is found by the driver and by their session payload');

// Small Car / Business eligibility follows admin approval, category and the
// driver's own availability switch.
const profile = driverProfile(driver.id);
profile.available = true;
profile.booking_approved = true;
profile.vehicle_categories = ['Small Car', 'Business'];

const smallCar = { kind: 'business', vehicle_category: 'Small Car' };
const businessCar = { kind: 'business', vehicle_category: 'Business' };
const vip = { kind: 'business', vehicle_category: 'VIP' };

assert.equal(eligibleDriver(driver, smallCar), true);
assert.equal(eligibleDriver(driver, businessCar), true);
assert.equal(eligibleDriver(driver, vip), false, 'an unassigned category must not match');
ok('Small Car and Business bookings reach the approved available driver; VIP does not');

profile.available = false;
assert.equal(eligibleDriver(driver, smallCar), false);
assert.equal(eligibleDriver(driver, businessCar), false);
ok('switching Enable for Work off stops Small Car and Business bookings');

// An admin-assigned category set survives a reload of the same profile object.
profile.available = true;
profile.vehicle_categories = ['VIP'];
assert.deepEqual(driverProfile(driver.id).vehicle_categories, ['VIP']);
assert.equal(eligibleDriver(driver, smallCar), false);
assert.equal(eligibleDriver(driver, vip), true);
ok('admin category changes are read back from the stored profile');

await rm(dataDir, { recursive: true, force: true });

console.log(`\nWORKBRIDGE profile mapping test\n\n  ${passed} checks passed\n`);
