import { api } from '../api.js';
import { esc, toast, busy, formObject, pill, money, fmtDate, fmtDateTime, empty, ageBadge } from '../ui.js';
import { panelShell, options, statCards, invoiceList } from './common.js';

const TABS = [
  ['#/admin', 'Overview'],
  ['#/admin/users', 'Accounts'],
  ['#/admin/institutions', 'Institutions'],
  ['#/admin/listings', 'Listings'],
  ['#/admin/documents', 'Agreements & Invoices'],
  ['#/admin/commission', 'Commission'],
  ['#/admin/reports', 'Reports'],
  ['#/admin/settings', 'Settings']
];

function shell(path, title, subtitle, body) {
  return panelShell({ title, subtitle, tabs: TABS, path, body });
}

async function overview(ctx) {
  const { counts, commission, commission_summary: commissionSummary } = await api.get('/admin/overview');
  const body = `
    ${statCards([
      ['Workers', counts.workers],
      ['Businesses', counts.businesses],
      ['Open listings', counts.jobs_open],
      ['Pending institutions', counts.institutions_pending]
    ])}
    ${statCards([
      ['Applications', counts.applications],
      ['Agreements', counts.agreements],
      ['Invoices', counts.invoices],
      ['Open reports', counts.reports_open]
    ])}
    <div class="split">
      <div class="card">
        <h3>Moderation queue</h3>
        <p class="muted">Institution registrations waiting for review: <strong>${counts.institutions_pending}</strong></p>
        <p class="muted">Reported content waiting for action: <strong>${counts.reports_open}</strong></p>
        <div class="btn-row">
          <a class="btn btn-navy btn-sm" href="#/admin/institutions">Review institutions</a>
          <a class="btn btn-ghost btn-sm" href="#/admin/reports">Review reports</a>
        </div>
      </div>
      <div class="card">
        <h3>Commission</h3>
        <p class="muted">${commission && Number(commission.rate) > 0 ? `Active at ${commission.rate}% — paid by ${esc(commission.payer)}.` : '0% — no commission is charged.'}</p>
        <p class="sig-hint">${commissionSummary && commissionSummary.count ? `${commissionSummary.count} recorded document${commissionSummary.count === 1 ? '' : 's'} in the commission record.` : 'No commission recorded yet.'} Applied to every new agreement and invoice; shown only in the invoice history.</p>
        <a class="btn btn-ghost btn-sm" href="#/admin/commission">Open commission dashboard</a>
      </div>
    </div>`;

  return { title: 'Admin overview', html: shell('/admin', 'Admin overview', 'Platform administration', body) };
}

// Admin can correct any worker or business profile, and issue a reset link.
function editForm(u, categories) {
  const p = u.profile || {};
  const worker = u.role === 'worker';
  const uid = esc(u.id);
  const field = (name, label, value, type = 'text', extra = '') => `
    <div class="field">
      <label for="${name}-${uid}">${esc(label)}</label>
      <input id="${name}-${uid}" name="${name}" type="${type}" value="${esc(value ?? '')}" ${extra}>
    </div>`;
  const details = worker
    ? `${field('city', 'City', p.city)}
       <div class="field"><label for="category-${uid}">Work category</label>
         <select id="category-${uid}" name="category">${options(categories, p.category || '')}</select></div>
       ${field('experience_years', 'Experience (years)', p.experience_years ?? 0, 'number', 'min="0" max="60"')}
       ${field('skills', 'Skills (comma separated)', (p.skills || []).join(', '))}
       <div class="field"><label for="bio-${uid}">About</label>
         <textarea id="bio-${uid}" name="bio" maxlength="1000">${esc(p.bio || '')}</textarea></div>
       <label class="sig-hint" style="display:flex;gap:8px;align-items:center">
         <input type="checkbox" name="available" ${p.available ? 'checked' : ''}> Available for work</label>`
    : `${field('company_name', 'Company name', p.company_name)}
       ${field('country', 'Country', p.country)}
       ${field('address', 'Address', p.address)}
       ${field('website', 'Website', p.website)}
       <div class="field"><label for="about-${uid}">About</label>
         <textarea id="about-${uid}" name="about" maxlength="1000">${esc(p.about || '')}</textarea></div>`;
  return `
    <details class="no-print" style="margin-top:8px">
      <summary class="sig-hint" style="cursor:pointer">Edit profile details</summary>
      <form data-edit="${uid}" class="form-grid" style="margin-top:10px">
        ${field('full_name', worker ? 'Full name' : 'Contact person', u.full_name, 'text', 'required maxlength="120"')}
        ${field('phone', 'Phone number', u.phone, 'tel', 'required maxlength="40"')}
        ${field('email', 'Email', u.email, 'email', 'required maxlength="160"')}
        ${details}
        <div class="btn-row"><button class="btn btn-navy btn-sm" type="submit">Save changes</button></div>
      </form>
    </details>`;
}

async function users(ctx) {
  const role = ctx.query.get('role') || '';
  const { users: list } = await api.get(`/admin/users${role ? `?role=${encodeURIComponent(role)}` : ''}`);
  const body = `
    <div class="card">
      <div class="section-head">
        <h2>Accounts (${list.length})</h2>
        <div class="btn-row">
          <a class="btn btn-ghost btn-sm" href="#/admin/users">All</a>
          <a class="btn btn-ghost btn-sm" href="#/admin/users?role=worker">Workers</a>
          <a class="btn btn-ghost btn-sm" href="#/admin/users?role=business">Businesses</a>
        </div>
      </div>
      ${
        list.length
          ? `<div class="list-stack">${list
              .map(
                (u) => `<article class="card card-tight">
          <div class="section-head" style="margin-bottom:6px">
            <div><strong>${esc(u.full_name)}</strong>
              <div class="job-meta"><span class="tag">${esc(u.role)}</span><span>${esc(u.email)}</span>${u.phone ? `<span>${esc(u.phone)}</span>` : ''}</div>
            </div>
            <div>${pill(u.status)}</div>
          </div>
          <p class="muted" style="margin:0 0 8px">Joined ${esc(fmtDate(u.created_at))}${u.role === 'business' ? ` · ${u.jobs} listings` : ` · ${u.applications} applications`}</p>
          <div class="btn-row">
            ${
              u.status === 'active'
                ? `<button class="btn btn-danger btn-sm" data-suspend="${esc(u.id)}">Suspend</button>`
                : `<button class="btn btn-ghost btn-sm" data-activate="${esc(u.id)}">Reactivate</button>`
            }
            <button class="btn btn-ghost btn-sm" data-reset="${esc(u.id)}">Create reset link</button>
          </div>
          <p class="sig-hint" data-reset-out="${esc(u.id)}"></p>
          ${editForm(u, ctx.meta?.categories || [])}
        </article>`
              )
              .join('')}</div>`
          : empty('No accounts found.')
      }
    </div>`;

  return {
    title: 'Accounts',
    html: shell('/admin/users', 'Manage accounts', 'Suspend abusive accounts; all data is retained.', body),
    mount() {
      const set = async (id, status, button) => {
        busy(button, true, 'Saving…');
        try {
          await api.patch(`/admin/users/${id}`, { status });
          toast(`Account ${status}`, 'success');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      };
      for (const button of document.querySelectorAll('[data-suspend]')) {
        button.addEventListener('click', () => set(button.dataset.suspend, 'suspended', button));
      }
      for (const button of document.querySelectorAll('[data-activate]')) {
        button.addEventListener('click', () => set(button.dataset.activate, 'active', button));
      }
      for (const form of document.querySelectorAll('[data-edit]')) {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = form.querySelector('button[type="submit"]');
          busy(button, true, 'Saving…');
          const body = formObject(form);
          if (form.elements.available) body.available = form.elements.available.checked;
          try {
            await api.patch(`/admin/users/${form.dataset.edit}`, body);
            toast('Profile updated', 'success');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
      for (const button of document.querySelectorAll('[data-reset]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Creating…');
          try {
            const res = await api.post(`/admin/users/${button.dataset.reset}/reset-link`);
            const out = document.querySelector(`[data-reset-out="${button.dataset.reset}"]`);
            if (out) {
              out.innerHTML = `Password reset link for ${esc(res.email)} (expires ${esc(
                fmtDateTime(res.expires_at)
              )}):<br><a href="${esc(res.reset_url)}">${esc(res.reset_url)}</a>`;
            }
            toast('Reset link created', 'success');
          } catch (error) {
            toast(error.message, 'error');
          } finally {
            busy(button, false);
          }
        });
      }
    }
  };
}

async function institutions(ctx) {
  const status = ctx.query.get('status') || '';
  const { institutions: list } = await api.get(`/admin/institutions${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  const body = `
    <div class="card">
      <div class="section-head">
        <h2>Institution registrations (${list.length})</h2>
        <div class="btn-row">
          <a class="btn btn-ghost btn-sm" href="#/admin/institutions?status=pending">Pending</a>
          <a class="btn btn-ghost btn-sm" href="#/admin/institutions?status=approved">Approved</a>
          <a class="btn btn-ghost btn-sm" href="#/admin/institutions?status=rejected">Rejected</a>
          <a class="btn btn-ghost btn-sm" href="#/admin/institutions">All</a>
        </div>
      </div>
      ${
        list.length
          ? `<div class="list-stack">${list
              .map(
                (i) => `<article class="card card-tight">
          <div class="section-head" style="margin-bottom:6px">
            <div><strong>${esc(i.name)}</strong>
              <div class="job-meta"><span class="tag">${esc(i.type)}</span><span>${esc(i.contact_name)}</span><span>${esc(i.email)}</span></div>
            </div>
            <div>${pill(i.status)}</div>
          </div>
          ${i.phone || i.address ? `<p class="muted" style="margin:0 0 6px">Private contact: ${esc([i.phone, i.address].filter(Boolean).join(' · '))}</p>` : ''}
          ${i.description ? `<p class="muted" style="margin:0 0 8px">${esc(i.description)}</p>` : ''}
          ${i.review_note ? `<p class="sig-hint">Review note: ${esc(i.review_note)}</p>` : ''}
          <div class="btn-row">
            <button class="btn btn-primary btn-sm" data-review="${esc(i.id)}" data-status="approved">Approve</button>
            <button class="btn btn-danger btn-sm" data-review="${esc(i.id)}" data-status="rejected">Reject</button>
            <button class="btn btn-ghost btn-sm" data-review="${esc(i.id)}" data-status="pending">Set pending</button>
          </div>
        </article>`
              )
              .join('')}</div>`
          : empty('No institution registrations in this filter.')
      }
    </div>
    <p class="sig-hint">Only approved institution names and types are shown publicly. Addresses and contact details stay in the admin panel.</p>`;

  return {
    title: 'Institutions',
    html: shell('/admin/institutions', 'Institutional & social support', 'Approve organizations before they are listed.', body),
    mount() {
      for (const button of document.querySelectorAll('[data-review]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/admin/institutions/${button.dataset.review}`, { status: button.dataset.status });
            toast(`Institution ${button.dataset.status}`, 'success');
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

async function listings(ctx) {
  const { jobs } = await api.get('/admin/jobs');
  const body = `
    <div class="card">
      <h2>All listings (${jobs.length})</h2>
      ${
        jobs.length
          ? `<div class="list-stack">${jobs
              .map(
                (job) => `<article class="job-card">
          <header>
            <div><h3>${esc(job.title)}</h3>
              <div class="job-meta"><span class="tag">${esc(job.category)}</span><span>${esc(job.business.company_name)}</span><span>${esc(fmtDate(job.created_at))}</span></div>
            </div>
            <div style="text-align:right">${ageBadge(job)}<div style="margin-top:4px">${pill(job.status)}</div></div>
          </header>
          <div class="btn-row">
            <a class="btn btn-ghost btn-sm" href="#/business/jobs/${esc(job.id)}">Inspect</a>
            ${
              job.status === 'removed'
                ? `<button class="btn btn-ghost btn-sm" data-status="${esc(job.id)}" data-to="open">Restore</button>`
                : `<button class="btn btn-danger btn-sm" data-status="${esc(job.id)}" data-to="removed">Remove</button>
                   <button class="btn btn-ghost btn-sm" data-status="${esc(job.id)}" data-to="closed">Close</button>`
            }
          </div>
        </article>`
              )
              .join('')}</div>`
          : empty('No listings yet.')
      }
    </div>
    <p class="sig-hint">Listings are never deleted by age. Removal keeps the record and hides it from workers.</p>`;

  return {
    title: 'Listings',
    html: shell('/admin/listings', 'Manage work listings', 'Remove listings that break the rules.', body),
    mount() {
      for (const button of document.querySelectorAll('[data-status]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/jobs/${button.dataset.status}`, { status: button.dataset.to });
            toast('Listing updated', 'success');
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

async function documents(ctx) {
  const [agr, inv] = await Promise.all([api.get('/admin/agreements'), api.get('/admin/invoices')]);
  const agreements = agr.agreements || [];
  const invoices = inv.invoices || [];
  const body = `
    <div class="card">
      <h2>Agreements (${agreements.length})</h2>
      ${
        agreements.length
          ? `<div class="list-stack">${agreements
              .map(
                (a) => `<article class="card card-tight">
          <div class="section-head" style="margin-bottom:6px">
            <div><strong>${esc(a.ref)}</strong><div class="job-meta"><span>${esc(a.business.company_name)}</span><span>${esc(a.worker.full_name)}</span><span>${esc(fmtDate(a.created_at))}</span></div></div>
            <div>${pill(a.status)}</div>
          </div>
          <a class="btn btn-navy btn-sm" href="#/agreements/${esc(a.id)}">Open</a>
        </article>`
              )
              .join('')}</div>`
          : empty('No agreements yet.')
      }
    </div>
    <div class="card">
      <h2>Invoices (${invoices.length})</h2>
      ${
        invoices.length
          ? invoiceList(invoices)
          : empty('No invoices yet.')
      }
    </div>`;

  return { title: 'Agreements & Invoices', html: shell('/admin/documents', 'Agreements & invoices', 'Read-only oversight of issued documents.', body) };
}

async function reports(ctx) {
  const { reports: list } = await api.get('/admin/reports');
  const body = `<div class="card">
    <h2>Reported content (${list.length})</h2>
    ${
      list.length
        ? `<div class="list-stack">${list
            .map(
              (r) => `<article class="card card-tight">
          <div class="section-head" style="margin-bottom:6px">
            <div><strong>${esc(r.target_type)} reported</strong>
              <div class="job-meta"><span>${esc(fmtDate(r.created_at))}</span><span>${esc(r.reporter_role || 'user')}</span></div>
            </div>
            <div>${pill(r.status)}</div>
          </div>
          <p class="muted" style="margin:0 0 8px">${esc(r.reason)}</p>
          <div class="btn-row">
            <button class="btn btn-primary btn-sm" data-report="${esc(r.id)}" data-status="resolved">Resolve</button>
            <button class="btn btn-ghost btn-sm" data-report="${esc(r.id)}" data-status="dismissed">Dismiss</button>
          </div>
        </article>`
            )
            .join('')}</div>`
        : empty('No reports submitted.')
    }
  </div>`;

  return {
    title: 'Reports',
    html: shell('/admin/reports', 'Reported content', 'Review reports submitted by workers and businesses.', body),
    mount() {
      for (const button of document.querySelectorAll('[data-report]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Saving…');
          try {
            await api.patch(`/admin/reports/${button.dataset.report}`, { status: button.dataset.status });
            toast('Report updated', 'success');
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

async function settings(ctx) {
  const [{ commission }, platform] = await Promise.all([
    api.get('/admin/settings/commission'),
    api.get('/admin/settings')
  ]);
  const currencySettings = (platform.settings && platform.settings.currency) || { default: 'SAR', enabled: ['SAR'] };
  const registration = (platform.settings && platform.settings.registration) || { worker: 'auto', business: 'auto' };
  const catalog = platform.currencies || [];
  const enabledSet = new Set(currencySettings.enabled || []);
  const drivers = platform.drivers || {};

  const currencyCard = `<div class="card">
    <h2>Currency</h2>
    <p class="muted">The default currency is applied to new agreements, invoices and listings. Enable only the currencies your users need.</p>
    <form id="currency-form">
      <div class="field"><label for="default_currency">Default currency</label>
        <select id="default_currency" name="default">
          ${catalog
            .map(
              (c) =>
                `<option value="${esc(c.code)}"${c.code === currencySettings.default ? ' selected' : ''}>${esc(c.code)} — ${esc(
                  c.name || c.code
                )}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="field"><label>Enabled currencies</label>
        <div class="currency-grid">
          ${catalog
            .map(
              (c) => `<label class="currency-check"><input type="checkbox" name="enabled" value="${esc(
                c.code
              )}"${enabledSet.has(c.code) ? ' checked' : ''} /> <span>${esc(c.code)}</span></label>`
            )
            .join('')}
        </div>
      </div>
      <button class="btn btn-navy" type="submit">Save currency settings</button>
    </form>
  </div>`;

  const modeSelect = (name, value) => `<select id="${name}_mode" name="${name}">
      <option value="auto"${value === 'auto' ? ' selected' : ''}>Automatic approval</option>
      <option value="review"${value === 'review' ? ' selected' : ''}>Admin review</option>
    </select>`;

  const registrationCard = `<div class="card">
    <h2>Registration approval</h2>
    <p class="muted">Decide whether new accounts can sign in immediately or wait for an administrator decision. Institutions always require review.</p>
    <form id="registration-form">
      <div class="form-row two">
        <div class="field"><label for="worker_mode">Workers</label>${modeSelect('worker', registration.worker)}</div>
        <div class="field"><label for="business_mode">Businesses</label>${modeSelect('business', registration.business)}</div>
      </div>
      <button class="btn btn-navy" type="submit">Save registration settings</button>
    </form>
  </div>`;

  const infrastructureCard = `<div class="card">
    <h2>Infrastructure</h2>
    <p class="muted">Storage driver: <strong>${esc(drivers.persistence || 'unknown')}</strong> · Authentication: <strong>${esc(
    drivers.auth || 'unknown'
  )}</strong></p>
    <p class="muted">Supabase configured: <strong>${platform.setup && platform.setup.supabase_configured ? 'yes' : 'no'}</strong> · Administrator account: <strong>${
    platform.setup && platform.setup.admin_exists ? 'created' : 'missing'
  }</strong></p>
    <p class="sig-hint">Set Supabase credentials in the server environment to move all storage to the managed database. See docs/SUPABASE.md.</p>
  </div>`;

  const commissionCard = `<div class="card">
    <h2>Commission</h2>
    <p class="muted">Current: <strong>${commission ? `${commission.rate}%` : '0%'}</strong>${commission && Number(commission.rate) > 0 ? ` (${esc(commission.payer)} pays)` : ' — no commission charged'}</p>
    <p class="sig-hint">The percentage is changed on the Commission page. It applies to every new agreement and invoice and is recorded for the administrator only.</p>
    <a class="btn btn-ghost btn-sm" href="#/admin/commission">Open commission dashboard</a>
  </div>`;

  const body = `${currencyCard}${registrationCard}${commissionCard}`;

  return {
    title: 'Settings',
    html: shell('/admin/settings', 'Platform settings', 'Currency, registration approval and commission.', body),
    mount() {
      const currencyForm = document.getElementById('currency-form');
      currencyForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = currencyForm.querySelector('button[type="submit"]');
        const enabled = [...currencyForm.querySelectorAll('input[name="enabled"]:checked')].map((input) => input.value);
        busy(button, true, 'Saving…');
        try {
          const res = await api.put('/admin/settings/currency', {
            default: currencyForm.elements.default.value,
            enabled
          });
          toast('Currency settings saved', 'success');
          await ctx.refresh();
          return res;
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(button, false);
        }
      });

      const registrationForm = document.getElementById('registration-form');
      registrationForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = registrationForm.querySelector('button[type="submit"]');
        busy(button, true, 'Saving…');
        try {
          await api.put('/admin/settings/registration', {
            worker: registrationForm.elements.worker.value,
            business: registrationForm.elements.business.value
          });
          toast('Registration settings saved', 'success');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(button, false);
        }
      });

    }
  };
}

// Administrator commission dashboard: set the rate, see totals and the full record.
async function commissionView(ctx) {
  const { commission, entries, summary } = await api.get('/admin/commissions');

  const totalsRows = (summary.by_currency || [])
    .map(
      (row) => `<tr><td>${esc(row.currency)}</td><td>${row.documents}</td><td>${money(
        row.base_total,
        row.currency
      )}</td><td><strong>${money(row.commission_total, row.currency)}</strong></td></tr>`
    )
    .join('');

  const ledgerRows = entries.length
    ? entries
        .map(
          (entry) => `<tr>
        <td>${esc(fmtDateTime(entry.created_at))}</td>
        <td>${entry.doc_type === 'invoice' ? 'Invoice' : 'Agreement'}<br /><span class="muted">${esc(
            entry.ref || ''
          )}</span></td>
        <td>${esc(entry.business_name || '—')}<br /><span class="muted">${esc(
            entry.worker_name || '—'
          )}</span></td>
        <td>${money(entry.amount, entry.currency)}</td>
        <td>${entry.rate}%</td>
        <td><strong>${money(entry.commission_amount, entry.currency)}</strong></td>
        <td>${esc(entry.payer || '—')}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="7" class="muted">No commission recorded yet. A row appears here each time an agreement or invoice is created while commission is enabled.</td></tr>`;

  const body = `
    <div class="card">
      <h2>Commission percentage</h2>
      <p class="muted">The selected percentage applies automatically to every new agreement and every new invoice. Documents that already exist keep the rate they were recorded with.</p>
      <form id="commission-form">
        <div class="form-row two">
          <div class="field"><label for="rate">Rate (%)</label>
            <input id="rate" name="rate" type="number" min="0" max="20" step="0.5" value="${commission.rate}" required />
          </div>
          <div class="field"><label for="payer">Payer</label>
            <select id="payer" name="payer">${options(['business', 'worker', 'both'], commission.payer)}</select>
          </div>
        </div>
        <p class="sig-hint">Enter 0% to charge no commission. The percentage applies to every new agreement and invoice, and is shown in the invoice history.</p>
        <button class="btn btn-navy" type="submit">Save commission percentage</button>
      </form>
      <div class="notice" id="commission-state" style="margin-top:12px">
        Current: <strong>${commission.rate}%</strong>${Number(commission.rate) > 0 ? ` paid by ${esc(commission.payer)}` : ' — no commission charged'}
      </div>
    </div>
    <div class="card">
      <h2>Totals</h2>
      ${summary.count ? `<table class="doc-table"><thead><tr><th>Currency</th><th>Documents</th><th>Document value</th><th>Commission</th></tr></thead><tbody>${totalsRows}</tbody></table>` : '<p class="muted">No commission recorded yet.</p>'}
    </div>
    <div class="card">
      <h2>Commission record</h2>
      <table class="doc-table"><thead><tr><th>Date</th><th>Document</th><th>Business / Worker</th><th>Amount</th><th>Rate</th><th>Commission</th><th>Payer</th></tr></thead><tbody>${ledgerRows}</tbody></table>
    </div>`;

  return {
    title: 'Commission',
    html: shell('#/admin/commission', 'Commission', 'Rate, totals and record', body),
    mount() {
      const form = document.getElementById('commission-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Saving…');
        try {
          const res = await api.put('/admin/settings/commission', {
            rate: Number(form.elements.rate.value),
            payer: form.elements.payer.value
          });
          if (ctx.setCommission && res.commission) ctx.setCommission(res.commission);
          toast('Commission percentage saved', 'success');
          await ctx.refresh();
          return res;
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(button, false);
        }
      });
    }
  };
}

export async function view(ctx) {
  const section = ctx.parts[1] || 'overview';
  if (section === 'overview') return overview(ctx);
  if (section === 'users') return users(ctx);
  if (section === 'institutions') return institutions(ctx);
  if (section === 'listings') return listings(ctx);
  if (section === 'documents') return documents(ctx);
  if (section === 'commission') return commissionView(ctx);
  if (section === 'reports') return reports(ctx);
  if (section === 'settings') return settings(ctx);
  return { title: 'Not found', html: shell('/admin', 'Not found', '', empty('That page does not exist.')) };
}
