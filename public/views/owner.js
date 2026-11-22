/**
 * OWNER ADMIN PANEL.
 *
 * The owner is the only role that can approve, re-scope or revoke admins.
 * Admins either get global access or a regional scope (country/city), and the
 * server enforces that scope on every admin route.
 */
import { api } from '../api.js';
import { esc, toast, busy } from '../ui.js';
import { panelShell } from './common.js';

const TABS = [
  ['#/owner', 'Applications'],
  ['#/owner/admins', 'Admins']
];

function shell(path, title, subtitle, body) {
  return panelShell({ title, subtitle, tabs: TABS, path, body });
}

function scopeSelect(prefix, scope = {}) {
  const level = scope.level === 'regional' ? 'regional' : 'global';
  return `<div class="field">
      <label for="${prefix}-level">Access</label>
      <select id="${prefix}-level" name="level">
        <option value="global" ${level === 'global' ? 'selected' : ''}>Global access — entire platform</option>
        <option value="regional" ${level === 'regional' ? 'selected' : ''}>Regional access — assigned area only</option>
      </select>
    </div>
    <div class="split">
      <div class="field"><label for="${prefix}-country">Country</label><input id="${prefix}-country" name="country" value="${esc(scope.country || '')}" /></div>
      <div class="field"><label for="${prefix}-city">City / region</label><input id="${prefix}-city" name="city" value="${esc(scope.city || '')}" /></div>
    </div>`;
}

async function applications(ctx) {
  const { admins } = await api.get('/admin-applications');
  const pending = admins.filter((a) => a.status === 'pending');
  const others = admins.filter((a) => a.status !== 'pending');

  const pendingCards = pending.length
    ? pending
        .map(
          (admin) => `<form class="card" data-approve="${esc(admin.id)}" style="margin-bottom:12px">
            <div class="section-head"><div>
              <h3 style="margin:0">${esc(admin.full_name)}</h3>
              <p class="muted" style="margin:4px 0 0">${esc(admin.email)}${admin.phone ? ` · ${esc(admin.phone)}` : ''}</p>
              <p class="muted" style="margin:2px 0 0">${esc(admin.country || '—')}${admin.city ? ` · ${esc(admin.city)}` : ''} · requested ${esc(
                (admin.application && admin.application.requested_scope) || 'regional'
              )} access</p>
            </div></div>
            ${admin.application && admin.application.note ? `<p class="muted">“${esc(admin.application.note)}”</p>` : ''}
            ${scopeSelect(`scope-${admin.id}`, admin.scope)}
            <div class="btn-row">
              <button type="submit" class="btn btn-navy btn-sm">Approve admin</button>
              <button type="button" class="btn btn-ghost btn-sm" data-reject="${esc(admin.id)}">Reject</button>
            </div>
          </form>`
        )
        .join('')
    : `<div class="empty">No admin applications waiting for review.</div>`;

  return {
    title: 'Owner Admin',
    html: shell(
      '#/owner',
      'Owner Admin',
      'Review admin applications and decide who may manage the platform.',
      `<div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0">Signed in as owner</h3>
        <p class="muted" style="margin:0">${esc(ctx.user.full_name)} · ${esc(ctx.user.email)} — full control of the platform, admins and permissions.</p>
      </div>
      <h2 style="font-size:1.05rem">Pending applications (${pending.length})</h2>
      ${pendingCards}
      <h2 style="font-size:1.05rem;margin-top:18px">All admins</h2>
      ${
        others.length
          ? others
              .map(
                (admin) => `<div class="card" style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                    <div>
                      <strong>${esc(admin.full_name)}</strong>
                      <p class="muted" style="margin:2px 0 0">${esc(admin.email)} · ${esc(admin.scope.label)}</p>
                    </div>
                    <span class="pill">${esc(admin.status)}</span>
                  </div>
                </div>`
              )
              .join('')
          : `<div class="empty">No approved admins yet.</div>`
      }`
    ),
    mount() {
      for (const form of document.querySelectorAll('[data-approve]')) {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = form.querySelector('button[type="submit"]');
          busy(button, true, 'Approving…');
          try {
            await api.post(`/admin-applications/${form.dataset.approve}/approve`, {
              scope: {
                level: form.level.value,
                country: form.country.value.trim(),
                city: form.city.value.trim()
              }
            });
            toast('Admin approved.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
      for (const button of document.querySelectorAll('[data-reject]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Rejecting…');
          try {
            await api.post(`/admin-applications/${button.dataset.reject}/reject`, {});
            toast('Application rejected.', 'ok');
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

async function adminsView(ctx) {
  const { admins } = await api.get('/admin-applications');
  return {
    title: 'Admins',
    html: shell(
      '#/owner/admins',
      'Admins',
      'Change access or revoke it at any time. Permissions are enforced by the server.',
      `<form id="new-admin" class="card" style="margin-bottom:16px">
        <h3 style="margin-top:0">Create an admin directly</h3>
        <div class="split">
          <div class="field"><label for="admin-name">Full name</label><input id="admin-name" name="full_name" required /></div>
          <div class="field"><label for="admin-email">Email</label><input id="admin-email" name="email" type="email" required /></div>
        </div>
        <div class="split">
          <div class="field"><label for="admin-password">Temporary password</label><input id="admin-password" name="password" type="password" minlength="8" required /></div>
          <div class="field"><label for="admin-phone">Phone (optional)</label><input id="admin-phone" name="phone" /></div>
        </div>
        ${scopeSelect('new-admin', { level: 'global' })}
        <button type="submit" class="btn btn-navy">Create admin</button>
      </form>
      ${admins
        .map(
          (admin) => `<form class="card" data-admin="${esc(admin.id)}" style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <div>
                <strong>${esc(admin.full_name)}</strong>
                <p class="muted" style="margin:2px 0 0">${esc(admin.email)} · ${esc(admin.scope.label)}</p>
              </div>
              <span class="pill">${esc(admin.status)}</span>
            </div>
            ${scopeSelect(`admin-${admin.id}`, admin.scope)}
            <div class="btn-row">
              <button type="submit" class="btn btn-navy btn-sm">Save access</button>
              ${
                admin.status === 'active'
                  ? `<button type="button" class="btn btn-ghost btn-sm" data-status="suspended" data-id="${esc(admin.id)}">Suspend</button>`
                  : `<button type="button" class="btn btn-ghost btn-sm" data-status="active" data-id="${esc(admin.id)}">Reactivate</button>`
              }
            </div>
          </form>`
        )
        .join('')}`
    ),
    mount() {
      const createForm = document.getElementById('new-admin');
      if (createForm) {
        createForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = createForm.querySelector('button[type="submit"]');
          busy(button, true, 'Creating…');
          try {
            await api.post('/owner/admins', {
              full_name: createForm.full_name.value.trim(),
              email: createForm.email.value.trim(),
              password: createForm.password.value,
              phone: createForm.phone.value.trim(),
              scope: {
                level: createForm.level.value,
                country: createForm.country.value.trim(),
                city: createForm.city.value.trim()
              }
            });
            toast('Admin created.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }

      for (const form of document.querySelectorAll('[data-admin]')) {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = form.querySelector('button[type="submit"]');
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/owner/admins/${form.dataset.admin}`, {
              scope: {
                level: form.level.value,
                country: form.country.value.trim(),
                city: form.city.value.trim()
              }
            });
            toast('Access updated.', 'ok');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }

      for (const button of document.querySelectorAll('[data-status]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/owner/admins/${button.dataset.id}`, { status: button.dataset.status });
            toast('Admin updated.', 'ok');
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

export function view(ctx) {
  const section = ctx.parts[1];
  if (section === 'admins') return adminsView(ctx);
  return applications(ctx);
}

/** Public application page, linked from the sign-in screens. */
export function applyView() {
  return {
    title: 'Apply for admin access',
    html: `<div class="container" style="max-width:640px">
      <div class="section-head"><div>
        <h1>Apply for admin access</h1>
        <p class="muted" style="margin:0">Anyone, from any country, may apply. The platform owner reviews every application and decides whether access is global or limited to one region.</p>
      </div></div>
      <form id="apply-form" class="card">
        <div class="field"><label for="apply-name">Full name</label><input id="apply-name" name="full_name" required /></div>
        <div class="field"><label for="apply-email">Email</label><input id="apply-email" name="email" type="email" required /></div>
        <div class="field"><label for="apply-password">Password (8+ characters)</label><input id="apply-password" name="password" type="password" minlength="8" required /></div>
        <div class="split">
          <div class="field"><label for="apply-country">Country</label><input id="apply-country" name="country" required /></div>
          <div class="field"><label for="apply-city">City / region</label><input id="apply-city" name="city" /></div>
        </div>
        <div class="field"><label for="apply-phone">Phone (optional)</label><input id="apply-phone" name="phone" /></div>
        <div class="field"><label for="apply-scope">Access you are applying for</label>
          <select id="apply-scope" name="requested_scope">
            <option value="regional">Regional — my country or city</option>
            <option value="global">Global — entire platform</option>
          </select>
        </div>
        <div class="field"><label for="apply-note">Why should you be an admin? (optional)</label><textarea id="apply-note" name="note" rows="3"></textarea></div>
        <button type="submit" class="btn btn-navy">Send application</button>
        <p class="muted" style="margin:10px 0 0">You can sign in only after the owner approves your application.</p>
      </form>
    </div>`,
    mount() {
      const form = document.getElementById('apply-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Sending…');
        try {
          const result = await api.post('/admin-applications', {
            full_name: form.full_name.value.trim(),
            email: form.email.value.trim(),
            password: form.password.value,
            country: form.country.value.trim(),
            city: form.city.value.trim(),
            phone: form.phone.value.trim(),
            requested_scope: form.requested_scope.value,
            note: form.note.value.trim()
          });
          form.innerHTML = `<div class="notice notice-ok">${esc(result.message)}</div><p><a class="btn btn-navy btn-sm" href="#/">Back to home</a></p>`;
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}
