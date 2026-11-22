/**
 * BOOKING ROUTES — Business creates a booking, approved drivers offer a price,
 * the business picks a driver, the ride runs through its stages, then payment
 * and commission are recorded.
 *
 * Every transition is validated on the server. The browser only decides which
 * buttons to show; a direct API call cannot skip a stage, act as another party,
 * or read contact details before the selected driver has accepted.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { data, persist } from './store.js';
import { requireRole, hashPassword } from './security.js';
import { nowIso, round2, str, num, isEmail } from './util.js';
import { inScope, normalizeScope } from './scope.js';
import { currentCommission } from './commission.js';
import {
  VEHICLE_CATEGORIES,
  STATUS_LABELS,
  bookingView,
  eligibleDriver,
  eligibleDrivers,
  driverProfile,
  nextBookingRef,
  pushEvent,
  roundMoney,
  scopedBookings,
  validOffers
} from './bookings.js';

const router = Router();

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function notify(userId, title, body, link) {
  data().notifications.unshift({
    id: crypto.randomUUID(),
    user_id: userId,
    title,
    body,
    link: link || null,
    read_at: null,
    created_at: nowIso()
  });
}

const findBooking = (id) => (data().rideBookings || []).find((b) => b.id === id && b.kind === 'business');

/** Only an approved, active business may book. */
function bookingBusiness(req, res, next) {
  if (!req.user) return fail(res, 401, 'auth_required', 'Please sign in first.');
  if (req.user.role !== 'business') {
    return fail(res, 403, 'role_forbidden', 'Only business accounts can create bookings.');
  }
  if (req.user.status !== 'active') {
    return fail(res, 403, 'account_not_approved', 'Your business account is not approved yet.');
  }
  next();
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validTime(value) {
  return /^\d{2}:\d{2}$/.test(value);
}

/* ----------------------------------------------------------------- business */

router.post('/bookings', bookingBusiness, (req, res) => {
  const db = data();
  const body = req.body || {};
  const pickup = str(body.pickup, 200);
  const destination = str(body.destination, 200);
  const date = str(body.date, 10);
  const time = str(body.time, 5);
  const category = str(body.vehicle_category, 40);

  if (!pickup) return fail(res, 400, 'missing_pickup', 'Enter the pickup location.');
  if (!destination) return fail(res, 400, 'missing_destination', 'Enter the destination.');
  if (!validDate(date)) return fail(res, 400, 'invalid_date', 'Choose the pickup date.');
  if (!validTime(time)) return fail(res, 400, 'invalid_time', 'Choose the pickup time.');
  if (!VEHICLE_CATEGORIES.includes(category)) {
    return fail(res, 400, 'invalid_category', 'Choose one of the vehicle categories.');
  }

  const profile = db.businessProfiles.find((p) => p.user_id === req.user.id) || {};
  const booking = {
    id: crypto.randomUUID(),
    kind: 'business',
    ref: nextBookingRef(),
    business_id: req.user.id,
    business_name: profile.company_name || req.user.full_name,
    pickup,
    destination,
    date,
    time,
    vehicle_category: category,
    requirements: str(body.requirements, 1000),
    details: str(body.details, 2000),
    currency: str(body.currency, 8) || profile.currency || db.settings.currency || 'SAR',
    country: str(profile.country, 80),
    city: str(profile.city, 80),
    status: 'created',
    offers: [],
    selected_offer_id: null,
    selected_driver_id: null,
    selected_price: null,
    payment: null,
    events: [],
    created_at: nowIso(),
    updated_at: nowIso()
  };
  pushEvent(booking, 'created', req.user);
  db.rideBookings.unshift(booking);

  // Distribution: only admins-approved drivers in the area and category.
  const drivers = eligibleDrivers(booking);
  for (const driver of drivers) {
    notify(
      driver.id,
      'New booking request',
      `${booking.pickup} → ${booking.destination} · ${category}`,
      '#/worker/bookings'
    );
  }

  persist();
  res.status(201).json({ booking: bookingView(booking, req.user), notified_drivers: drivers.length });
});

router.get('/bookings/mine', bookingBusiness, (req, res) => {
  const list = (data().rideBookings || [])
    .filter((b) => b.kind === 'business' && b.business_id === req.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((b) => bookingView(b, req.user));
  res.json({ bookings: list });
});

router.get('/bookings/:id', (req, res) => {
  if (!req.user) return fail(res, 401, 'auth_required', 'Please sign in first.');
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  const viewer = req.user;
  const allowed =
    viewer.id === booking.business_id ||
    viewer.id === booking.selected_driver_id ||
    (booking.offers || []).some((offer) => offer.driver_id === viewer.id) ||
    viewer.role === 'admin' ||
    viewer.role === 'owner';
  if (!allowed) return fail(res, 403, 'forbidden', 'This booking is not available to you.');
  if (viewer.role === 'admin' && !inScope(viewer, booking)) {
    return fail(res, 403, 'out_of_scope', 'This booking is outside your assigned area.');
  }
  res.json({ booking: bookingView(booking, viewer) });
});

/** The business compares the four lowest offers and picks the driver itself. */
router.post('/bookings/:id/select', bookingBusiness, (req, res) => {
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (booking.business_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'This booking belongs to another business.');
  }
  if (!['created', 'offers'].includes(booking.status)) {
    return fail(res, 409, 'wrong_stage', 'A driver has already been selected for this booking.');
  }
  const offerId = str((req.body || {}).offer_id, 60);
  const offer = validOffers(booking).find((o) => o.id === offerId);
  if (!offer) return fail(res, 404, 'offer_not_found', 'That offer is no longer available.');

  booking.selected_offer_id = offer.id;
  booking.selected_driver_id = offer.driver_id;
  booking.selected_price = roundMoney(offer.price);
  booking.selected_vehicle = offer.vehicle_name;
  pushEvent(booking, 'selected', req.user);

  notify(
    offer.driver_id,
    'You were selected',
    `${booking.ref}: ${booking.pickup} → ${booking.destination}. Accept to confirm.`,
    '#/worker/bookings'
  );

  persist();
  res.json({ booking: bookingView(booking, req.user) });
});

router.post('/bookings/:id/cancel', bookingBusiness, (req, res) => {
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (booking.business_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'This booking belongs to another business.');
  }
  if (!['created', 'offers', 'selected'].includes(booking.status)) {
    return fail(res, 409, 'wrong_stage', 'A confirmed booking cannot be cancelled here.');
  }
  pushEvent(booking, 'cancelled', req.user);
  if (booking.selected_driver_id) {
    notify(booking.selected_driver_id, 'Booking cancelled', `${booking.ref} was cancelled by the business.`, '#/worker/bookings');
  }
  persist();
  res.json({ booking: bookingView(booking, req.user) });
});

/* ------------------------------------------------------------------- driver */

router.get('/bookings/available', requireRole('worker'), (req, res) => {
  const list = (data().rideBookings || [])
    .filter((b) => b.kind === 'business' && ['created', 'offers'].includes(b.status))
    .filter((b) => eligibleDriver(req.user, b))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((b) => bookingView(b, req.user));
  res.json({ bookings: list });
});

router.get('/bookings/driver/mine', requireRole('worker'), (req, res) => {
  const list = (data().rideBookings || [])
    .filter(
      (b) =>
        b.kind === 'business' &&
        (b.selected_driver_id === req.user.id ||
          (b.offers || []).some((offer) => offer.driver_id === req.user.id))
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((b) => bookingView(b, req.user));
  res.json({ bookings: list });
});

router.post('/bookings/:id/offers', requireRole('worker'), (req, res) => {
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (!['created', 'offers'].includes(booking.status)) {
    return fail(res, 409, 'wrong_stage', 'This booking is no longer open for offers.');
  }
  if (!eligibleDriver(req.user, booking)) {
    return fail(res, 403, 'not_eligible', 'You are not approved for this booking.');
  }
  const body = req.body || {};
  const vehicleName = str(body.vehicle_name, 120);
  const vehicleCategory = str(body.vehicle_category, 40);
  const price = roundMoney(body.price);
  if (!vehicleName) return fail(res, 400, 'missing_vehicle', 'Enter your vehicle name or model.');
  if (!VEHICLE_CATEGORIES.includes(vehicleCategory)) {
    return fail(res, 400, 'invalid_category', 'Choose a valid vehicle category.');
  }
  if (vehicleCategory !== booking.vehicle_category) {
    return fail(res, 400, 'category_mismatch', 'Your vehicle category must match the booking.');
  }
  const profile = driverProfile(req.user.id) || {};
  const approved = Array.isArray(profile.vehicle_categories) ? profile.vehicle_categories : [];
  if (!approved.includes(vehicleCategory)) {
    return fail(res, 403, 'category_not_approved', 'An admin has not approved you for that vehicle category.');
  }
  if (!(price > 0)) return fail(res, 400, 'invalid_price', 'Enter the price you offer for this booking.');

  if (!Array.isArray(booking.offers)) booking.offers = [];
  const existing = booking.offers.find((offer) => offer.driver_id === req.user.id);
  if (existing) {
    existing.vehicle_name = vehicleName;
    existing.vehicle_category = vehicleCategory;
    existing.price = price;
    existing.updated_at = nowIso();
  } else {
    booking.offers.push({
      id: crypto.randomUUID(),
      driver_id: req.user.id,
      driver_name: req.user.full_name,
      vehicle_name: vehicleName,
      vehicle_category: vehicleCategory,
      price,
      withdrawn: false,
      created_at: nowIso(),
      updated_at: nowIso()
    });
  }
  if (booking.status === 'created') pushEvent(booking, 'offers', req.user);
  else booking.updated_at = nowIso();

  persist();
  res.status(201).json({ booking: bookingView(booking, req.user) });
});

/** Selected driver accepts — this is the only way a booking is confirmed. */
router.post('/bookings/:id/accept', requireRole('worker'), (req, res) => {
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (booking.selected_driver_id !== req.user.id) {
    return fail(res, 403, 'not_selected', 'You were not selected for this booking.');
  }
  if (booking.status !== 'selected') {
    return fail(res, 409, 'wrong_stage', 'This booking is not waiting for your acceptance.');
  }
  pushEvent(booking, 'confirmed', req.user);
  notify(
    booking.business_id,
    'Booking confirmed',
    `${booking.ref}: your driver accepted. Contact details are now available.`,
    '#/business/bookings'
  );
  persist();
  res.json({ booking: bookingView(booking, req.user) });
});

const STAGE_ACTION = {
  pickup: { from: 'confirmed', to: 'pickup', error: 'Confirm the booking before pickup.' },
  dropoff: { from: 'pickup', to: 'dropoff', error: 'Confirm pickup before drop-off.' },
  'complete-order': { from: 'dropoff', to: 'complete_order', error: 'Confirm drop-off before completing the order.' }
};

for (const [path, rule] of Object.entries(STAGE_ACTION)) {
  router.post(`/bookings/:id/${path}`, requireRole('worker'), (req, res) => {
    const booking = findBooking(req.params.id);
    if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
    if (booking.selected_driver_id !== req.user.id) {
      return fail(res, 403, 'not_selected', 'You are not the assigned driver.');
    }
    if (booking.status !== rule.from) {
      return fail(res, 409, 'wrong_stage', rule.error);
    }
    pushEvent(booking, rule.to, req.user);
    if (rule.to === 'complete_order') {
      notify(
        booking.business_id,
        'Order completed',
        `${booking.ref}: record the payment to finish the booking.`,
        '#/business/bookings'
      );
    }
    persist();
    res.json({ booking: bookingView(booking, req.user) });
  });
}

/* ------------------------------------------------------------------ payment */

/**
 * Payment is recorded by the business after the ride is finished. Commission is
 * taken from the owner's current setting, and the remainder is what the driver
 * receives. The booking only reaches 'completed' after payment exists.
 */
router.post('/bookings/:id/payment', bookingBusiness, (req, res) => {
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (booking.business_id !== req.user.id) {
    return fail(res, 403, 'forbidden', 'This booking belongs to another business.');
  }
  if (booking.status !== 'complete_order') {
    return fail(res, 409, 'wrong_stage', 'Pickup, drop-off and order completion must be finished before payment.');
  }
  if (booking.payment && booking.payment.status === 'received') {
    return fail(res, 409, 'already_paid', 'This booking is already paid.');
  }
  const body = req.body || {};
  const amount = roundMoney(body.amount === undefined || body.amount === '' ? booking.selected_price : body.amount);
  const reference = str(body.reference, 80);
  const method = str(body.method, 40) || 'bank_transfer';
  if (!(amount > 0)) return fail(res, 400, 'invalid_amount', 'Enter the amount received.');
  if (!reference) return fail(res, 400, 'missing_reference', 'Enter the transaction reference.');

  const commission = currentCommission();
  const rate = Number(commission.rate) || 0;
  const commissionAmount = round2((amount * rate) / 100);
  const payable = round2(amount - commissionAmount);

  booking.payment = {
    amount,
    currency: booking.currency,
    commission_rate: rate,
    commission_amount: commissionAmount,
    payable_amount: payable,
    payer: commission.payer || 'business',
    status: 'received',
    reference,
    method,
    received_at: nowIso(),
    recorded_by: req.user.id
  };
  pushEvent(booking, 'paid', req.user);

  // Compact commission record — kept even at 0% for a complete audit trail.
  if (!Array.isArray(data().commissions)) data().commissions = [];
  data().commissions.unshift({
    id: crypto.randomUUID(),
    doc_type: 'booking',
    doc_id: booking.id,
    ref: booking.ref,
    amount,
    currency: booking.currency,
    rate,
    commission_amount: commissionAmount,
    payer: commission.payer || 'business',
    worker_id: booking.selected_driver_id,
    worker_name: booking.selected_vehicle || '',
    business_id: booking.business_id,
    business_name: booking.business_name || '',
    country: booking.country || '',
    city: booking.city || '',
    recorded_by: req.user.id,
    created_at: nowIso()
  });

  if (booking.selected_driver_id) {
    notify(
      booking.selected_driver_id,
      'Payment received',
      `${booking.ref}: ${amount} ${booking.currency} received.`,
      '#/worker/bookings'
    );
  }
  persist();
  res.json({ booking: bookingView(booking, req.user) });
});

/** Final step: only after payment exists. */
router.post('/bookings/:id/finalize', (req, res) => {
  if (!req.user) return fail(res, 401, 'auth_required', 'Please sign in first.');
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  const isBusiness = req.user.id === booking.business_id;
  const isDriver = req.user.id === booking.selected_driver_id;
  if (!isBusiness && !isDriver && req.user.role !== 'admin' && req.user.role !== 'owner') {
    return fail(res, 403, 'forbidden', 'You cannot finalize this booking.');
  }
  if (booking.status !== 'paid') {
    return fail(res, 409, 'wrong_stage', 'Payment must be recorded before the booking is completed.');
  }
  pushEvent(booking, 'completed', req.user);
  persist();
  res.json({ booking: bookingView(booking, req.user) });
});

/* -------------------------------------------------------------------- admin */

router.get('/admin/drivers', requireRole('admin'), (req, res) => {
  const db = data();
  const rows = db.users
    .filter((u) => u.role === 'worker')
    .map((u) => {
      const profile = driverProfile(u.id) || {};
      return {
        id: u.id,
        full_name: u.full_name,
        phone: u.phone,
        email: u.email,
        status: u.status,
        country: profile.country || '',
        city: profile.city || '',
        vehicle_name: profile.vehicle_name || '',
        booking_approved: profile.booking_approved === true,
        vehicle_categories: Array.isArray(profile.vehicle_categories) ? profile.vehicle_categories : [],
        ride_booking_enabled: u.ride_booking_enabled === true
      };
    })
    .filter((row) => inScope(req.user, row));
  res.json({ drivers: rows, categories: VEHICLE_CATEGORIES });
});

router.patch('/admin/drivers/:id/booking', requireRole('admin'), (req, res) => {
  const db = data();
  const user = db.users.find((u) => u.id === req.params.id && u.role === 'worker');
  if (!user) return fail(res, 404, 'not_found', 'Driver not found.');
  const profile = driverProfile(user.id);
  if (!profile) return fail(res, 404, 'not_found', 'Driver profile not found.');
  if (!inScope(req.user, { country: profile.country, city: profile.city })) {
    return fail(res, 403, 'out_of_scope', 'This driver is outside your assigned area.');
  }
  const body = req.body || {};
  if (body.booking_approved !== undefined) {
    profile.booking_approved = Boolean(body.booking_approved);
    user.ride_booking_enabled = Boolean(body.booking_approved);
  }
  if (body.vehicle_categories !== undefined) {
    const list = Array.isArray(body.vehicle_categories)
      ? body.vehicle_categories
      : String(body.vehicle_categories).split(',');
    profile.vehicle_categories = [...new Set(list.map((c) => str(c, 40)).filter((c) => VEHICLE_CATEGORIES.includes(c)))];
  }
  if (body.vehicle_name !== undefined) profile.vehicle_name = str(body.vehicle_name, 120);
  persist();
  res.json({
    driver: {
      id: user.id,
      booking_approved: profile.booking_approved === true,
      vehicle_categories: profile.vehicle_categories || [],
      ride_booking_enabled: user.ride_booking_enabled === true
    }
  });
});

router.get('/admin/bookings', requireRole('admin'), (req, res) => {
  const list = scopedBookings(req.user)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((b) => bookingView(b, req.user));
  res.json({ bookings: list, statuses: STATUS_LABELS });
});

router.get('/admin/payments', requireRole('admin'), (req, res) => {
  const rows = scopedBookings(req.user)
    .filter((b) => b.payment)
    .map((b) => ({
      booking_id: b.id,
      ref: b.ref,
      date: b.payment.received_at,
      business_name: b.business_name || '',
      driver_name: b.selected_vehicle || '',
      amount: b.payment.amount,
      currency: b.payment.currency,
      rate: b.payment.commission_rate,
      commission_amount: b.payment.commission_amount,
      payable_amount: b.payment.payable_amount,
      reference: b.payment.reference,
      status: b.payment.status
    }));
  res.json({ payments: rows });
});

/* -------------------------------------------------------------------- owner */

router.get('/owner/platform', requireRole('owner'), (req, res) => {
  const db = data();
  const bookings = (db.rideBookings || []).filter((b) => b.kind === 'business');
  const paid = bookings.filter((b) => b.payment);
  const byCurrency = new Map();
  for (const booking of paid) {
    const key = booking.payment.currency || '—';
    const row = byCurrency.get(key) || { currency: key, bookings: 0, gross: 0, commission: 0, payable: 0 };
    row.bookings += 1;
    row.gross = round2(row.gross + (Number(booking.payment.amount) || 0));
    row.commission = round2(row.commission + (Number(booking.payment.commission_amount) || 0));
    row.payable = round2(row.payable + (Number(booking.payment.payable_amount) || 0));
    byCurrency.set(key, row);
  }
  const statusCounts = {};
  for (const booking of bookings) {
    statusCounts[booking.status] = (statusCounts[booking.status] || 0) + 1;
  }
  res.json({
    commission_setting: currentCommission(),
    accounts: {
      owner: db.users.filter((u) => u.role === 'owner').length,
      admins: db.users.filter((u) => u.role === 'admin').length,
      businesses: db.users.filter((u) => u.role === 'business').length,
      drivers: db.users.filter((u) => u.role === 'worker').length
    },
    bookings: { total: bookings.length, by_status: statusCounts },
    money: [...byCurrency.values()],
    recent_payments: paid
      .sort((a, b) => new Date(b.payment.received_at) - new Date(a.payment.received_at))
      .slice(0, 20)
      .map((b) => ({
        ref: b.ref,
        date: b.payment.received_at,
        business_name: b.business_name,
        amount: b.payment.amount,
        currency: b.payment.currency,
        rate: b.payment.commission_rate,
        commission_amount: b.payment.commission_amount,
        payable_amount: b.payment.payable_amount,
        reference: b.payment.reference
      }))
  });
});

/** Owner creates an admin directly with an explicit scope. */
router.post('/owner/admins/create', requireRole('owner'), (req, res) => {
  const db = data();
  const body = req.body || {};
  const email = str(body.email, 160).toLowerCase();
  const fullName = str(body.full_name, 120);
  const password = String(body.password || '');
  if (!isEmail(email)) return fail(res, 400, 'invalid_email', 'Enter a valid email address.');
  if (!fullName) return fail(res, 400, 'missing_name', 'Enter the admin name.');
  if (password.length < 10) return fail(res, 400, 'weak_password', 'Use a password of at least 10 characters.');
  if (db.users.some((u) => u.email === email)) {
    return fail(res, 409, 'email_taken', 'Another account already uses that email.');
  }
  const user = {
    id: crypto.randomUUID(),
    role: 'admin',
    full_name: fullName,
    email,
    phone: str(body.phone, 40),
    password_hash: hashPassword(password),
    status: 'active',
    admin_scope: normalizeScope(body.scope),
    session_epoch: 0,
    created_at: nowIso(),
    approved_at: nowIso(),
    created_by: req.user.id
  };
  db.users.push(user);
  persist();
  res.status(201).json({
    admin: { id: user.id, email: user.email, full_name: user.full_name, admin_scope: user.admin_scope }
  });
});

/** Owner changes an admin's scope or suspends/reactivates the account. */
router.patch('/owner/admins/:id/access', requireRole('owner'), (req, res) => {
  const db = data();
  const admin = db.users.find((u) => u.id === req.params.id && u.role === 'admin');
  if (!admin) return fail(res, 404, 'not_found', 'Admin account not found.');
  const body = req.body || {};
  if (body.scope !== undefined) admin.admin_scope = normalizeScope(body.scope);
  if (body.status !== undefined) {
    const status = str(body.status, 20);
    if (!['active', 'suspended'].includes(status)) {
      return fail(res, 400, 'invalid_status', 'Choose active or suspended.');
    }
    admin.status = status;
    admin.session_epoch = (Number(admin.session_epoch) || 0) + 1;
  }
  if (body.full_name !== undefined) admin.full_name = str(body.full_name, 120) || admin.full_name;
  persist();
  res.json({
    admin: { id: admin.id, full_name: admin.full_name, status: admin.status, admin_scope: admin.admin_scope }
  });
});

export default router;
