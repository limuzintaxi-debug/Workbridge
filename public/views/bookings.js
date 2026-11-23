/**
 * FOUR-PANEL BOOKING UI.
 *
 *  - Business panel : create a booking, compare the four lowest driver offers,
 *                     pick the driver, record payment.
 *  - Driver panel   : see only bookings it is eligible for, offer a price, and
 *                     move the ride through pickup → drop-off → complete.
 *  - Admin panel    : approve drivers per vehicle category and review bookings
 *                     and payments inside the admin's own area.
 *  - Owner panel    : platform totals, commission history and admin control.
 *
 * The server owns every rule; this file only renders what the API returns, so a
 * hidden button is never the security boundary.
 */
import { api } from '../api.js';
import { esc, toast, money, fmtDate } from '../ui.js';
import { panelShell, statCards } from './common.js';

const CATEGORIES = ['Small Car', 'Go', 'Business', 'VIP'];

const STATUS_LABEL = {
  created: 'Booking Created',
  offers: 'Offers Received',
  selected: 'Driver Selected',
  confirmed: 'Booking Confirmed',
  pickup: 'Pickup',
  dropoff: 'Drop-off',
  complete_order: 'Order Completed',
  paid: 'Payment Received',
  completed: 'Booking Completed',
  cancelled: 'Cancelled'
};

const STEP_ORDER = [
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

const statusLabel = (status) => STATUS_LABEL[status] || status;
const badge = (status) => `<span class="tag tag-status">${esc(statusLabel(status))}</span>`;
const amount = (value, currency) =>
  money(
    Number(
      value && typeof value === 'object' ? value.price ?? value.amount ?? value.value ?? 0 : value
    ) || 0,
    currency || ''
  );

/**
 * The nine stages appear exactly once, as a single line at the top of the page.
 * An individual booking shows only its own status badge, never the whole list
 * again — that repeated list is what made the dashboard unreadable.
 */
function stageStrip() {
  return `<p class="stage-line">${STEP_ORDER.map((step) => esc(STATUS_LABEL[step])).join(
    ' <span aria-hidden="true">→</span> '
  )}</p>`;
}

/**
 * One contact card. The server only sends these fields while the booking is
 * active, so an empty party simply renders nothing.
 */
function contactBox(label, party) {
  if (!party) return '';
  const name = party.company_name || party.contact_name || party.name || '';
  const phone = party.phone || '';
  const whatsapp = party.whatsapp || phone;
  if (!name && !phone) return '';
  const digits = String(whatsapp).replace(/[^\d]/g, '');
  return `<div class="contact-box">
    <span class="tag">${esc(label)}</span>
    ${name ? `<strong>${esc(name)}</strong>` : ''}
    ${phone ? `<div><a href="tel:${esc(phone)}">${esc(phone)}</a></div>` : ''}
    ${digits ? `<div><a href="https://wa.me/${esc(digits)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ''}
  </div>`;
}

/**
 * Contact details are shared between the two parties from the moment the driver
 * is chosen, and withdrawn by the server once the booking is completed. The
 * record itself (dates, prices, payment, history) is never removed.
 */
function contactOf(booking, omit) {
  const blocks = [
    omit === 'customer' ? '' : contactBox('Customer', booking.customer),
    omit === 'driver' ? '' : contactBox('Driver', booking.driver),
    omit === 'business' ? '' : contactBox('Business', booking.business)
  ].join('');
  // Completed bookings simply stop showing numbers; no explanatory note.
  return blocks ? `<div class="contact-wrap">${blocks}</div>` : '';
}

function offersOf(booking) {
  const list = booking.visible_offers || booking.offers || [];
  return Array.isArray(list) ? list : [];
}

function route(booking) {
  return `${esc(booking.pickup)} → ${esc(booking.destination)}`;
}

function meta(booking) {
  return `<div class="job-meta">
    <span class="tag">${esc(booking.vehicle_category)}</span>
    <span>${esc(booking.date)} · ${esc(booking.time)}</span>
    <span class="muted">Ref ${esc(booking.ref || booking.id.slice(0, 8))}</span>
  </div>`;
}

/* ----------------------------------------------------------------- business */

function offersTable(booking) {
  const offers = offersOf(booking);
  const eligible = Number(booking.eligible_driver_count) || 0;
  if (!offers.length) {
    return `<p class="muted">No driver offers yet.${
      eligible ? ` Sent to ${eligible} approved driver(s) for ${esc(booking.vehicle_category)}.` : ''
    } Offers appear here as drivers submit their price.</p>`;
  }
  const open = ['created', 'offers'].includes(booking.status);
  const total = Number(booking.offer_count) || offers.length;
  return `<div class="offer-list">
    <div class="offer-head"><span>Driver / vehicle</span><span>Category</span><span>Offer</span><span></span></div>
    ${offers
      .map(
        (offer, index) => `<div class="offer-row">
          <span><b>${esc(offer.driver_name || 'Driver')}</b>
            <div class="muted">${esc(offer.vehicle_name)}${
              index === 0 ? ' <span class="tag">lowest</span>' : ''
            }</div></span>
          <span>${esc(offer.vehicle_category)}</span>
          <span class="offer-price">${amount(offer.price, booking.currency)}</span>
          <span>${
            open
              ? `<button class="btn btn-sm btn-navy" data-select="${esc(offer.id)}" data-booking="${esc(booking.id)}">Select</button>`
              : ''
          }</span>
        </div>`
      )
      .join('')}
  </div>
  <p class="muted" style="margin:6px 0 0">Showing the ${offers.length} lowest valid offer${
    offers.length === 1 ? '' : 's'
  } of ${total} received. You choose the driver — the cheapest is never assigned automatically.</p>`;
}

function paymentBlock(booking, options = {}) {
  if (booking.payment) {
    const pay = booking.payment;
    return `<div class="card card-flat">
      <h4>Payment recorded</h4>
      <p class="muted" style="margin:4px 0">Reference ${esc(pay.reference)} · ${esc(pay.method || '')}</p>
      <ul class="money-list">
        <li><span>Total received from customer</span><b>${amount(pay.amount, pay.currency)}</b></li>
        <li><span>Paid to driver (full amount)</span><b>${amount(pay.payable_amount, pay.currency)}</b></li>
        <li><span>Platform commission (${Number(pay.commission_rate) || 0}% — recorded separately, not deducted)</span><b>${amount(
          pay.commission_amount,
          pay.currency
        )}</b></li>
      </ul>
      ${
        booking.status !== 'paid'
          ? `<span class="tag">Booking completed</span>`
          : options.finalizeButton === false
            ? ''
            : `<button class="btn btn-navy btn-sm" data-finalize="${esc(booking.id)}">Complete booking</button>`
      }
    </div>`;
  }
  if (booking.status !== 'complete_order') return '';
  return `<form class="card card-flat" data-pay-form="${esc(booking.id)}">
    <h4>Receive payment</h4>
    <p class="muted" style="margin:4px 0 8px">Record the amount received after the ride is finished.</p>
    <div class="grid-2">
      <div class="field"><label>Amount (${esc(booking.currency)})</label>
        <input name="amount" type="number" min="0" step="0.01" value="${esc(booking.selected_price || '')}" required /></div>
      <div class="field"><label>Transaction reference</label>
        <input name="reference" maxlength="80" placeholder="Bank / transfer reference" required /></div>
    </div>
    <div class="field"><label>Method</label>
      <select name="method">
        <option value="cash">Cash</option>
        <option value="bank_transfer">Bank transfer</option>
        <option value="card">Card</option>
        <option value="wallet">Wallet</option>
      </select></div>
    <button class="btn btn-navy" type="submit">Record payment</button>
  </form>`;
}

function businessCard(booking) {
  return `<article class="card booking-card">
    <header class="booking-head">
      <div><h3>${route(booking)}</h3>${meta(booking)}</div>
      <div>${badge(booking.status)}</div>
    </header>
    ${booking.details ? `<p class="muted">${esc(booking.details)}</p>` : ''}
    ${booking.requirements ? `<p class="muted">Requirements: ${esc(booking.requirements)}</p>` : ''}
    ${booking.selected_price ? `<p><b>Agreed price:</b> ${amount(booking.selected_price, booking.currency)}</p>` : ''}
    ${
      booking.selected_driver_name || booking.selected_vehicle
        ? `<p class="muted">Driver: ${esc(booking.selected_driver_name || 'Assigned driver')}${
            booking.selected_vehicle ? ` — ${esc(booking.selected_vehicle)}` : ''
          }</p>`
        : ''
    }
    ${['created', 'offers'].includes(booking.status) ? offersTable(booking) : ''}
    ${
      booking.status === 'selected'
        ? `<p class="notice">Driver selected — waiting for them to accept. Contact details are available below.</p>`
        : ''
    }
    ${contactOf(booking, 'business')}
    ${paymentBlock(booking)}
    ${
      ['created', 'offers', 'selected'].includes(booking.status)
        ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" data-cancel="${esc(booking.id)}">Cancel booking</button></div>`
        : ''
    }
  </article>`;
}

export async function businessBookingsView(ctx) {
  const { bookings } = await api.get('/bookings/mine');
  const tabs = [
    ['#/business', 'Dashboard'],
    ['#/business/bookings', 'Book a Car'],
    ['#/business/jobs', 'My Listings'],
    ['#/business/profile', 'Profile']
  ];
  const form = `<form class="card" id="booking-form">
    <h3>Create a booking</h3>
    <p class="muted" style="margin:4px 0 12px">Your request goes to approved drivers for the chosen vehicle category.</p>
    <div class="grid-2">
      <div class="field"><label for="bk-pickup">Pickup location</label><input id="bk-pickup" name="pickup" required maxlength="200" /></div>
      <div class="field"><label for="bk-destination">Destination</label><input id="bk-destination" name="destination" required maxlength="200" /></div>
      <div class="field"><label for="bk-date">Date</label><input id="bk-date" name="date" type="date" required /></div>
      <div class="field"><label for="bk-time">Pickup time</label><input id="bk-time" name="time" type="time" required /></div>
      <div class="field"><label for="bk-category">Vehicle category</label>
        <select id="bk-category" name="vehicle_category">${CATEGORIES.map(
          (category) => `<option value="${esc(category)}">${esc(category)}</option>`
        ).join('')}</select></div>
    </div>
    <div class="field"><label for="bk-requirements">Passenger / service requirements</label>
      <input id="bk-requirements" name="requirements" maxlength="1000" placeholder="Passengers, luggage, accessibility…" /></div>
    <div class="field"><label for="bk-details">Additional instructions</label>
      <textarea id="bk-details" name="details" rows="3" maxlength="2000"></textarea></div>
    <button class="btn btn-navy" type="submit">Send booking to drivers</button>
  </form>`;

  const html = panelShell({
    title: 'Book a Car',
    subtitle: 'Create a booking, compare driver offers and confirm your driver.',
    tabs,
    path: '/business/bookings',
    body: `${stageStrip()}
      ${form}
      <h2 style="margin-top:24px">My bookings</h2>
      ${bookings.length ? bookings.map(businessCard).join('') : '<div class="empty">No bookings yet.</div>'}`
  });

  return {
    title: 'Book a Car',
    html,
    mount: () => {
      const formEl = document.getElementById('booking-form');
      formEl?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(formEl).entries());
        const button = formEl.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          const result = await api.post('/bookings', data);
          toast(`Booking sent to ${result.notified_drivers || 0} driver(s).`);
          ctx.refresh();
        } catch (error) {
          toast(error.message, true);
          button.disabled = false;
        }
      });

      for (const button of document.querySelectorAll('[data-select]')) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.post(`/bookings/${button.dataset.booking}/select`, { offer_id: button.dataset.select });
            toast('Driver selected. Waiting for acceptance.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }

      for (const button of document.querySelectorAll('[data-cancel]')) {
        button.addEventListener('click', async () => {
          try {
            await api.post(`/bookings/${button.dataset.cancel}/cancel`, {});
            toast('Booking cancelled.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
          }
        });
      }

      for (const payForm of document.querySelectorAll('[data-pay-form]')) {
        payForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(payForm).entries());
          const submit = payForm.querySelector('button[type=submit]');
          submit.disabled = true;
          try {
            await api.post(`/bookings/${payForm.dataset.payForm}/payment`, data);
            toast('Payment recorded.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            submit.disabled = false;
          }
        });
      }

      for (const button of document.querySelectorAll('[data-finalize]')) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.post(`/bookings/${button.dataset.finalize}/finalize`, {});
            toast('Booking completed.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }
    }
  };
}

/* ------------------------------------------------------------------- driver */

/**
 * The five driver actions, in the only order the server accepts them. Choosing
 * a driver confirms the booking, so the first action is pickup — there is no
 * separate acceptance step.
 */
const DRIVER_ACTIONS = [
  { key: 'accept', label: 'Confirm Booking', from: 'selected' },
  { key: 'pickup', label: 'Pick Up Customer', from: 'confirmed' },
  { key: 'dropoff', label: 'Drop-off Customer', from: 'pickup' },
  { key: 'complete-order', label: 'Order Completed', from: 'dropoff' },
  { key: 'payment', label: 'Receive Payment', from: 'complete_order' },
  { key: 'finalize', label: 'Booking Completed', from: 'paid' }
];

/**
 * Driver-only action row. All six buttons are visible so the driver sees the
 * whole sequence, but only the stage the booking has actually reached can be
 * clicked. The server re-checks every transition, so a forced click cannot
 * skip a step.
 */
function driverStageActions(booking) {
  const id = esc(booking.id);
  if (booking.status === 'cancelled') {
    return '<p class="muted" style="margin:0">This booking was cancelled.</p>';
  }
  if (booking.status === 'completed') return '<span class="tag">Booking completed</span>';
  // The booking waits at 'selected' until this driver confirms it, then follows
  // the stage order the server enforces.
  const stage = booking.status;
  const current = DRIVER_ACTIONS.findIndex((action) => action.from === stage);
  return `<div class="btn-row driver-actions">${DRIVER_ACTIONS.map((action, index) => {
    if (current > -1 && index < current) {
      return `<span class="tag tag-done">✓ ${esc(action.label)}</span>`;
    }
    const active = index === current;
    return `<button type="button" class="btn ${active ? 'btn-navy' : 'btn-ghost'} btn-sm" data-stage="${esc(
      action.key
    )}" data-booking="${id}"${active ? '' : ' disabled'}>${esc(action.label)}</button>`;
  }).join('')}</div>`;
}

/** The driver's own card: confirmed banner plus every detail of the ride. */
const CONFIRMED_STATES = [
  'selected',
  'confirmed',
  'pickup',
  'dropoff',
  'complete_order',
  'paid',
  'completed'
];

function driverCard(booking) {
  const confirmed = CONFIRMED_STATES.includes(booking.status);
  return `<article class="card booking-card">
    <header class="booking-head"><div><h3>${route(booking)}</h3>${meta(booking)}</div><div>${badge(
      booking.status
    )}</div></header>
    ${
      confirmed
        ? `<div class="notice"><strong>Your Booking Is Confirmed!</strong>
            <div>${esc(booking.customer_name || 'The customer')} chose you${
            booking.selected_vehicle ? ` — ${esc(booking.selected_vehicle)}` : ''
          } for ${esc(booking.vehicle_category)} on ${esc(booking.date)} at ${esc(
            booking.time
          )}. ${booking.status === 'selected' ? 'Tap Confirm Booking to accept this ride.' : 'This booking is assigned to you.'}</div></div>`
        : ''
    }
    <ul class="money-list">
      <li><span>Pickup</span><b>${esc(booking.pickup)}</b></li>
      <li><span>Destination</span><b>${esc(booking.destination)}</b></li>
      <li><span>Date &amp; time</span><b>${esc(booking.date)} · ${esc(booking.time)}</b></li>
      <li><span>Vehicle category</span><b>${esc(booking.vehicle_category)}</b></li>
      ${
        booking.selected_vehicle
          ? `<li><span>Vehicle name</span><b>${esc(booking.selected_vehicle)}</b></li>`
          : ''
      }
      ${
        booking.selected_price
          ? `<li><span>Agreed price</span><b>${amount(booking.selected_price, booking.currency)}</b></li>`
          : ''
      }
    </ul>
    ${booking.details ? `<p class="muted">${esc(booking.details)}</p>` : ''}
    ${booking.requirements ? `<p class="muted">Requirements: ${esc(booking.requirements)}</p>` : ''}
    ${contactOf(booking, 'driver')}
    ${driverStageActions(booking)}
    ${paymentBlock(booking, { finalizeButton: false })}
  </article>`;
}

function offerForm(booking) {
  const mine = offersOf(booking).find((offer) => offer.driver_id);
  return `<form class="card card-flat" data-offer-form="${esc(booking.id)}">
    <h4>Your offer</h4>
    <div class="grid-2">
      <div class="field"><label>Vehicle name</label>
        <input name="vehicle_name" maxlength="120" placeholder="GMC Yukon, Ford Taurus, Toyota Fortuner…" value="${esc(
          mine?.vehicle_name || ''
        )}" required /></div>
      <div class="field"><label>Your price (${esc(booking.currency)})</label>
        <input name="price" type="number" min="0" step="0.01" value="${esc(mine?.price || '')}" required /></div>
    </div>
    <button class="btn btn-navy btn-sm" type="submit">${mine ? 'Update offer' : 'Send offer'}</button>
  </form>`;
}

export async function driverBookingsView(ctx) {
  const [available, mine] = await Promise.all([
    api.get('/bookings/available'),
    api.get('/bookings/driver/mine')
  ]);
  const tabs = [
    ['#/worker', 'Dashboard'],
    ['#/worker/bookings', 'Bookings'],
    ['#/worker/jobs', 'Find Work'],
    ['#/worker/profile', 'Profile']
  ];

  const availableHtml = available.bookings.length
    ? available.bookings
        .map(
          (booking) => `<article class="card booking-card">
            <header class="booking-head"><div><h3>${route(booking)}</h3>${meta(booking)}</div><div>${badge(
              booking.status
            )}</div></header>
            ${booking.details ? `<p class="muted">${esc(booking.details)}</p>` : ''}
            ${booking.requirements ? `<p class="muted">Requirements: ${esc(booking.requirements)}</p>` : ''}
            ${offerForm(booking)}
          </article>`
        )
        .join('')
    : '<div class="empty">No open bookings for your approved categories right now.</div>';

  const mineHtml = mine.bookings.length
    ? mine.bookings.map((booking) => driverCard(booking)).join('')
    : '<div class="empty">You have no bookings yet.</div>';

  return {
    title: 'Bookings',
    html: panelShell({
      title: 'Bookings',
      subtitle: 'Offer your price on open requests and manage your assigned rides.',
      tabs,
      path: '/worker/bookings',
      body: `<h2>Open booking requests</h2>${availableHtml}
        <h2 style="margin-top:24px">My bookings</h2>${mineHtml}`
    }),
    mount: () => {
      for (const offerFormEl of document.querySelectorAll('[data-offer-form]')) {
        offerFormEl.addEventListener('submit', async (event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(offerFormEl).entries());
          const submit = offerFormEl.querySelector('button[type=submit]');
          submit.disabled = true;
          try {
            await api.post(`/bookings/${offerFormEl.dataset.offerForm}/offers`, data);
            toast('Offer sent to the business.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            submit.disabled = false;
          }
        });
      }

      // A public "Book Your Car" booking has no business account, so its chosen
      // driver records the fare received and then completes the booking.
      for (const payForm of document.querySelectorAll('[data-pay-form]')) {
        payForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const payload = Object.fromEntries(new FormData(payForm).entries());
          const submit = payForm.querySelector('button[type=submit]');
          submit.disabled = true;
          try {
            await api.post(`/bookings/${payForm.dataset.payForm}/payment`, payload);
            toast('Payment recorded.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            submit.disabled = false;
          }
        });
      }

      for (const button of document.querySelectorAll('[data-finalize]')) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.post(`/bookings/${button.dataset.finalize}/finalize`, {});
            toast('Booking completed.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }

      for (const button of document.querySelectorAll('[data-stage]')) {
        button.addEventListener('click', async () => {
          const stage = button.dataset.stage;
          const bookingId = button.dataset.booking;
          // "Receive Payment" opens the payment form: the driver records the
          // amount actually collected, and the booking reaches 'paid'.
          if (stage === 'payment') {
            const form = document.querySelector(`[data-pay-form="${bookingId}"]`);
            const amountInput = form?.querySelector('input[name=amount]');
            form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            amountInput?.focus();
            amountInput?.select?.();
            toast('Enter the amount you received to finish the booking.');
            return;
          }
          button.disabled = true;
          try {
            await api.post(`/bookings/${bookingId}/${stage}`, {});
            toast(stage === 'finalize' ? 'Booking completed.' : 'Booking updated.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }
    }
  };
}

/* -------------------------------------------------------------------- admin */

function driverRow(driver) {
  return `<tr>
    <td><b>${esc(driver.full_name)}</b><div class="muted">${esc(driver.phone || '')}</div></td>
    <td>${esc(driver.city || driver.country || '—')}</td>
    <td>${esc(driver.vehicle_name || '—')}</td>
    <td><label class="check"><input type="checkbox" data-approve="${esc(driver.id)}" ${
      driver.booking_approved ? 'checked' : ''
    } /> Bookings</label></td>
    <td>${CATEGORIES.map(
      (category) =>
        `<label class="check"><input type="checkbox" data-cat="${esc(category)}" data-driver="${esc(driver.id)}" ${
          (driver.vehicle_categories || []).includes(category) ? 'checked' : ''
        } /> ${esc(category)}</label>`
    ).join('')}</td>
    <td><button class="btn btn-sm btn-navy" data-save-driver="${esc(driver.id)}">Save</button></td>
  </tr>`;
}

export async function adminDriversView(ctx) {
  const { drivers } = await api.get('/admin/drivers');
  const tabs = [
    ['#/admin', 'Overview'],
    ['#/admin/users', 'Users'],
    ['#/admin/drivers', 'Drivers'],
    ['#/admin/bookings', 'Bookings'],
    ['#/admin/settings', 'Settings']
  ];
  return {
    title: 'Drivers',
    html: panelShell({
      title: 'Driver booking approval',
      subtitle: 'Approve drivers for bookings and choose their vehicle categories.',
      tabs,
      path: '/admin/drivers',
      body: drivers.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Driver</th><th>Area</th><th>Vehicle</th><th>Approved</th><th>Categories</th><th></th></tr></thead>
            <tbody>${drivers.map(driverRow).join('')}</tbody>
          </table></div>`
        : '<div class="empty">No drivers in your assigned area.</div>'
    }),
    mount: () => {
      for (const button of document.querySelectorAll('[data-save-driver]')) {
        button.addEventListener('click', async () => {
          const id = button.dataset.saveDriver;
          const approved = document.querySelector(`[data-approve="${id}"]`)?.checked === true;
          const categories = [...document.querySelectorAll(`[data-driver="${id}"]`)]
            .filter((input) => input.checked)
            .map((input) => input.dataset.cat);
          button.disabled = true;
          try {
            await api.patch(`/admin/drivers/${id}/booking`, {
              booking_approved: approved,
              vehicle_categories: categories
            });
            toast('Driver booking approval saved.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }
    }
  };
}

export async function adminBookingsView(ctx) {
  const [bookings, payments] = await Promise.all([api.get('/admin/bookings'), api.get('/admin/payments')]);
  const tabs = [
    ['#/admin', 'Overview'],
    ['#/admin/users', 'Users'],
    ['#/admin/drivers', 'Drivers'],
    ['#/admin/bookings', 'Bookings'],
    ['#/admin/settings', 'Settings']
  ];
  const bookingRows = bookings.bookings.length
    ? bookings.bookings
        .map(
          (booking) => `<tr>
            <td>${esc(booking.ref || booking.id.slice(0, 8))}</td>
            <td>${esc(booking.business_name || '')}</td>
            <td>${route(booking)}</td>
            <td>${esc(booking.date)}</td>
            <td>${esc(booking.vehicle_category)}</td>
            <td>${badge(booking.status)}</td>
            <td>${booking.payment ? amount(booking.payment.amount, booking.payment.currency) : '—'}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No bookings in your area.</td></tr>';

  const paymentRows = payments.payments.length
    ? payments.payments
        .map(
          (payment) => `<tr>
            <td>${esc(payment.ref)}</td>
            <td>${esc(fmtDate(payment.date))}</td>
            <td>${esc(payment.business_name)}</td>
            <td>${amount(payment.amount, payment.currency)}</td>
            <td>${Number(payment.rate) || 0}%</td>
            <td>${amount(payment.commission_amount, payment.currency)}</td>
            <td>${esc(payment.reference)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No payments recorded yet.</td></tr>';

  return {
    title: 'Bookings',
    html: panelShell({
      title: 'Bookings & payments',
      subtitle: 'Only bookings inside your assigned area are shown.',
      tabs,
      path: '/admin/bookings',
      body: `<h2>Bookings</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Ref</th><th>Business</th><th>Route</th><th>Date</th><th>Category</th><th>Status</th><th>Amount</th></tr></thead>
          <tbody>${bookingRows}</tbody></table></div>
        <h2 style="margin-top:24px">Payment records</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Ref</th><th>Date</th><th>Business</th><th>Total</th><th>Rate</th><th>Commission</th><th>Transaction</th></tr></thead>
          <tbody>${paymentRows}</tbody></table></div>`
    })
  };
}

/* -------------------------------------------------------------------- owner */

export async function ownerPlatformView(ctx) {
  const [platform, admins] = await Promise.all([
    api.get('/owner/platform'),
    api.get('/owner/admins/list').catch(() => ({ admins: [] }))
  ]);
  const tabs = [
    ['#/owner', 'Applications'],
    ['#/owner/admins', 'Admins'],
    ['#/owner/platform', 'Platform'],
    ['#/admin', 'Primary Admin']
  ];

  const moneyRows = platform.money.length
    ? platform.money
        .map(
          (row) => `<tr>
            <td>${esc(row.currency)}</td>
            <td>${row.bookings}</td>
            <td>${amount(row.gross, row.currency)}</td>
            <td>${amount(row.commission, row.currency)}</td>
            <td>${amount(row.payable, row.currency)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No paid bookings yet.</td></tr>';

  const paymentRows = platform.recent_payments.length
    ? platform.recent_payments
        .map(
          (payment) => `<tr>
            <td>${esc(payment.ref)}</td>
            <td>${esc(fmtDate(payment.date))}</td>
            <td>${esc(payment.business_name || '')}</td>
            <td>${amount(payment.amount, payment.currency)}</td>
            <td>${Number(payment.rate) || 0}%</td>
            <td>${amount(payment.commission_amount, payment.currency)}</td>
            <td>${esc(payment.reference)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No payments yet.</td></tr>';

  const adminRows = admins.admins.length
    ? admins.admins
        .map(
          (admin) => `<tr>
            <td><b>${esc(admin.full_name)}</b><div class="muted">${esc(admin.email)}</div></td>
            <td>${esc(admin.status)}</td>
            <td>${esc(admin.admin_scope?.label || admin.admin_scope?.level || '—')}</td>
            <td>
              <select data-scope-level="${esc(admin.id)}">
                <option value="global"${admin.admin_scope?.level === 'global' ? ' selected' : ''}>Worldwide</option>
                <option value="country"${admin.admin_scope?.level === 'country' ? ' selected' : ''}>Country</option>
                <option value="region"${admin.admin_scope?.level === 'region' ? ' selected' : ''}>Region / city</option>
              </select>
            </td>
            <td><input data-scope-country="${esc(admin.id)}" placeholder="Country" value="${esc(
              admin.admin_scope?.country || ''
            )}" /></td>
            <td><input data-scope-city="${esc(admin.id)}" placeholder="City" value="${esc(
              admin.admin_scope?.city || ''
            )}" /></td>
            <td><button class="btn btn-sm btn-navy" data-save-admin="${esc(admin.id)}">Save</button>
              <button class="btn btn-sm btn-ghost" data-toggle-admin="${esc(admin.id)}" data-status="${esc(
                admin.status
              )}">${admin.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No admins yet.</td></tr>';

  const createForm = `<form class="card" id="admin-create">
    <h3>Create an admin</h3>
    <div class="grid-2">
      <div class="field"><label>Full name</label><input name="full_name" required maxlength="120" /></div>
      <div class="field"><label>Email</label><input name="email" type="email" required maxlength="160" /></div>
      <div class="field"><label>Phone</label><input name="phone" maxlength="40" /></div>
      <div class="field"><label>Temporary password</label><input name="password" type="password" minlength="10" required /></div>
      <div class="field"><label>Access level</label>
        <select name="level"><option value="global">Worldwide</option><option value="country">Country</option><option value="region">Region / city</option></select></div>
      <div class="field"><label>Country</label><input name="country" maxlength="80" /></div>
      <div class="field"><label>City / region</label><input name="city" maxlength="80" /></div>
    </div>
    <button class="btn btn-navy" type="submit">Create admin</button>
  </form>`;

  return {
    title: 'Platform',
    html: panelShell({
      title: 'Platform control',
      subtitle: 'Private owner view. Admins and businesses never see this panel.',
      tabs,
      path: '/owner/platform',
      body: `${statCards([
        ['Admins', platform.accounts.admins],
        ['Businesses', platform.accounts.businesses],
        ['Drivers', platform.accounts.drivers],
        ['Bookings', platform.bookings.total]
      ])}
      <div class="card">
        <h3>Commission</h3>
        <p class="muted">Current setting: <b>${Number(platform.commission_setting.rate) || 0}%</b> · paid by ${esc(
          platform.commission_setting.payer || 'business'
        )}</p>
        <a class="btn btn-ghost btn-sm" href="#/admin/commission">Change commission</a>
      </div>
      <h2>Commission by currency</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Currency</th><th>Paid bookings</th><th>Gross</th><th>Commission</th><th>Payable</th></tr></thead>
        <tbody>${moneyRows}</tbody></table></div>
      <h2 style="margin-top:24px">Recent payments</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Ref</th><th>Date</th><th>Business</th><th>Total</th><th>Rate</th><th>Commission</th><th>Transaction</th></tr></thead>
        <tbody>${paymentRows}</tbody></table></div>
      <h2 style="margin-top:24px">Administrators</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Admin</th><th>Status</th><th>Current scope</th><th>Level</th><th>Country</th><th>City</th><th></th></tr></thead>
        <tbody>${adminRows}</tbody></table></div>
      <div style="margin-top:16px">${createForm}</div>`
    }),
    mount: () => {
      const create = document.getElementById('admin-create');
      create?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(create).entries());
        const submit = create.querySelector('button[type=submit]');
        submit.disabled = true;
        try {
          await api.post('/owner/admins/create', {
            full_name: data.full_name,
            email: data.email,
            phone: data.phone,
            password: data.password,
            scope: { level: data.level, country: data.country, city: data.city }
          });
          toast('Admin created.');
          ctx.refresh();
        } catch (error) {
          toast(error.message, true);
          submit.disabled = false;
        }
      });

      for (const button of document.querySelectorAll('[data-save-admin]')) {
        button.addEventListener('click', async () => {
          const id = button.dataset.saveAdmin;
          const level = document.querySelector(`[data-scope-level="${id}"]`)?.value || 'global';
          const country = document.querySelector(`[data-scope-country="${id}"]`)?.value || '';
          const city = document.querySelector(`[data-scope-city="${id}"]`)?.value || '';
          button.disabled = true;
          try {
            await api.patch(`/owner/admins/${id}/access`, { scope: { level, country, city } });
            toast('Admin permissions updated.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }

      for (const button of document.querySelectorAll('[data-toggle-admin]')) {
        button.addEventListener('click', async () => {
          const next = button.dataset.status === 'suspended' ? 'active' : 'suspended';
          button.disabled = true;
          try {
            await api.patch(`/owner/admins/${button.dataset.toggleAdmin}/access`, { status: next });
            toast(next === 'active' ? 'Admin reactivated.' : 'Admin suspended.');
            ctx.refresh();
          } catch (error) {
            toast(error.message, true);
            button.disabled = false;
          }
        });
      }
    }
  };
}
