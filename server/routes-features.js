/**
 * WORKBRIDGE feature routes added on top of the existing API.
 *
 *  - Owner Admin: admin applications, approval with global/regional scope.
 *  - Book Your Car: public bookings, global + per-worker ON/OFF.
 *  - WORKBRIDGE MALL: vehicle buy/sell and electronic discount shops.
 *  - Open agreements: a worker or business can start an agreement at any time.
 *
 * Everything reuses the existing data layer (`data()` / `persist()`) so the
 * Supabase mirror and the local JSON driver keep working unchanged.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { data, persist, nextCounter, saveSettings } from './store.js';
import { hashPassword, requireRole } from './security.js';
import { adminScope, inScope, filterByScope, isOwner, normalizeScope } from './scope.js';
import { isValidCurrency } from './currency.js';
import { PAY_PERIODS, round2, nowIso, isEmail, str, num } from './util.js';
import {
  eligibleDrivers,
  pushEvent,
  customerBookingView,
  nextBookingRef,
  newBookingId,
  validOffers,
  openOffers
} from './bookings.js';

const router = Router();
const id = () => crypto.randomUUID();
const fail = (res, status, error, message) => res.status(status).json({ error, message });

const VEHICLE_CATEGORIES = ['Small Car', 'Go', 'Business', 'VIP'];
const MAX_IMAGE = 900 * 1000; // data-URL characters; the client compresses first

/** Only images are accepted, and only up to the request budget. */
function image(value, field) {
  const raw = String(value || '');
  if (!raw) return null;
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(raw)) {
    throw Object.assign(new Error(`${field} must be a PNG, JPEG or WebP image.`), { status: 400 });
  }
  if (raw.length > MAX_IMAGE) {
    throw Object.assign(new Error(`${field} is too large. Please use a smaller photo.`), {
      status: 413
    });
  }
  return raw;
}

function rideBookingSettings() {
  const raw = data().settings.rideBooking || {};
  return { enabled: raw.enabled !== false };
}

/** Workers that may receive ride bookings: approved by the admin, still active. */
function rideEligible(user) {
  return Boolean(
    user &&
      user.role === 'worker' &&
      user.status === 'active' &&
      user.ride_booking_enabled === true &&
      rideBookingSettings().enabled
  );
}

function mallVehicleView(v) {
  return { ...v };
}

/* ------------------------------------------------------- admin applications */

/**
 * Anyone, from any country, may apply for admin access. The account is created
 * in `pending` state so the session layer refuses it until the owner approves.
 */
router.post('/admin-applications', (req, res) => {
  const body = req.body || {};
  const email = str(body.email, 160).toLowerCase();
  const password = String(body.password || '');
  const fullName = str(body.full_name, 120);
  const country = str(body.country, 80);
  const city = str(body.city, 80);

  if (!fullName) return fail(res, 400, 'missing_name', 'Your full name is required.');
  if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < 8) {
    return fail(res, 400, 'weak_password', 'Choose a password with at least 8 characters.');
  }
  if (!country) return fail(res, 400, 'missing_country', 'Your country is required.');

  const db = data();
  if (db.users.some((u) => u.email === email)) {
    return fail(res, 409, 'email_taken', 'An account already exists for that email.');
  }

  const user = {
    id: id(),
    role: 'admin',
    email,
    password_hash: hashPassword(password),
    full_name: fullName,
    phone: str(body.phone, 40),
    country,
    city,
    status: 'pending',
    admin_scope: normalizeScope({ level: 'regional', country, city }),
    admin_application: {
      requested_scope: body.requested_scope === 'global' ? 'global' : 'regional',
      note: str(body.note, 1000),
      submitted_at: nowIso()
    },
    created_at: nowIso(),
    session_epoch: 0
  };
  db.users.push(user);
  persist();
  res.status(201).json({
    ok: true,
    message: 'Your admin application was sent to the platform owner for review.'
  });
});

/** Owner-only queue of every admin account and its state. */
router.get('/admin-applications', requireRole('owner'), (req, res) => {
  const admins = data()
    .users.filter((u) => u.role === 'admin')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((u) => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      phone: u.phone,
      country: u.country || '',
      city: u.city || '',
      status: u.status,
      scope: adminScope(u),
      application: u.admin_application || null,
      approved_at: u.approved_at || null,
      created_at: u.created_at
    }));
  res.json({ admins });
});

router.post('/admin-applications/:id/approve', requireRole('owner'), (req, res) => {
  const db = data();
  const admin = db.users.find((u) => u.id === req.params.id && u.role === 'admin');
  if (!admin) return fail(res, 404, 'not_found', 'Admin application not found.');

  const scope = normalizeScope((req.body || {}).scope || admin.admin_scope);
  if (scope.level === 'regional' && !scope.country && !scope.city) {
    return fail(res, 400, 'scope_required', 'Choose a country or city for a regional admin.');
  }
  admin.admin_scope = scope;
  admin.status = 'active';
  admin.approved_by = req.user.id;
  admin.approved_at = nowIso();
  persist();
  res.json({ ok: true, admin: { id: admin.id, status: admin.status, scope: adminScope(admin) } });
});

router.post('/admin-applications/:id/reject', requireRole('owner'), (req, res) => {
  const admin = data().users.find((u) => u.id === req.params.id && u.role === 'admin');
  if (!admin) return fail(res, 404, 'not_found', 'Admin application not found.');
  admin.status = 'rejected';
  admin.rejected_at = nowIso();
  admin.rejection_reason = str((req.body || {}).reason, 500);
  persist();
  res.json({ ok: true, admin: { id: admin.id, status: admin.status } });
});

/** The owner can change scope or revoke an admin at any time. */
router.patch('/owner/admins/:id', requireRole('owner'), (req, res) => {
  const body = req.body || {};
  const admin = data().users.find((u) => u.id === req.params.id && u.role === 'admin');
  if (!admin) return fail(res, 404, 'not_found', 'Admin account not found.');

  if (body.scope) {
    const scope = normalizeScope(body.scope);
    if (scope.level === 'regional' && !scope.country && !scope.city) {
      return fail(res, 400, 'scope_required', 'Choose a country or city for a regional admin.');
    }
    admin.admin_scope = scope;
  }
  if (body.status && ['active', 'suspended', 'rejected'].includes(body.status)) {
    admin.status = body.status;
  }
  persist();
  res.json({ ok: true, admin: { id: admin.id, status: admin.status, scope: adminScope(admin) } });
});

/** Owner creates an admin directly (no application). */
router.post('/owner/admins', requireRole('owner'), (req, res) => {
  const body = req.body || {};
  const email = str(body.email, 160).toLowerCase();
  const password = String(body.password || '');
  if (!str(body.full_name, 120)) return fail(res, 400, 'missing_name', 'Full name is required.');
  if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (password.length < 8) {
    return fail(res, 400, 'weak_password', 'Choose a password with at least 8 characters.');
  }
  const db = data();
  if (db.users.some((u) => u.email === email)) {
    return fail(res, 409, 'email_taken', 'An account already exists for that email.');
  }
  const scope = normalizeScope(body.scope);
  const user = {
    id: id(),
    role: 'admin',
    email,
    password_hash: hashPassword(password),
    full_name: str(body.full_name, 120),
    phone: str(body.phone, 40),
    country: str(body.country, 80),
    city: str(body.city, 80),
    status: 'active',
    admin_scope: scope,
    approved_by: req.user.id,
    approved_at: nowIso(),
    created_at: nowIso(),
    session_epoch: 0
  };
  db.users.push(user);
  persist();
  res.status(201).json({ ok: true, admin: { id: user.id, email: user.email, scope } });
});

/* ------------------------------------------------------------- ride booking */

/**
 * Public: the booking page needs to know whether ride booking is currently open
 * so a customer is not shown a form that can only fail on submit. It exposes the
 * on/off flag and the category list only — never worker or admin data.
 */
router.get('/ride-bookings/open', (req, res) => {
  res.json({
    open: rideBookingSettings().enabled === true,
    categories: VEHICLE_CATEGORIES
  });
});

router.get('/ride-booking/settings', requireRole('admin'), (req, res) => {
  const workers = filterByScope(
    req.user,
    data().users.filter((u) => u.role === 'worker')
  ).map((u) => ({
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    phone: u.phone,
    country: u.country || '',
    city: u.city || '',
    status: u.status,
    ride_booking_enabled: u.ride_booking_enabled === true
  }));
  res.json({ enabled: rideBookingSettings().enabled, scope: adminScope(req.user), workers });
});

router.patch('/ride-booking/settings', requireRole('admin'), (req, res) => {
  if (!isOwner(req.user) && adminScope(req.user).level !== 'global') {
    return fail(res, 403, 'forbidden', 'Only the platform owner or a global admin can change this.');
  }
  const enabled = Boolean((req.body || {}).enabled);
  saveSettings({ rideBooking: { enabled } });
  persist();
  res.json({ enabled: rideBookingSettings().enabled });
});

router.patch('/ride-booking/workers/:id', requireRole('admin'), (req, res) => {
  const worker = data().users.find((u) => u.id === req.params.id && u.role === 'worker');
  if (!worker) return fail(res, 404, 'not_found', 'Worker not found.');
  if (!inScope(req.user, worker)) {
    return fail(res, 403, 'out_of_scope', 'That worker is outside your assigned region.');
  }
  worker.ride_booking_enabled = Boolean((req.body || {}).enabled);
  persist();
  res.json({ worker: { id: worker.id, ride_booking_enabled: worker.ride_booking_enabled } });
});

/** Public: a customer books a car without creating an account. */
router.post('/ride-bookings', (req, res) => {
  const body = req.body || {};
  const category = VEHICLE_CATEGORIES.find(
    (c) => c.toLowerCase() === String(body.category || '').toLowerCase()
  );
  if (!category) return fail(res, 400, 'invalid_category', 'Choose a vehicle category.');
  const details = str(body.details, 2000);
  if (!details) return fail(res, 400, 'missing_details', 'Write your booking details.');

  if (!rideBookingSettings().enabled) {
    return fail(
      res,
      503,
      'ride_booking_disabled',
      'Ride booking is temporarily closed. Please try again later.'
    );
  }

  // The booking joins the same offer pipeline the business panel uses, so every
  // eligible driver can price it and the customer picks the driver they want.
  const booking = {
    id: newBookingId(),
    ref: nextBookingRef(),
    kind: 'customer',
    status: 'created',
    business_id: null,
    pickup: str(body.pickup, 200) || 'Pickup to be confirmed with the driver',
    destination: str(body.destination, 200) || 'As described in the booking details',
    date: str(body.date, 40) || nowIso().slice(0, 10),
    time: str(body.time, 20),
    vehicle_category: category,
    requirements: str(body.requirements, 400),
    details,
    customer_name: str(body.customer_name, 120),
    customer_phone: str(body.customer_phone, 40),
    currency: data().settings.currency.default,
    country: '',
    city: '',
    offers: [],
    track_token: crypto.randomBytes(24).toString('hex'),
    created_at: nowIso(),
    updated_at: nowIso()
  };
  pushEvent(booking, 'created', {
    id: 'customer',
    role: 'customer',
    full_name: booking.customer_name || 'Customer'
  });
  data().rideBookings.unshift(booking);

  // Reach every approved, active driver for this category and region.
  const drivers = eligibleDrivers(booking);
  for (const driver of drivers) {
    data().notifications.unshift({
      id: id(),
      user_id: driver.id,
      title: 'New booking request',
      body: `${booking.ref}: ${booking.pickup} → ${booking.destination} (${booking.vehicle_category}).`,
      link: '#/worker/bookings',
      read_at: null,
      created_at: nowIso()
    });
  }

  persist();
  res.status(201).json({
    booking: customerBookingView(booking),
    track_token: booking.track_token,
    track_url: `#/track/${booking.track_token}`,
    notified_drivers: drivers.length
  });
});

/**
 * The customer follows the booking with a private token: no account needed, and
 * the token only ever exposes that one booking.
 */
router.get('/ride-bookings/track/:token', (req, res) => {
  const token = String(req.params.token || '');
  const booking = (data().rideBookings || []).find(
    (b) => b.kind === 'customer' && b.track_token && b.track_token === token
  );
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  res.json({ booking: customerBookingView(booking) });
});

/** The customer compares the offers and picks the driver they prefer. */
router.post('/ride-bookings/track/:token/select', (req, res) => {
  const token = String(req.params.token || '');
  const booking = (data().rideBookings || []).find(
    (b) => b.kind === 'customer' && b.track_token && b.track_token === token
  );
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (!['created', 'offers'].includes(booking.status)) {
    return fail(res, 409, 'wrong_stage', 'A driver has already been selected for this booking.');
  }
  const offerId = str((req.body || {}).offer_id, 60);
  const offer = openOffers(booking).find((o) => o.id === offerId);
  if (!offer) return fail(res, 404, 'offer_not_found', 'That offer is no longer available.');

  booking.selected_offer_id = offer.id;
  booking.selected_driver_id = offer.driver_id;
  booking.selected_price = offer.price;
  booking.selected_vehicle = offer.vehicle_name;
  pushEvent(booking, 'selected', { id: 'customer', role: 'customer' });

  // Close every other offer so only the chosen driver can act on the booking.
  // They stay on the record so the history of who offered what is not lost.
  for (const other of booking.offers || []) {
    if (other.id === offer.id || other.closed_reason) continue;
    other.closed_reason = 'assigned';
    other.closed_at = nowIso();
    data().notifications.unshift({
      id: id(),
      user_id: other.driver_id,
      title: 'Booking assigned',
      body: `${booking.ref} was assigned to another driver.`,
      link: '#/worker/bookings',
      read_at: null,
      created_at: nowIso()
    });
  }

  data().notifications.unshift({
    id: id(),
    user_id: offer.driver_id,
    title: 'You were selected',
    body: `${booking.ref}: ${booking.pickup} → ${booking.destination}. Accept to confirm.`,
    link: '#/worker/bookings',
    read_at: null,
    created_at: nowIso()
  });

  persist();
  res.json({ booking: customerBookingView(booking) });
});

router.get('/ride-bookings', requireRole('worker', 'admin'), (req, res) => {
  const db = data();
  if (req.user.role === 'worker') {
    if (!rideEligible(req.user)) {
      return fail(
        res,
        403,
        'ride_booking_disabled',
        'Ride booking is not enabled for your account. Contact the administrator.'
      );
    }
    const list = db.rideBookings
      .filter((b) => b.status === 'open' || b.assigned_worker_id === req.user.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.json({ bookings: list, enabled: true });
  }
  const list = [...db.rideBookings].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  res.json({ bookings: list, enabled: rideBookingSettings().enabled });
});

router.post('/ride-bookings/:id/claim', requireRole('worker'), (req, res) => {
  if (!rideEligible(req.user)) {
    return fail(res, 403, 'ride_booking_disabled', 'Ride booking is not enabled for your account.');
  }
  const booking = data().rideBookings.find((b) => b.id === req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (booking.status !== 'open') return fail(res, 409, 'taken', 'That booking was already taken.');
  booking.assigned_worker_id = req.user.id;
  booking.assigned_worker_name = req.user.full_name;
  booking.assigned_worker_phone = req.user.phone || '';
  booking.status = 'claimed';
  booking.claimed_at = nowIso();
  persist();
  res.json({ booking });
});

router.patch('/ride-bookings/:id', requireRole('worker', 'admin'), (req, res) => {
  const booking = data().rideBookings.find((b) => b.id === req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  const status = str((req.body || {}).status, 20);
  if (!['open', 'claimed', 'completed', 'cancelled'].includes(status)) {
    return fail(res, 400, 'invalid_status', 'Unknown booking status.');
  }
  if (req.user.role === 'worker' && booking.assigned_worker_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'You can only update your own bookings.');
  }
  booking.status = status;
  booking.updated_at = nowIso();
  persist();
  res.json({ booking });
});

/* --------------------------------------------------------------------- mall */

router.get('/mall/vehicles', (req, res) => {
  const list = data()
    .mallVehicles.filter((v) => v.status !== 'removed')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ vehicles: list.map(mallVehicleView) });
});

router.post('/mall/vehicles', requireRole('worker', 'business', 'admin'), (req, res) => {
  const body = req.body || {};
  const description = str(body.description, 3000);
  if (!description) return fail(res, 400, 'missing_details', 'Describe the vehicle and price.');
  let photo = null;
  try {
    photo = image(body.image, 'Photo');
  } catch (error) {
    return fail(res, error.status || 400, 'invalid_image', error.message);
  }
  const vehicle = {
    id: id(),
    seller_id: req.user.id,
    seller_role: req.user.role,
    seller_name: str(body.seller_name, 120) || req.user.full_name || '',
    contact_phone: str(body.contact_phone, 40) || req.user.phone || '',
    description,
    price: round2(num(body.price, 0)),
    currency: isValidCurrency(str(body.currency, 8).toUpperCase())
      ? str(body.currency, 8).toUpperCase()
      : data().settings.currency.default,
    location: str(body.location, 160),
    image: photo,
    status: 'published',
    created_at: nowIso()
  };
  data().mallVehicles.unshift(vehicle);
  persist();
  res.status(201).json({ vehicle });
});

router.patch('/mall/vehicles/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const vehicle = data().mallVehicles.find((v) => v.id === req.params.id);
  if (!vehicle) return fail(res, 404, 'not_found', 'Listing not found.');
  const isModerator = req.user.role === 'admin' && inScope(req.user, vehicle);
  if (vehicle.seller_id !== req.user.id && !isModerator) {
    return fail(res, 403, 'forbidden', 'You can only edit your own listing.');
  }
  const body = req.body || {};
  if (body.description !== undefined) vehicle.description = str(body.description, 3000);
  if (body.contact_phone !== undefined) vehicle.contact_phone = str(body.contact_phone, 40);
  if (body.location !== undefined) vehicle.location = str(body.location, 160);
  if (body.price !== undefined) vehicle.price = round2(num(body.price, 0));
  if (body.status !== undefined && ['published', 'removed'].includes(body.status)) {
    vehicle.status = body.status;
  }
  if (body.image !== undefined) {
    try {
      vehicle.image = image(body.image, 'Photo');
    } catch (error) {
      return fail(res, error.status || 400, 'invalid_image', error.message);
    }
  }
  vehicle.updated_at = nowIso();
  persist();
  res.json({ vehicle });
});

router.delete('/mall/vehicles/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  const vehicle = db.mallVehicles.find((v) => v.id === req.params.id);
  if (!vehicle) return fail(res, 404, 'not_found', 'Listing not found.');
  const isModerator = req.user.role === 'admin' && inScope(req.user, vehicle);
  if (vehicle.seller_id !== req.user.id && !isModerator) {
    return fail(res, 403, 'forbidden', 'You can only remove your own listing.');
  }
  db.mallVehicles = db.mallVehicles.filter((v) => v.id !== vehicle.id);
  persist();
  res.json({ ok: true });
});

router.get('/mall/shops', (req, res) => {
  const products = data().mallProducts || [];
  const shops = data()
    .mallShops.filter((s) => s.status !== 'removed')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((shop) => ({
      ...shop,
      product_count: products.filter((p) => p.shop_id === shop.id && p.status !== 'removed').length
    }));
  res.json({ shops });
});

router.post('/mall/shops', requireRole('worker', 'business', 'admin'), (req, res) => {
  const body = req.body || {};
  const name = str(body.name, 120);
  if (!name) return fail(res, 400, 'missing_name', 'Shop name is required.');
  const shop = {
    id: id(),
    owner_id: req.user.id,
    owner_role: req.user.role,
    name,
    phone: str(body.phone, 40) || req.user.phone || '',
    address: str(body.address, 160),
    description: str(body.description, 500),
    status: 'published',
    created_at: nowIso()
  };
  data().mallShops.unshift(shop);
  persist();
  res.status(201).json({ shop });
});

router.patch('/mall/shops/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const shop = data().mallShops.find((s) => s.id === req.params.id);
  if (!shop) return fail(res, 404, 'not_found', 'Shop not found.');
  const isModerator = req.user.role === 'admin' && inScope(req.user, shop);
  if (shop.owner_id !== req.user.id && !isModerator) {
    return fail(res, 403, 'forbidden', 'You can only edit your own shop.');
  }
  const body = req.body || {};
  if (body.name !== undefined) shop.name = str(body.name, 120) || shop.name;
  if (body.phone !== undefined) shop.phone = str(body.phone, 40);
  if (body.address !== undefined) shop.address = str(body.address, 160);
  if (body.description !== undefined) shop.description = str(body.description, 500);
  shop.updated_at = nowIso();
  persist();
  res.json({ shop });
});

router.delete('/mall/shops/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  const shop = db.mallShops.find((s) => s.id === req.params.id);
  if (!shop) return fail(res, 404, 'not_found', 'Shop not found.');
  const isModerator = req.user.role === 'admin' && inScope(req.user, shop);
  if (shop.owner_id !== req.user.id && !isModerator) {
    return fail(res, 403, 'forbidden', 'You can only remove your own shop.');
  }
  db.mallShops = db.mallShops.filter((s) => s.id !== shop.id);
  db.mallProducts = db.mallProducts.filter((p) => p.shop_id !== shop.id);
  persist();
  res.json({ ok: true });
});

router.get('/mall/products', (req, res) => {
  const shopId = str(req.query.shop_id, 60);
  const list = data()
    .mallProducts.filter((p) => p.status !== 'removed' && (!shopId || p.shop_id === shopId))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ products: list });
});

router.post('/mall/products', requireRole('worker', 'business', 'admin'), (req, res) => {
  const body = req.body || {};
  const shop = data().mallShops.find((s) => s.id === str(body.shop_id, 60));
  if (!shop) return fail(res, 400, 'invalid_shop', 'Create your shop first.');
  if (shop.owner_id !== req.user.id && req.user.role !== 'admin') {
    return fail(res, 403, 'forbidden', 'You can only add products to your own shop.');
  }
  const details = str(body.details, 3000);
  if (!details) return fail(res, 400, 'missing_details', 'Write the product details.');
  let photo = null;
  try {
    photo = image(body.image, 'Photo');
  } catch (error) {
    return fail(res, error.status || 400, 'invalid_image', error.message);
  }
  const original = round2(num(body.original_price, 0));
  const discounted = round2(num(body.discounted_price, 0));
  const product = {
    id: id(),
    shop_id: shop.id,
    shop_name: shop.name,
    owner_id: shop.owner_id,
    title: str(body.title, 140),
    details,
    original_price: original,
    discounted_price: discounted,
    discount: discounted > 0 && original > discounted,
    currency: isValidCurrency(str(body.currency, 8).toUpperCase())
      ? str(body.currency, 8).toUpperCase()
      : data().settings.currency.default,
    image: photo,
    status: 'published',
    created_at: nowIso()
  };
  data().mallProducts.unshift(product);
  persist();
  res.status(201).json({ product });
});

router.patch('/mall/products/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const product = data().mallProducts.find((p) => p.id === req.params.id);
  if (!product) return fail(res, 404, 'not_found', 'Product not found.');
  if (product.owner_id !== req.user.id && req.user.role !== 'admin') {
    return fail(res, 403, 'forbidden', 'You can only edit your own products.');
  }
  const body = req.body || {};
  if (body.title !== undefined) product.title = str(body.title, 140);
  if (body.details !== undefined) product.details = str(body.details, 3000);
  if (body.original_price !== undefined) product.original_price = round2(num(body.original_price, 0));
  if (body.discounted_price !== undefined) {
    product.discounted_price = round2(num(body.discounted_price, 0));
  }
  product.discount = product.discounted_price > 0 && product.original_price > product.discounted_price;
  if (body.status !== undefined && ['published', 'removed'].includes(body.status)) {
    product.status = body.status;
  }
  if (body.image !== undefined) {
    try {
      product.image = image(body.image, 'Photo');
    } catch (error) {
      return fail(res, error.status || 400, 'invalid_image', error.message);
    }
  }
  product.updated_at = nowIso();
  persist();
  res.json({ product });
});

router.delete('/mall/products/:id', requireRole('worker', 'business', 'admin'), (req, res) => {
  const db = data();
  const product = db.mallProducts.find((p) => p.id === req.params.id);
  if (!product) return fail(res, 404, 'not_found', 'Product not found.');
  if (product.owner_id !== req.user.id && req.user.role !== 'admin') {
    return fail(res, 403, 'forbidden', 'You can only remove your own products.');
  }
  db.mallProducts = db.mallProducts.filter((p) => p.id !== product.id);
  persist();
  res.json({ ok: true });
});

/* -------------------------------------------------------- open agreements */

/**
 * A worker or a business can start an agreement at any time, exactly like an
 * invoice, instead of waiting for the other side. When the counterparty email
 * belongs to a registered account, the agreement also appears in that account
 * and can be accepted or rejected there.
 */
router.post('/agreements/open', requireRole('worker', 'business'), (req, res) => {
  const body = req.body || {};
  const db = data();
  const creator = req.user;

  const scope = str(body.scope, 4000);
  const terms = str(body.terms, 4000);
  if (!scope) return fail(res, 400, 'missing_scope', 'Work description is required.');
  if (!terms) return fail(res, 400, 'missing_terms', 'Agreed terms are required.');

  let stampImage = null;
  let letterheadImage = null;
  try {
    stampImage = image(body.stamp_image, 'Stamp');
    letterheadImage = image(body.letterhead_image, 'Letterhead');
  } catch (error) {
    return fail(res, error.status || 400, 'invalid_image', error.message);
  }

  const counterpartyEmail = str(body.counterparty_email, 160).toLowerCase();
  const wantedRole = creator.role === 'worker' ? 'business' : 'worker';
  const counterparty = db.users.find(
    (u) => u.role === wantedRole && counterpartyEmail && u.email === counterpartyEmail
  );

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`;
  const serial = nextCounter('agreement');

  const agreement = {
    id: id(),
    ref: `WB-AGR-${stamp}-${serial}`,
    business_id: creator.role === 'business' ? creator.id : counterparty ? counterparty.id : null,
    worker_id: creator.role === 'worker' ? creator.id : counterparty ? counterparty.id : null,
    job_id: null,
    scope,
    terms,
    start_date: str(body.start_date, 20) || null,
    end_date: str(body.end_date, 20) || null,
    pay_amount: round2(num(body.pay_amount, 0)),
    pay_period: PAY_PERIODS.includes(str(body.pay_period, 20)) ? str(body.pay_period, 20) : 'month',
    currency: isValidCurrency(str(body.currency, 8).toUpperCase())
      ? str(body.currency, 8).toUpperCase()
      : db.settings.currency.default,
    status: 'pending_signatures',
    signatures: {},
    stamp_image: stampImage,
    letterhead_image: letterheadImage,
    counterparty: {
      name: str(body.counterparty_name, 120),
      phone: str(body.counterparty_phone, 40),
      email: counterpartyEmail
    },
    created_by: creator.id,
    created_by_role: creator.role,
    acceptance_status: counterparty ? 'pending' : 'external',
    created_at: nowIso()
  };

  db.agreements.unshift(agreement);
  if (counterparty) {
    db.notifications.unshift({
      id: id(),
      user_id: counterparty.id,
      title: 'Agreement to review',
      body: `${creator.full_name} created agreement ${agreement.ref}.`,
      link: `#/agreements/${agreement.id}`,
      read_at: null,
      created_at: nowIso()
    });
  }
  persist();
  res.status(201).json({ agreement });
});

/** The invited party reviews the agreement and accepts or rejects it. */
router.post('/agreements/:id/respond', requireRole('worker', 'business'), (req, res) => {
  const agreement = data().agreements.find((a) => a.id === req.params.id);
  if (!agreement) return fail(res, 404, 'not_found', 'Agreement not found.');
  const participant =
    agreement.worker_id === req.user.id || agreement.business_id === req.user.id;
  if (!participant) return fail(res, 403, 'forbidden', 'You are not a party to this agreement.');
  if (agreement.created_by === req.user.id) {
    return fail(res, 403, 'forbidden', 'The other party must accept this agreement.');
  }
  const decision = str((req.body || {}).decision, 20);
  if (!['accepted', 'rejected'].includes(decision)) {
    return fail(res, 400, 'invalid_decision', 'Choose accept or reject.');
  }
  agreement.acceptance_status = decision;
  agreement.acceptance_at = nowIso();
  agreement.acceptance_by = req.user.id;
  agreement.acceptance_note = str((req.body || {}).note, 500);
  persist();
  res.json({ agreement });
});

export default router;
