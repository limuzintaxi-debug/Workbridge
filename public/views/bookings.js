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
const amount = (value, currency) => money(Number(value) || 0, currency || '');

function progress(status) {
  const at = STEP_ORDER.indexOf(status);
  if (status === 'cancelled') return `<p class="muted">This booking was cancelled.</p>`;
  return `<ol class="stage-list">${STEP_ORDER.map((step, index) => {
    const state = index < at ? 'done' : index === at ? 'now' : 'todo';
    return `<li class="stage-${state}">${esc(STATUS_LABEL[step])}</li>`;
  }).join('')}</ol>`;
}

/** Contact details only exist in the payload once the driver has accepted. */
function contactOf(booking) {
  const contact = booking.contact || {};
  const phone = contact.phone || booking.contact_phone || '';
  const whatsapp = contact.whatsapp || contact.phone || phone;
  if (!phone) return '';
  const digits = String(whatsapp).replace(/[^\d]/g, '');
  return `<div class="contact-box">
    <strong>${esc(contact.name || 'Contact')}</strong>
    <div><a href="tel:${esc(phone)}">${esc(phone)}</a></div>
    ${digits ? `<div><a href="https://wa.me/${esc(digits)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ''}
  </div>`;
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
  if (!offers.length) return `<p class="muted">No driver offers yet. Eligible drivers were notified.</p>`;
  const open = ['created', 'offers'].includes(booking.status);
  return `<div class="offer-list">
    <div class="offer-head"><span>Driver vehicle</span><span>Category</span><span>Offer</span><span></span></div>
    ${offers
      .map(
        (offer, index) => `<div class="offer-row">
          <span>${esc(offer.vehicle_name)}${index === 0 ? ' <span class="tag">lowest</span>' : ''}</span>
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
  <p class="muted" style="margin:6px 0 0">Only the four lowest valid offers are shown. You choose the driver.</p>`;
}

function paymentBlock(booking) {
  if (booking.payment) {
    const pay = booking.payment;
    return `<div class="card card-flat">
      <h4>Payment recorded</h4>
      <p class="muted" style="margin:4px 0">Reference ${esc(pay.reference)} · ${esc(pay.method || '')}</p>
      <ul class="money-list">
        <li><span>Total received</span><b>${amount(pay.amount, pay.currency)}</b></li>
        <li><span>Platform commission (${Number(pay.commission_rate) || 0}%)</span><b>${amount(
          pay.commission_amount,
          pay.currency
        )}</b></li>
        <li><span>Payable to driver</span><b>${amount(pay.payable_amount, pay.currency)}</b></li>
      </ul>
      ${
        booking.status === 'paid'
          ? `<button class="btn btn-navy btn-sm" data-finalize="${esc(booking.id)}">Complete booking</button>`
          : `<span class="tag">Booking completed</span>`
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
    ${['created', 'offers'].includes(booking.status) ? offersTable(booking) : ''}
    ${
      booking.status === 'selected'
        ? `<p class="notice">Waiting for the selected driver to accept. Contact details appear after acceptance.</p>`
        : ''
    }
    ${contactOf(booking)}
    ${progress(booking.status)}
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
    body: `${form}
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

function driverStageActions(booking) {
  const id = esc(booking.id);
  if (booking.status === 'selected') {
    return `<button class="btn btn-navy btn-sm" data-stage="accept" data-booking="${id}">Accept assignment</button>`;
  }
  if (booking.status === 'confirmed') {
    return `<button class="btn btn-navy btn-sm" data-stage="pickup" data-booking="${id}">Confirm pickup</button>`;
  }
  if (booking.status === 'pickup') {
    return `<button class="btn btn-navy btn-sm" data-stage="dropoff" data-booking="${id}">Confirm drop-off</button>`;
  }
  if (booking.status === 'dropoff') {
    return `<button class="btn btn-navy btn-sm" data-stage="complete-order" data-booking="${id}">Complete order</button>`;
  }
  if (booking.status === 'complete_order') {
    return `<span class="tag">Waiting for the business to record payment</span>`;
  }
  return '';
}

function offerForm(booking) {
  const mine = offersOf(booking).find((offer) => offer.driver_id);
  return `<form class="card card-flat" data-offer-form="${esc(booking.id)}">
    <h4>Your offer</h4>
    <div class="grid-2">
      <div class="field"><label>Vehicle name / model</label>
        <input name="vehicle_name" maxlength="120" value="${esc(mine?.vehicle_name || '')}" required /></div>
      <div class="field"><label>Vehicle category</label>
        <select name="vehicle_category">
          <option value="${esc(booking.vehicle_category)}">${esc(booking.vehicle_category)}</option>
        </select></div>
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
    ? mine.bookings
        .map(
          (booking) => `<article class="card booking-card">
            <header class="booking-head"><div><h3>${route(booking)}</h3>${meta(booking)}</div><div>${badge(
              booking.status
            )}</div></header>
            ${booking.selected_price ? `<p><b>Agreed price:</b> ${amount(booking.selected_price, booking.currency)}</p>` : ''}
            ${contactOf(booking)}
            ${progress(booking.status)}
            <div class="btn-row">${driverStageActions(booking)}</div>
          </article>`
        )
        .join('')
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

      for (const button of document.querySelectorAll('[data-stage]')) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await api.post(`/bookings/${button.dataset.booking}/${button.dataset.stage}`, {});
            toast('Booking updated.');
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
