/**
 * Extra Primary Admin screens: ride-booking control and Mall moderation.
 *
 * `shell` is passed in from admin.js so these screens reuse the exact same
 * panel chrome and tab bar instead of duplicating the layout.
 */
import { api } from '../api.js';
import { esc, toast, busy, fmtDateTime } from '../ui.js';

export async function rideBookingAdmin(ctx, shell) {
  const { enabled, scope, workers } = await api.get('/ride-booking/settings');
  let bookings = [];
  try {
    bookings = (await api.get('/ride-bookings')).bookings || [];
  } catch {
    bookings = [];
  }
  const eligible = workers.filter((worker) => worker.ride_booking_enabled);
  const open = bookings.filter((booking) => booking.status === 'open');

  const body = `
    <div class="card">
      <div class="section-head">
        <div>
          <h3 style="margin:0">Ride booking — platform switch</h3>
          <p class="muted" style="margin:4px 0 0">Your access: ${esc(scope.label)}. Regular work requests are not affected by this switch.</p>
        </div>
        <div class="pill ${enabled ? 'ok' : ''}">${enabled ? 'ON' : 'OFF'}</div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn ${enabled ? 'btn-ghost' : 'btn-navy'} btn-sm" data-global="${enabled ? 'off' : 'on'}">
          ${enabled ? 'Turn ride booking OFF' : 'Turn ride booking ON'}
        </button>
      </div>
      <p class="muted" style="margin:8px 0 0">When this is OFF no new ride bookings are distributed, even to enabled workers.</p>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Open bookings (${open.length})</h3>
      ${
        open.length
          ? open
              .map(
                (booking) => `<div style="padding:10px 0;border-bottom:1px solid #eee">
                  <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                    <strong>${esc(booking.category)} · ${esc(booking.ref)}</strong>
                    <span class="muted">${esc(fmtDateTime(booking.created_at))}</span>
                  </div>
                  <p class="muted" style="margin:4px 0 0">${esc(booking.details)}</p>
                </div>`
              )
              .join('')
          : `<p class="muted" style="margin:0">No open ride bookings.</p>`
      }
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Workers allowed to receive ride bookings (${eligible.length})</h3>
      <p class="muted">Only the workers you enable here can see and accept vehicle bookings. Ordinary workers never receive them.</p>
      ${
        workers.length
          ? workers
              .map(
                (worker) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap">
                  <div>
                    <strong>${esc(worker.full_name)}</strong>
                    <p class="muted" style="margin:2px 0 0">${esc(worker.phone || worker.email)}${worker.country ? ` · ${esc(worker.country)}` : ''}</p>
                  </div>
                  <button type="button" class="btn ${worker.ride_booking_enabled ? 'btn-ghost' : 'btn-navy'} btn-sm"
                    data-worker="${esc(worker.id)}" data-enable="${worker.ride_booking_enabled ? 'off' : 'on'}">
                    ${worker.ride_booking_enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>`
              )
              .join('')
          : `<p class="muted" style="margin:0">No workers in your scope yet.</p>`
      }
    </div>`;

  return {
    title: 'Ride Booking',
    html: shell('/admin/ride-booking', 'Ride Booking', 'Control which workers receive vehicle bookings.', body),
    mount() {
      for (const button of document.querySelectorAll('[data-global]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch('/ride-booking/settings', { enabled: button.dataset.global === 'on' });
            toast('Ride booking switch updated.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
      for (const button of document.querySelectorAll('[data-worker]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/ride-booking/workers/${button.dataset.worker}`, {
              enabled: button.dataset.enable === 'on'
            });
            toast('Worker updated.', 'ok');
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

export async function mallAdmin(ctx, shell) {
  const [{ vehicles }, { shops }] = await Promise.all([
    api.get('/mall/vehicles'),
    api.get('/mall/shops')
  ]);
  let products = [];
  try {
    products = (await api.get('/mall/products')).products || [];
  } catch {
    products = [];
  }

  const body = `
    <div class="card">
      <h3 style="margin-top:0">Vehicle listings (${vehicles.length})</h3>
      ${
        vehicles.length
          ? vehicles
              .map(
                (vehicle) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap">
                  <div style="max-width:70%">
                    <p style="margin:0">${esc(String(vehicle.description).slice(0, 120))}</p>
                    <p class="muted" style="margin:2px 0 0">${esc(vehicle.contact_phone || 'No phone')}${vehicle.price ? ` · ${esc(String(vehicle.price))} ${esc(vehicle.currency)}` : ''}</p>
                  </div>
                  <button type="button" class="btn btn-ghost btn-sm" data-vehicle="${esc(vehicle.id)}">Remove</button>
                </div>`
              )
              .join('')
          : `<p class="muted" style="margin:0">No vehicle listings.</p>`
      }
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Electronic shops (${shops.length})</h3>
      ${
        shops.length
          ? shops
              .map(
                (shop) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap">
                  <div>
                    <strong>${esc(shop.name)}</strong>
                    <p class="muted" style="margin:2px 0 0">${esc(shop.phone || 'No phone')} · ${esc(shop.address || 'No address')}</p>
                  </div>
                  <button type="button" class="btn btn-ghost btn-sm" data-shop="${esc(shop.id)}">Remove</button>
                </div>`
              )
              .join('')
          : `<p class="muted" style="margin:0">No shops.</p>`
      }
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Products (${products.length})</h3>
      ${
        products.length
          ? products
              .map(
                (product) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap">
                  <div style="max-width:70%">
                    <p style="margin:0">${esc(String(product.title || product.details).slice(0, 100))}${product.discount ? ' · DISCOUNT' : ''}</p>
                    <p class="muted" style="margin:2px 0 0">${esc(String(product.discounted_price || product.original_price || 0))} ${esc(product.currency || '')}</p>
                  </div>
                  <button type="button" class="btn btn-ghost btn-sm" data-product="${esc(product.id)}">Remove</button>
                </div>`
              )
              .join('')
          : `<p class="muted" style="margin:0">No products.</p>`
      }
    </div>`;

  return {
    title: 'Mall',
    html: shell('/admin/mall', 'WORKBRIDGE MALL', 'Review and remove vehicle listings, shops and products.', body),
    mount() {
      const remove = async (path, button) => {
        busy(button, true, 'Removing…');
        try {
          await api.del(path);
          toast('Removed.', 'ok');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      };
      for (const button of document.querySelectorAll('[data-vehicle]')) {
        button.addEventListener('click', () => remove(`/mall/vehicles/${button.dataset.vehicle}`, button));
      }
      for (const button of document.querySelectorAll('[data-shop]')) {
        button.addEventListener('click', () => remove(`/mall/shops/${button.dataset.shop}`, button));
      }
      for (const button of document.querySelectorAll('[data-product]')) {
        button.addEventListener('click', () => remove(`/mall/products/${button.dataset.product}`, button));
      }
    }
  };
}
