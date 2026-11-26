import { api } from '../api.js';
import { esc, toast, busy, formObject, pill, money, fmtDate, empty, ageBadge } from '../ui.js';
import { panelShell, jobCard, options, statCards, invoiceList } from './common.js';

// The primary ride action sits in the dashboard header beside Share link, so it
// is reachable without scrolling to the bottom of the page.
const BOOK_CAR_CTA = '<a class="btn btn-navy btn-sm" href="#/business/bookings">Book a Car</a>';

const TABS = [
  ['#/business', 'Dashboard'],
  ['#/business/jobs', 'My Listings'],
  ['#/business/workers', 'Find Workers'],
  ['#/business/applications', 'Applications'],
  ['#/business/agreements', 'Agreements'],
  ['#/business/invoices', 'Invoices'],
  ['#/business/profile', 'Profile']
];

function shell(path, title, subtitle, body, actions = '') {
  return panelShell({ title, subtitle, tabs: TABS, path, body, actions });
}

async function ownJobs() {
  const { jobs } = await api.get('/jobs?status=all');
  return (jobs || []).filter((job) => job.business.id);
}

async function overview(ctx) {
  const [jobsRes, appsRes, agrRes, invRes, metaRes] = await Promise.all([
    api.get('/jobs?status=all'),
    api.get('/applications'),
    api.get('/agreements'),
    api.get('/invoices'),
    api.get('/meta')
  ]);
  const commission = (metaRes && metaRes.commission) || { enabled: false, rate: 0, payer: 'business' };
  const mine = (jobsRes.jobs || []).filter((job) => job.business.id === ctx.user.id);
  const apps = appsRes.applications || [];
  const pendingApps = apps.filter((a) => a.status === 'pending');

  const body = `
    ${statCards([
      ['Open listings', mine.filter((j) => j.status === 'open').length],
      ['Applications', apps.length],
      ['Awaiting review', pendingApps.length],
      ['Agreements', (agrRes.agreements || []).length]
    ])}
    <div class="btn-row" style="margin-bottom:12px">
      <a class="btn btn-navy" href="#/business/jobs/new">Post a work opportunity</a>
      <a class="btn btn-ghost" href="#/business/workers">Search workers</a>
    </div>
    <div class="split">
      <div class="card">
        <div class="section-head"><h2>My listings</h2><a class="link-quiet" href="#/business/jobs">Manage</a></div>
        <div class="list-stack">
          ${mine.slice(0, 4).map((job) => jobCard(job, `<a class="btn btn-ghost btn-sm" href="#/business/jobs/${esc(job.id)}">Applicants (${job.application_count})</a>`)).join('') || empty('You have not posted a listing yet.')}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Newest applications</h3>
          ${
            apps.slice(0, 4).map((a) => `<p style="margin-bottom:8px"><strong>${esc(a.worker_name)}</strong> — ${esc(a.job_title)}<br /><span class="muted">${esc(fmtDate(a.created_at))} · ${esc(a.status)}</span></p>`).join('') ||
            '<p class="muted">No applications yet.</p>'
          }
          <a class="link-quiet" href="#/business/applications">All applications</a>
        </div>
        <div class="card">
          <h3>Company profile</h3>
          <dl class="kv">
            <dt>Company</dt><dd>${esc((ctx.user.profile || {}).company_name || '—')}</dd>
            <dt>Contact</dt><dd>${esc((ctx.user.profile || {}).contact_name || ctx.user.full_name)}</dd>
            <dt>Country</dt><dd>${esc((ctx.user.profile || {}).country || '—')}</dd>
            <dt>Platform commission</dt><dd>${Number(commission.rate) > 0 ? `${commission.rate}% (paid by ${esc(commission.payer)})` : '0% — no commission charged'}</dd>
          </dl>
          <a class="btn btn-ghost btn-sm" href="#/business/profile">Edit profile</a>
        </div>
      </div>
    </div>`;

  return {
    title: 'Business dashboard',
    html: shell('/business', 'Business dashboard', `Signed in as ${ctx.user.full_name}`, body, BOOK_CAR_CTA)
  };
}

async function jobs(ctx) {
  const mine = (await ownJobs()).filter((job) => job.business.id === ctx.user.id);
  const body = `
    <div class="btn-row" style="margin-bottom:12px"><a class="btn btn-navy" href="#/business/jobs/new">Post new listing</a></div>
    ${
      mine.length
        ? `<div class="list-stack">${mine
            .map(
              (job) => `<article class="job-card">
          <header>
            <div><h3>${esc(job.title)}</h3>
              <div class="job-meta"><span class="tag">${esc(job.category)}</span>${job.location ? `<span>${esc(job.location)}</span>` : ''}<span>${job.application_count} applicants</span></div>
            </div>
            <div style="text-align:right">${ageBadge(job)}<div style="margin-top:4px">${pill(job.status)}</div></div>
          </header>
          <div class="job-pay">${money(job.pay_amount, job.currency)} / ${esc(job.pay_period)}</div>
          <div class="btn-row">
            <a class="btn btn-ghost btn-sm" href="#/business/jobs/${esc(job.id)}">Applicants</a>
            ${
              job.status === 'open'
                ? `<button class="btn btn-danger btn-sm" data-close="${esc(job.id)}">Close listing</button>`
                : job.status === 'closed'
                  ? `<button class="btn btn-ghost btn-sm" data-reopen="${esc(job.id)}">Reopen</button>`
                  : '<span class="badge badge-old">Removed by admin</span>'
            }
          </div>
        </article>`
            )
            .join('')}</div>`
        : empty('No listings yet.')
    }`;

  return {
    title: 'My listings',
    html: shell('/business/jobs', 'My listings', 'Listings are never deleted automatically — close them when the work is filled.', body),
    mount() {
      const change = async (id, status, button) => {
        busy(button, true, 'Saving…');
        try {
          await api.patch(`/jobs/${id}`, { status });
          toast(status === 'closed' ? 'Listing closed' : 'Listing reopened', 'success');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      };
      for (const button of document.querySelectorAll('[data-close]')) {
        button.addEventListener('click', () => change(button.dataset.close, 'closed', button));
      }
      for (const button of document.querySelectorAll('[data-reopen]')) {
        button.addEventListener('click', () => change(button.dataset.reopen, 'open', button));
      }
    }
  };
}

async function newJob(ctx) {
  const categories = (ctx.meta && ctx.meta.categories) || [];
  const periods = (ctx.meta && ctx.meta.pay_periods) || ['hour', 'day', 'week', 'month', 'project'];
  const body = `<div class="card">
    <form id="job-form">
      <div class="field"><label for="title">Listing title</label><input id="title" name="title" required maxlength="160" placeholder="Delivery driver for city routes" /></div>
      <div class="form-row two">
        <div class="field"><label for="category">Work category</label><select id="category" name="category" required>${options(categories)}</select></div>
        <div class="field"><label for="location">Location</label><input id="location" name="location" maxlength="160" placeholder="City / area" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="pay_amount">Pay amount</label><input id="pay_amount" name="pay_amount" type="number" min="0" step="0.01" value="0" /></div>
        <div class="field"><label for="pay_period">Pay period</label><select id="pay_period" name="pay_period">${options(periods)}</select></div>
      </div>
      <div class="field"><label for="description">Description</label><textarea id="description" name="description" required maxlength="4000" placeholder="Describe the work, schedule and expectations."></textarea></div>
      <div class="field"><label for="requirements">Requirements (optional)</label><textarea id="requirements" name="requirements" maxlength="1000"></textarea></div>
      <button class="btn btn-navy" type="submit">Publish listing</button>
    </form>
  </div>`;

  return {
    title: 'Post a listing',
    html: shell('/business/jobs/new', 'Post a work opportunity', 'Workers in the matching category are notified automatically.', body),
    mount() {
      const form = document.getElementById('job-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Publishing…');
        try {
          const res = await api.post('/jobs', formObject(form));
          toast('Listing published', 'success');
          location.hash = `#/business/jobs/${res.job.id}`;
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}

async function jobDetail(ctx, id) {
  const { job } = await api.get(`/jobs/${id}`);
  const applicants = job.applications || [];
  const body = `
    <div class="card">
      <div class="section-head">
        <div><h2 style="margin-bottom:4px">${esc(job.title)}</h2>
          <div class="job-meta"><span class="tag">${esc(job.category)}</span>${job.location ? `<span>${esc(job.location)}</span>` : ''}<span>Posted ${esc(fmtDate(job.created_at))}</span></div>
        </div>
        <div style="text-align:right">${ageBadge(job)}<div style="margin-top:4px">${pill(job.status)}</div></div>
      </div>
      <p style="white-space:pre-wrap">${esc(job.description)}</p>
      <p><strong>${money(job.pay_amount, job.currency)} / ${esc(job.pay_period)}</strong></p>
      ${job.status === 'open' ? `<button class="btn btn-danger btn-sm" id="close-job">Close listing</button>` : ''}
    </div>
    <div class="card">
      <h2>Applicants (${applicants.length})</h2>
      ${
        applicants.length
          ? `<div class="list-stack">${applicants
              .map(
                (a) => `<article class="card card-tight">
          <div class="section-head" style="margin-bottom:6px">
            <div><strong>${esc(a.worker_name)}</strong><div class="job-meta"><span>${esc(a.worker_category || '—')}</span>${a.worker_city ? `<span>${esc(a.worker_city)}</span>` : ''}${a.worker_phone ? `<a class="link-quiet" href="tel:${esc(a.worker_phone)}">${esc(a.worker_phone)}</a>` : ''}</div></div>
            <div>${pill(a.status)}</div>
          </div>
          ${a.message ? `<p class="muted" style="margin:0 0 8px">${esc(a.message)}</p>` : ''}
          <div class="btn-row">
            <a class="btn btn-navy btn-sm" href="#/agreements/new?worker=${esc(a.worker_id)}">Create agreement</a>
            <button class="btn btn-ghost btn-sm" data-accept="${esc(a.id)}">Accept</button>
            <button class="btn btn-ghost btn-sm" data-reject="${esc(a.id)}">Reject</button>
          </div>
        </article>`
              )
              .join('')}</div>`
          : empty('No applications yet.')
      }
    </div>
    <p><a class="link-quiet" href="#/business/jobs">Back to my listings</a></p>`;

  return {
    title: job.title,
    html: shell(`/business/jobs/${id}`, 'Listing and applicants', '', body),
    mount() {
      const close = document.getElementById('close-job');
      if (close) {
        close.addEventListener('click', async () => {
          busy(close, true, 'Closing…');
          try {
            await api.patch(`/jobs/${id}`, { status: 'closed' });
            toast('Listing closed', 'success');
            await ctx.refresh();
          } catch (error) {
            toast(error.message, 'error');
            busy(close, false);
          }
        });
      }
      const decide = async (applicationId, status, button) => {
        busy(button, true, 'Saving…');
        try {
          await api.patch(`/applications/${applicationId}`, { status });
          toast(`Application ${status}`, 'success');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      };
      for (const button of document.querySelectorAll('[data-accept]')) {
        button.addEventListener('click', () => decide(button.dataset.accept, 'accepted', button));
      }
      for (const button of document.querySelectorAll('[data-reject]')) {
        button.addEventListener('click', () => decide(button.dataset.reject, 'rejected', button));
      }
    }
  };
}

async function workers(ctx) {
  const categories = (ctx.meta && ctx.meta.categories) || [];
  const first = await api.get('/workers');
  const renderList = (list) =>
    list.length
      ? `<div class="list-stack">${list
          .map(
            (w) => `<article class="job-card">
        <header>
          <div><h3>${esc(w.full_name)}</h3>
            <div class="job-meta"><span class="tag">${esc(w.category)}</span>${w.city ? `<span>${esc(w.city)}</span>` : ''}<span>${esc(w.experience_years || 0)} yrs</span></div>
          </div>
          <div>${w.available ? '<span class="badge badge-new">Available</span>' : '<span class="badge badge-old">Unavailable</span>'}</div>
        </header>
        ${w.bio ? `<p class="muted" style="margin:8px 0 0">${esc(w.bio)}</p>` : ''}
        ${(w.skills || []).length ? `<div style="margin-top:8px">${w.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
        <div class="btn-row">
          <a class="btn btn-navy btn-sm" href="#/agreements/new?worker=${esc(w.id)}">Create agreement</a>
        </div>
      </article>`
          )
          .join('')}</div>`
      : empty('No workers match your search.');

  const body = `
    <form id="worker-filters" class="card">
      <div class="form-row two">
        <div class="field"><label for="q">Search</label><input id="q" name="q" placeholder="Name, skill or city" /></div>
        <div class="field"><label for="category">Category</label><select id="category" name="category"><option value="">All categories</option>${options(categories)}</select></div>
      </div>
      <button class="btn btn-navy btn-sm" type="submit">Search workers</button>
    </form>
    <div id="worker-list">${renderList(first.workers || [])}</div>`;

  return {
    title: 'Find workers',
    html: shell('/business/workers', 'Find workers', 'Search by skill and send an agreement directly.', body),
    mount() {
      const form = document.getElementById('worker-filters');
      const list = document.getElementById('worker-list');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const params = new URLSearchParams();
        const data = formObject(form);
        if (data.q) params.set('q', data.q);
        if (data.category) params.set('category', data.category);
        list.innerHTML = '<div class="empty">Loading…</div>';
        try {
          const res = await api.get(`/workers?${params.toString()}`);
          list.innerHTML = renderList(res.workers || []);
        } catch (error) {
          list.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`;
        }
      });
    }
  };
}

async function applications(ctx) {
  const { applications: list } = await api.get('/applications');
  const body = list.length
    ? `<div class="list-stack">${list
        .map(
          (a) => `<article class="job-card">
        <header>
          <div><h3>${esc(a.worker_name)}</h3>
            <div class="job-meta"><span class="tag">${esc(a.worker_category || '—')}</span><span>${esc(a.job_title)}</span><span>${esc(fmtDate(a.created_at))}</span>${a.worker_phone ? `<a class="link-quiet" href="tel:${esc(a.worker_phone)}">${esc(a.worker_phone)}</a>` : ''}</div>
          </div>
          <div>${pill(a.status)}</div>
        </header>
        ${a.message ? `<p class="muted" style="margin:8px 0 0">${esc(a.message)}</p>` : ''}
        <div class="btn-row">
          <a class="btn btn-navy btn-sm" href="#/agreements/new?worker=${esc(a.worker_id)}">Create agreement</a>
          <button class="btn btn-ghost btn-sm" data-accept="${esc(a.id)}">Accept</button>
          <button class="btn btn-ghost btn-sm" data-reject="${esc(a.id)}">Reject</button>
        </div>
      </article>`
        )
        .join('')}</div>`
    : empty('No applications received yet.');

  return {
    title: 'Applications',
    html: shell('/business/applications', 'Worker applications', 'Accept a worker, then create an agreement.', body),
    mount() {
      const decide = async (id, status, button) => {
        busy(button, true, 'Saving…');
        try {
          await api.patch(`/applications/${id}`, { status });
          toast(`Application ${status}`, 'success');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      };
      for (const button of document.querySelectorAll('[data-accept]')) {
        button.addEventListener('click', () => decide(button.dataset.accept, 'accepted', button));
      }
      for (const button of document.querySelectorAll('[data-reject]')) {
        button.addEventListener('click', () => decide(button.dataset.reject, 'rejected', button));
      }
    }
  };
}

async function agreements(ctx) {
  const { agreements: list } = await api.get('/agreements');
  const body = `
    <div class="btn-row" style="margin-bottom:12px"><a class="btn btn-navy" href="#/agreements/new">New agreement</a></div>
    ${
      list.length
        ? `<div class="list-stack">${list
            .map(
              (a) => `<article class="job-card">
          <header>
            <div><h3>${esc(a.ref)}</h3>
              <div class="job-meta"><span>${esc(a.worker.full_name)}</span><span>${esc(fmtDate(a.created_at))}</span></div>
            </div>
            <div>${pill(a.status)}</div>
          </header>
          <p class="muted" style="margin:8px 0 0">${esc(String(a.scope || '').slice(0, 150))}</p>
          <div class="btn-row">
            <a class="btn btn-navy btn-sm" href="#/agreements/${esc(a.id)}">Open agreement</a>
            ${a.can_sign ? '<span class="badge badge-pending">Your signature needed</span>' : ''}
          </div>
        </article>`
            )
            .join('')}</div>`
        : empty('No agreements yet.')
    }`;

  return { title: 'Agreements', html: shell('/business/agreements', 'Agreements', 'Both parties sign on screen; the PDF can be saved or printed.', body) };
}

async function invoices(ctx) {
  const { invoices: list } = await api.get('/invoices');
  const body = `
    <div class="btn-row" style="margin-bottom:12px"><a class="btn btn-primary" href="#/invoices/new">Create invoice</a></div>
    ${
      list.length
        ? invoiceList(list)
        : empty('No invoices yet.')
    }`;

  return { title: 'Invoices', html: shell('/business/invoices', 'Invoices', 'VAT is calculated automatically on the server.', body) };
}

async function profile(ctx) {
  const profile = ctx.user.profile || {};
  const body = `<div class="card">
    <form id="business-profile-form">
      <div class="form-row two">
        <div class="field"><label for="company_name">Company name</label><input id="company_name" name="company_name" value="${esc(profile.company_name || '')}" maxlength="160" /></div>
        <div class="field"><label for="contact_name">Contact person</label><input id="contact_name" name="contact_name" value="${esc(profile.contact_name || ctx.user.full_name)}" maxlength="120" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" value="${esc(profile.phone || ctx.user.phone || '')}" maxlength="40" /></div>
        <div class="field"><label for="country">Country</label><input id="country" name="country" value="${esc(profile.country || '')}" maxlength="80" /></div>
      </div>
      <div class="field"><label for="address">Address</label><input id="address" name="address" value="${esc(profile.address || '')}" maxlength="300" /></div>
      <div class="field"><label for="website">Website (optional)</label><input id="website" name="website" value="${esc(profile.website || '')}" maxlength="200" /></div>
      <div class="field"><label for="about">About the business</label><textarea id="about" name="about" maxlength="1000">${esc(profile.about || '')}</textarea></div>
      <button class="btn btn-navy" type="submit">Save profile</button>
    </form>
  </div>`;

  return {
    title: 'Company profile',
    html: shell('/business/profile', 'Company profile', 'This information appears on agreements and invoices.', body),
    mount() {
      const form = document.getElementById('business-profile-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Saving…');
        try {
          const res = await api.patch('/auth/profile', formObject(form));
          ctx.setUser(res.user);
          toast('Profile saved', 'success');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}

export async function view(ctx) {
  const section = ctx.parts[1] || 'overview';
  if (section === 'overview') return overview(ctx);
  if (section === 'jobs') {
    if (ctx.parts[2] === 'new') return newJob(ctx);
    if (ctx.parts[2]) return jobDetail(ctx, ctx.parts[2]);
    return jobs(ctx);
  }
  if (section === 'workers') return workers(ctx);
  if (section === 'applications') return applications(ctx);
  if (section === 'agreements') return agreements(ctx);
  if (section === 'invoices') return invoices(ctx);
  if (section === 'profile') return profile(ctx);
  return { title: 'Not found', html: shell('/business', 'Not found', '', empty('That page does not exist.')) };
}
