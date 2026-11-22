/**
 * BOOK YOUR CAR — public booking page plus the worker-side booking list.
 *
 * The page stays deliberately simple: pick one of four categories, write the
 * booking details in a single box, press Send Booking. No account is needed to
 * book, and only workers the admin enabled ever receive the requests.
 */
import { api } from '../api.js';
import { esc, toast, busy, fmtDateTime } from '../ui.js';

const CATEGORIES = [
  { key: 'Small Car', note: 'Economy rides for one or two passengers.' },
  { key: 'Go', note: 'Quick everyday city rides.' },
  { key: 'Business', note: 'Comfortable sedan for business travel.' },
  { key: 'VIP', note: 'Premium vehicle with a professional driver.' }
];

export function bookCarView() {
  return {
    title: 'Book Your Car',
    html: `<div class="container">
      <div class="section-head">
        <div>
          <h1>BOOK YOUR CAR</h1>
          <p class="muted" style="margin:0">Choose a vehicle category, write your details and send the booking. Ride bookings are separate from regular work requests.</p>
        </div>
      </div>
      <div class="grid">
        ${CATEGORIES.map(
          (car) => `<article class="card">
            <h3>${esc(car.key)}</h3>
            <p class="muted" style="margin:0 0 10px">${esc(car.note)}</p>
            <button type="button" class="btn btn-navy btn-sm" data-category="${esc(car.key)}">Book ${esc(car.key)}</button>
          </article>`
        ).join('')}
      </div>

      <form id="ride-form" class="card" hidden style="margin-top:16px">
        <h3 style="margin-top:0">Booking details — <span id="ride-chosen"></span></h3>
        <input type="hidden" id="ride-category" name="category" value="" />
        <div class="split">
          <div class="field"><label for="ride-name">Your name</label><input id="ride-name" name="customer_name" autocomplete="name" /></div>
          <div class="field"><label for="ride-phone">Phone number</label><input id="ride-phone" name="customer_phone" inputmode="tel" autocomplete="tel" /></div>
        </div>
        <div class="field"><label for="ride-pickup">Pickup place (optional)</label><input id="ride-pickup" name="pickup" /></div>
        <div class="field">
          <label for="ride-details">Write your booking details</label>
          <textarea id="ride-details" name="details" rows="4" required placeholder="Date, time, pickup and drop-off, number of passengers, any notes."></textarea>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-navy">Send Booking</button>
          <button type="button" class="btn btn-ghost" id="ride-cancel">Cancel</button>
        </div>
        <p class="muted" style="margin:8px 0 0">Only approved ride-booking workers can see your request.</p>
      </form>

      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">Are you a driver?</h3>
        <p class="muted">Ride bookings are switched on per worker by the administrator. If you want to receive them, contact the admin from your worker profile.</p>
        <a class="btn btn-ghost btn-sm" href="#/worker">Open worker panel</a>
      </div>
    </div>`,
    mount() {
      const form = document.getElementById('ride-form');
      const category = document.getElementById('ride-category');
      const chosen = document.getElementById('ride-chosen');
      const cancel = document.getElementById('ride-cancel');
      if (!form) return;

      for (const button of document.querySelectorAll('[data-category]')) {
        button.addEventListener('click', () => {
          category.value = button.dataset.category;
          chosen.textContent = button.dataset.category;
          form.hidden = false;
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      cancel.addEventListener('click', () => {
        form.hidden = true;
        category.value = '';
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        busy(submit, true, 'Sending…');
        try {
          const result = await api.post('/ride-bookings', {
            category: category.value,
            details: form.details.value.trim(),
            customer_name: form.customer_name.value.trim(),
            customer_phone: form.customer_phone.value.trim(),
            pickup: form.pickup.value.trim()
          });
          toast(`Booking sent. Reference ${result.booking.ref}`, 'ok');
          form.reset();
          form.hidden = true;
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(submit, false);
        }
      });
    }
  };
}

/** Worker panel: only enabled workers get a list; everyone else sees why. */
export async function workerRideView(ctx) {
  let payload = { bookings: [], enabled: true };
  let denied = '';
  try {
    payload = await api.get('/ride-bookings');
  } catch (error) {
    if (error.status === 403) denied = error.message;
    else throw error;
  }

  if (denied) {
    return {
      title: 'Ride Booking',
      html: `<div class="container">
        <div class="section-head"><div><h1>Ride Booking</h1><p class="muted" style="margin:0">Separate from regular work requests.</p></div></div>
        <div class="notice notice-danger">${esc(denied)}</div>
        <p><a class="btn btn-ghost btn-sm" href="#/worker">Back to dashboard</a></p>
      </div>`
    };
  }

  const open = payload.bookings.filter((b) => b.status === 'open');
  const mine = payload.bookings.filter((b) => b.status !== 'open');

  return {
    title: 'Ride Booking',
    html: `<div class="container">
      <div class="section-head">
        <div><h1>Ride Booking</h1><p class="muted" style="margin:0">New vehicle bookings from customers. Regular work requests are unaffected.</p></div>
        <div class="pill ok">Ride Booking ON</div>
      </div>
      <h2 style="font-size:1.05rem">Available bookings</h2>
      ${
        open.length
          ? open
              .map(
                (booking) => `<article class="card" style="margin-bottom:10px">
                  <header style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
                    <div>
                      <h3 style="margin:0">${esc(booking.category)}</h3>
                      <p class="muted" style="margin:4px 0 0">${esc(booking.ref)} · ${esc(fmtDateTime(booking.created_at))}</p>
                    </div>
                    <span class="tag">Open</span>
                  </header>
                  <p style="margin:10px 0">${esc(booking.details)}</p>
                  ${booking.pickup ? `<p class="muted" style="margin:0 0 8px">Pickup: ${esc(booking.pickup)}</p>` : ''}
                  <div class="btn-row">
                    <button type="button" class="btn btn-navy btn-sm" data-claim="${esc(booking.id)}">Accept booking</button>
                    ${
                      booking.customer_phone
                        ? `<a class="btn btn-ghost btn-sm" href="tel:${esc(booking.customer_phone)}">Call customer</a>`
                        : ''
                    }
                  </div>
                </article>`
              )
              .join('')
          : `<div class="empty">No open ride bookings right now.</div>`
      }
      <h2 style="font-size:1.05rem;margin-top:18px">My bookings</h2>
      ${
        mine.length
          ? mine
              .map(
                (booking) => `<article class="card" style="margin-bottom:10px">
                  <header style="display:flex;justify-content:space-between;gap:10px">
                    <strong>${esc(booking.category)} · ${esc(booking.ref)}</strong>
                    <span class="pill">${esc(booking.status)}</span>
                  </header>
                  <p class="muted" style="margin:8px 0">${esc(booking.details)}</p>
                  ${
                    booking.status === 'claimed'
                      ? `<button type="button" class="btn btn-ghost btn-sm" data-complete="${esc(booking.id)}">Mark completed</button>`
                      : ''
                  }
                </article>`
              )
              .join('')
          : `<div class="empty">You have no accepted bookings yet.</div>`
      }
    </div>`,
    mount() {
      for (const button of document.querySelectorAll('[data-claim]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Accepting…');
          try {
            await api.post(`/ride-bookings/${button.dataset.claim}/claim`);
            toast('Booking accepted.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
      for (const button of document.querySelectorAll('[data-complete]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/ride-bookings/${button.dataset.complete}`, { status: 'completed' });
            toast('Booking completed.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
    }
  };
}
