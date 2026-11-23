/**
 * BOOKING DOMAIN — Business → driver offers → staged ride → payment.
 *
 * A booking lives in the existing `rideBookings` collection with `kind:
 * 'business'` (public "Book Your Car" requests stay `kind: 'public'`), so no new
 * table is needed and the record stays lightweight: offers are embedded, the
 * payment summary is one small object, and history is a compact event list.
 *
 * Stage order is enforced here, not in the browser:
 *   created → offers → selected → confirmed → pickup → dropoff
 *           → complete_order → paid → completed
 */
import crypto from 'node:crypto';
import { data } from './store.js';
import { nowIso, round2 } from './util.js';
import { inScope } from './scope.js';

/**
 * A price is normally a plain number, but older records stored the whole offer
 * or an { amount } object in the price field. Every price leaving the server is
 * normalised here so a dashboard can never render "[object Object] 250.00".
 */
const money = (value) => {
  if (value && typeof value === 'object') {
    return Number(value.price ?? value.amount ?? value.value ?? 0) || 0;
  }
  return Number(value) || 0;
};

export const VEHICLE_CATEGORIES = ['Small Car', 'Go', 'Business', 'VIP'];

export const STAGE_FLOW = [
  'created',
  'offers',
  'selected',
  'confirmed',
  'pickup',
  'dropoff',
  'complete_order',
  'paid',
  'completed'
];

export const STATUS_LABELS = {
  created: 'Booking created',
  offers: 'Offers received',
  selected: 'Driver selected',
  confirmed: 'Booking confirmed',
  pickup: 'Customer picked up',
  dropoff: 'Dropped off',
  complete_order: 'Order completed',
  paid: 'Payment received',
  completed: 'Booking completed',
  cancelled: 'Cancelled'
};

/** Offers shown to the business: only the four lowest valid prices. */
export const OFFER_VISIBLE_LIMIT = 4;

export const stageIndex = (status) => STAGE_FLOW.indexOf(status);

export const isBusinessBooking = (booking) => Boolean(booking && booking.kind === 'business');

/**
 * One pipeline serves both the business panel and the public "Book Your Car"
 * customer flow, so every offer/selection/stage route must accept both kinds.
 */
export const isBookingRecord = (booking) =>
  Boolean(booking && (booking.kind === 'business' || booking.kind === 'customer'));

export function driverProfile(userId) {
  return data().workerProfiles.find((profile) => profile.user_id === userId) || null;
}

function rideSettings() {
  const raw = (data().settings && data().settings.rideBooking) || {};
  return { enabled: raw.enabled !== false };
}

/**
 * A driver receives a business booking only when every one of these is true:
 * approved by an admin for bookings, enabled for bookings, approved for the
 * requested vehicle category, and located in the booking's area. The global
 * switch stops new distribution immediately.
 */
export function eligibleDriver(user, booking) {
  if (!user || user.role !== 'worker' || user.status !== 'active') return false;
  if (!rideSettings().enabled) return false;
  if (user.ride_booking_enabled !== true) return false;
  const profile = driverProfile(user.id) || {};
  if (profile.booking_approved !== true) return false;
  const categories = Array.isArray(profile.vehicle_categories) ? profile.vehicle_categories : [];
  if (!categories.includes(booking.vehicle_category)) return false;
  const bookCountry = String(booking.country || '').trim().toLowerCase();
  const bookCity = String(booking.city || '').trim().toLowerCase();
  const driverCountry = String(profile.country || '').trim().toLowerCase();
  const driverCity = String(profile.city || '').trim().toLowerCase();
  // Region matching only excludes a driver whose region is known to differ, so
  // a driver who has not set a country/city yet is not silently cut off.
  if (bookCountry && driverCountry && driverCountry !== bookCountry) return false;
  if (bookCity && driverCity && driverCity !== bookCity) return false;
  return true;
}

export function eligibleDrivers(booking) {
  return data().users.filter((user) => eligibleDriver(user, booking));
}

/** Valid, non-withdrawn offers, cheapest first. */
export function validOffers(booking) {
  return (Array.isArray(booking.offers) ? booking.offers : [])
    .filter((offer) => offer && offer.withdrawn !== true && Number(offer.price) > 0)
    .sort((a, b) => Number(a.price) - Number(b.price) || new Date(a.created_at) - new Date(b.created_at));
}

/** The four lowest offers — the only offers a business may compare. */
export function visibleOffers(booking) {
  return validOffers(booking).slice(0, OFFER_VISIBLE_LIMIT);
}

/**
 * Offers that can still be chosen. Once a driver is selected the other offers
 * are closed (kept as history) and must no longer be selectable or actionable.
 */
export function openOffers(booking) {
  return validOffers(booking).filter((offer) => !offer.closed_reason);
}

/** Contact details unlock only after the selected driver accepts. */
export function contactUnlocked(booking) {
  return stageIndex(booking.status) >= stageIndex('confirmed');
}

/**
 * The two parties exchange contact details as soon as the customer or business
 * has chosen a driver: the chosen driver needs the customer's number, and the
 * customer needs the driver's. Nobody else sees them.
 */
export function contactVisible(booking) {
  return booking.status !== 'cancelled' && stageIndex(booking.status) >= stageIndex('selected');
}

/**
 * Once a booking is completed the phone numbers are withdrawn from every
 * dashboard. The booking record itself (route, dates, price, payment, history)
 * is kept untouched for accounting.
 */
export const phonesHidden = (booking) => booking.status === 'completed';

function businessRecord(businessId) {
  const db = data();
  const user = db.users.find((u) => u.id === businessId) || null;
  const profile = db.businessProfiles.find((p) => p.user_id === businessId) || null;
  return { user, profile };
}

export function driverRecord(driverId) {
  const db = data();
  const user = db.users.find((u) => u.id === driverId) || null;
  const profile = user ? driverProfile(user.id) : null;
  return { user, profile };
}

function driverContact(driverId) {
  const { user, profile } = driverRecord(driverId);
  return {
    id: driverId,
    name: user?.full_name || 'Driver',
    phone: user?.phone || '',
    whatsapp: user?.phone || '',
    vehicle_name: profile?.vehicle_name || ''
  };
}

function businessContact(businessId) {
  const { user, profile } = businessRecord(businessId);
  return {
    id: businessId,
    company_name: profile?.company_name || user?.full_name || 'Business',
    contact_name: profile?.contact_name || user?.full_name || '',
    phone: profile?.phone || user?.phone || '',
    whatsapp: profile?.phone || user?.phone || ''
  };
}

function offerView(offer) {
  return {
    id: offer.id,
    driver_id: offer.driver_id,
    driver_name: offer.driver_name,
    vehicle_name: offer.vehicle_name,
    vehicle_category: offer.vehicle_category,
    price: money(offer.price),
    created_at: offer.created_at
  };
}

/**
 * Booking payload for a viewer. Private contact details are only attached when
 * the viewer is the owning business or the selected driver AND the driver has
 * accepted. Non-selected drivers never see business or customer contact data.
 */
export function bookingView(booking, viewer) {
  const isBusinessOwner = Boolean(viewer && viewer.id === booking.business_id);
  const isSelectedDriver = Boolean(viewer && viewer.id === booking.selected_driver_id);
  const isAdminViewer = Boolean(viewer && (viewer.role === 'admin' || viewer.role === 'owner'));
  const unlocked = contactVisible(booking);
  const finished = phonesHidden(booking);

  const myOffer = viewer
    ? (booking.offers || []).find((offer) => offer.driver_id === viewer.id) || null
    : null;

  const selectedDriverUser = booking.selected_driver_id
    ? data().users.find((user) => user.id === booking.selected_driver_id) || null
    : null;
  const selectedOffer = validOffers(booking).find(
    (offer) => offer.id === booking.selected_offer_id
  );
  const selectedVehicle =
    (typeof booking.selected_vehicle === 'string' && booking.selected_vehicle) ||
    (selectedOffer && typeof selectedOffer.vehicle_name === 'string' && selectedOffer.vehicle_name) ||
    '';

  let offers = [];
  let eligibleCount = 0;
  if (isBusinessOwner || isAdminViewer) {
    offers = visibleOffers(booking).map(offerView);
    // How many approved drivers the request actually reached, so the business
    // can see that offers are still coming in rather than guessing.
    eligibleCount = eligibleDrivers(booking).length;
  } else if (viewer && viewer.role === 'worker') {
    offers = myOffer ? [offerView(myOffer)] : [];
  }

  const view = {
    id: booking.id,
    ref: booking.ref,
    kind: booking.kind || 'public',
    status: booking.status,
    status_label: STATUS_LABELS[booking.status] || booking.status,
    stage: stageIndex(booking.status),
    pickup: booking.pickup,
    destination: booking.destination,
    date: booking.date,
    time: booking.time,
    vehicle_category: booking.vehicle_category,
    requirements: booking.requirements || '',
    details: booking.details || '',
    currency: booking.currency,
    country: booking.country || '',
    city: booking.city || '',
    created_at: booking.created_at,
    updated_at: booking.updated_at,
    // When the business confirmed a driver, so the admin list can show it even
    // after the ride is completed.
    confirmed_at:
      (booking.events || []).find((event) => event.status === 'confirmed')?.at || null,
    offers,
    offer_count: validOffers(booking).length,
    eligible_driver_count: eligibleCount,
    my_offer: myOffer ? offerView(myOffer) : null,
    selected_offer_id: booking.selected_offer_id || null,
    selected_driver_id: booking.selected_driver_id || null,
    selected_driver_name: selectedDriverUser ? selectedDriverUser.full_name || '' : '',
    selected_vehicle: selectedVehicle,
    selected_price:
      booking.selected_price === null || booking.selected_price === undefined
        ? null
        : money(booking.selected_price),
    events: (booking.events || []).map((event) => ({
      status: event.status,
      label: STATUS_LABELS[event.status] || event.status,
      at: event.at,
      by_role: event.by_role
    })),
    payment: null,
    business: null,
    driver: null,
    can: {
      select: isBusinessOwner && ['created', 'offers'].includes(booking.status),
      offer: Boolean(viewer && viewer.role === 'worker' && eligibleDriver(viewer, booking)),
      accept: isSelectedDriver && booking.status === 'selected',
      pickup: isSelectedDriver && booking.status === 'confirmed',
      dropoff: isSelectedDriver && booking.status === 'pickup',
      complete_order: isSelectedDriver && booking.status === 'dropoff',
      pay: isBusinessOwner && booking.status === 'complete_order',
      finalize: (isBusinessOwner || isSelectedDriver) && booking.status === 'paid',
      cancel: isBusinessOwner && ['created', 'offers', 'selected'].includes(booking.status),
      // Chat exists only for these two parties, and only once the business has
      // confirmed the driver (status 'selected' or later).
      chat:
        Boolean(booking.selected_driver_id) &&
        booking.status !== 'cancelled' &&
        stageIndex(booking.status) >= stageIndex('selected') &&
        (isBusinessOwner || isSelectedDriver)
    }
  };

  // Business identity is shared with the chosen driver as soon as they are selected.
  if (isBusinessOwner || (isSelectedDriver && unlocked) || isAdminViewer) {
    view.business = businessContact(booking.business_id);
    if (finished) {
      view.business.phone = '';
      view.business.whatsapp = '';
    }
  }
  // The business also needs the chosen driver's number, otherwise the two
  // parties still cannot call each other.
  if (unlocked && booking.selected_driver_id && (isSelectedDriver || isBusinessOwner || isAdminViewer)) {
    view.driver = driverContact(booking.selected_driver_id);
    if (finished) {
      view.driver.phone = '';
      view.driver.whatsapp = '';
    }
  }
  // A public "Book Your Car" booking has no business account, so the chosen
  // driver gets the customer's details — withdrawn again once completed.
  if (unlocked && (isSelectedDriver || isAdminViewer || isBusinessOwner) && (booking.customer_name || booking.customer_phone)) {
    view.customer = {
      name: booking.customer_name || 'Customer',
      phone: finished ? '' : booking.customer_phone || '',
      whatsapp: finished ? '' : booking.customer_phone || ''
    };
  }
  // Lets every panel state plainly that the numbers were removed on completion.
  view.contact_hidden = finished;

  if (booking.payment) {
    view.payment = {
      amount: money(booking.payment.amount),
      currency: booking.payment.currency,
      commission_rate: Number(booking.payment.commission_rate) || 0,
      commission_amount: money(booking.payment.commission_amount),
      // Full fare to the driver; commission is recorded separately.
      payable_amount:
        booking.payment.payable_amount === undefined || booking.payment.payable_amount === null
          ? money(booking.payment.amount)
          : money(booking.payment.payable_amount),
      payer: booking.payment.payer,
      status: booking.payment.status,
      reference: booking.payment.reference,
      method: booking.payment.method,
      received_at: booking.payment.received_at
    };
  }

  return view;
}

/** Append-only stage history with timestamps — small and audit-friendly. */
/**
 * Public view for the customer who created a "Book Your Car" request. It shows
 * the offers received and, only after the selected driver accepts, that one
 * driver's contact details — never another driver's.
 */
export function customerBookingView(booking) {
  const base = bookingView(booking, null);
  const unlocked = contactVisible(booking);
  const finished = phonesHidden(booking);
  const selectedOffer = booking.selected_offer_id
    ? (booking.offers || []).find((offer) => offer.id === booking.selected_offer_id) || null
    : null;
  const selectedVehicle = booking.selected_vehicle || (selectedOffer && selectedOffer.vehicle_name) || '';
  let selectedDriver = null;
  if (booking.selected_driver_id) {
    const record = driverRecord(booking.selected_driver_id);
    const driverUser = record?.user || null;
    selectedDriver = {
      name: driverUser?.full_name || driverUser?.name || 'Selected driver',
      phone: unlocked && !finished ? driverUser?.phone || '' : '',
      vehicle_name: selectedVehicle,
      price: money(booking.selected_price)
    };
  }
  const all = validOffers(booking);
  // Before a choice the customer compares the offers; afterwards the page shows
  // the driver they picked, with the closed offers counted but not offered again.
  const shown = booking.selected_offer_id
    ? all.filter((offer) => offer.id === booking.selected_offer_id)
    : visibleOffers(booking);
  return {
    ...base,
    offers: shown.map(offerView),
    offer_count: all.length,
    closed_offer_count: all.filter((offer) => offer.closed_reason).length,
    eligible_driver_count: eligibleDrivers(booking).length,
    selected_driver: selectedDriver,
    customer_name: booking.customer_name || '',
    customer_phone: booking.customer_phone || '',
    contact_hidden: finished
  };
}

export function pushEvent(booking, status, actor) {
  if (!Array.isArray(booking.events)) booking.events = [];
  booking.events.push({
    status,
    at: nowIso(),
    by_id: actor ? actor.id : null,
    by_role: actor ? actor.role : 'system'
  });
  booking.status = status;
  booking.updated_at = nowIso();
}

export function nextBookingRef() {
  const db = data();
  if (!db.meta.counters) db.meta.counters = {};
  const current = Number(db.meta.counters.booking) || 1000;
  db.meta.counters.booking = current + 1;
  return `BK-${db.meta.counters.booking}`;
}

export function newBookingId() {
  return crypto.randomUUID();
}

export function roundMoney(value) {
  return round2(Number(value) || 0);
}

/** Admins see only bookings inside their assigned area. */
export function scopedBookings(admin) {
  const list = (data().rideBookings || []).filter(isBookingRecord);
  return list.filter((booking) => inScope(admin, booking));
}
