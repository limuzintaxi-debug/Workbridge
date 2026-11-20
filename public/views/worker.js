import { api } from '../api.js';
import { esc, toast, busy, formObject, ageBadge, pill, money, fmtDate, fmtDateTime, empty } from '../ui.js';
import { panelShell, jobCard, options, institutionsCard, statCards, invoiceList } from './common.js';

const TABS = [
  ['#/worker', 'Dashboard'],
  ['#/worker/jobs', 'Find Work'],
  ['#/worker/applications', 'Applications'],
  ['#/worker/agreements', 'Agreements'],
  ['#/worker/invoices', 'Invoices'],
  ['#/worker/notifications', 'Alerts'],
  ['#/worker/profile', 'Profile']
];

function shell(path, title, subtitle, body) {
  return panelShell({ title, subtitle, tabs: TABS, path, body });
}

async function approvedInstitutions() {
  try {
    return (await api.get('/institutions')).institutions || [];
  } catch {
    return [];
  }
}

async function overview(ctx) {
  const [jobsRes, appsRes, agrRes, invRes, notifRes, institutions, metaRes] = await Promise.all([
    api.get('/jobs?status=open'),
    api.get('/applications'),
    api.get('/agreements'),
    api.get('/invoices'),
    api.get('/notifications'),
    approvedInstitutions(),
    api.get('/meta')
  ]);
  const jobs = jobsRes.jobs || [];
  const apps = appsRes.applications || [];
  const profile = ctx.user.profile || {};
  const commission = (metaRes && metaRes.commission) || { enabled: false, rate: 0, payer: 'business' };

  const body = `
    ${statCards([
      ['Open listings', jobs.length],
      ['My applications', apps.length],
      ['Agreements', (agrRes.agreements || []).length],
      ['Invoices', (invRes.invoices || []).length]
    ])}
    <div class="split">
      <div>
        <div class="card">
          <div class="section-head"><h2>Newest work listings</h2><a class="link-quiet" href="#/worker/jobs">See all</a></div>
          <div class="list-stack">
            ${jobs.slice(0, 4).map((job) => jobCard(job, `<a class="btn btn-primary btn-sm" href="#/worker/jobs/${esc(job.id)}">View &amp; apply</a>`)).join('') || empty('No open listings right now.')}
          </div>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>My profile</h3>
          <dl class="kv">
            <dt>Name</dt><dd>${esc(ctx.user.full_name)}</dd>
            <dt>Category</dt><dd>${esc(profile.category || '—')}</dd>
            <dt>City</dt><dd>${esc(profile.city || '—')}</dd>
            <dt>Aqama</dt><dd>${esc(profile.aqama_masked || '—')}</dd>
            <dt>Platform commission</dt><dd>${commission.enabled ? `${commission.rate}% (paid by ${esc(commission.payer)})` : 'Not applicable'}</dd>
            <dt>Available</dt><dd>${profile.available ? 'Yes' : 'No'}</dd>
          </dl>
          <a class="btn btn-ghost btn-sm" href="#/worker/profile">Edit profile</a>
        </div>
        <div class="card">
          <h3>Notifications <span class="badge badge-24h">${notifRes.unread || 0}</span></h3>
          ${
            (notifRes.notifications || []).slice(0, 3).map((n) => `<p style="margin-bottom:8px"><strong>${esc(n.title)}</strong><br /><span class="muted">${esc(n.body)}</span></p>`).join('') ||
            '<p class="muted">No notifications yet.</p>'
          }
          <a class="link-quiet" href="#/worker/notifications">All notifications</a>
        </div>
        ${institutionsCard(institutions)}
      </div>
    </div>`;

  return { title: 'Worker dashboard', html: shell('/worker', 'Worker dashboard', `Signed in as ${ctx.user.full_name}`, body) };
}

async function jobList(ctx) {
  const categories = (ctx.meta && ctx.meta.categories) || [];
  const first = await api.get('/jobs?status=open');
  const jobs = first.jobs || [];

  const renderList = (list) =>
    list.length
      ? list.map((job) => jobCard(job, `<a class="btn btn-primary btn-sm" href="#/worker/jobs/${esc(job.id)}">View &amp; apply</a>`)).join('')
      : empty('No listings match your search.');

  const body = `
    <form id="filters" class="card">
      <div class="form-row two">
        <div class="field"><label for="q">Search</label><input id="q" name="q" placeholder="Title, description or location" /></div>
        <div class="field"><label for="category">Category</label><select id="category" name="category"><option value="">All categories</option>${options(categories)}</select></div>
      </div>
      <button class="btn btn-navy btn-sm" type="submit">Search listings</button>
    </form>
    <div id="job-list" class="list-stack">${renderList(jobs)}</div>`;

  return {
    title: 'Find work',
    html: shell('/worker/jobs', 'Find work', 'Listings stay online until the business closes them.', body),
    mount() {
      const form = document.getElementById('filters');
      const list = document.getElementById('job-list');
      const run = async () => {
        const params = new URLSearchParams({ status: 'open' });
        const data = formObject(form);
        if (data.q) params.set('q', data.q);
        if (data.category) params.set('category', data.category);
        list.innerHTML = '<div class="empty">Loading…</div>';
        try {
          const res = await api.get(`/jobs?${params.toString()}`);
          list.innerHTML = renderList(res.jobs || []);
        } catch (error) {
          list.innerHTML = `<div class="notice notice-danger">${esc(error.message)}</div>`;
        }
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        run();
      });
    }
  };
}

async function jobDetail(ctx, id) {
  const { job } = await api.get(`/jobs/${id}`);
  const applied = job.my_application;
  const actions = applied
    ? `<div class="notice notice-navy">You applied on ${esc(fmtDateTime(applied.created_at))} — status: ${esc(applied.status)}.</div>`
    : job.status === 'open'
      ? `<form id="apply-form">
           <div class="field"><label for="message">Message to the business (optional)</label><textarea id="message" name="message" maxlength="1000" placeholder="Briefly describe your experience."></textarea></div>
           <button class="btn btn-primary" type="submit">Apply for this work</button>
         </form>`
      : '<div class="notice">This listing is closed.</div>';

  const body = `
    <div class="card">
      <div class="section-head">
        <div><h2 style="margin-bottom:4px">${esc(job.title)}</h2>
          <div class="job-meta"><span class="tag">${esc(job.category)}</span>${job.location ? `<span>${esc(job.location)}</span>` : ''}<span>Posted ${esc(fmtDate(job.created_at))}</span></div>
        </div>
        <div style="text-align:right">${ageBadge(job)}<div style="margin-top:4px">${pill(job.status)}</div></div>
      </div>
      <p><strong>${money(job.pay_amount, job.currency)} / ${esc(job.pay_period)}</strong></p>
      <h3>Description</h3>
      <p style="white-space:pre-wrap">${esc(job.description)}</p>
      ${job.requirements ? `<h3>Requirements</h3><p style="white-space:pre-wrap">${esc(job.requirements)}</p>` : ''}
      <h3>Business</h3>
      <p>${esc(job.business.company_name)}${job.business.country ? ` · ${esc(job.business.country)}` : ''}</p>
      ${job.business.phone ? `<p class="job-meta"><a class="link-quiet" href="tel:${esc(job.business.phone)}">Call ${esc(job.business.phone)}</a>${job.business.contact_name ? `<span>${esc(job.business.contact_name)}</span>` : ''}</p>` : ''}
    </div>
    <div class="card">${actions}</div>
    <p><a class="link-quiet" href="#/worker/jobs">Back to listings</a></p>`;

  return {
    title: job.title,
    html: shell(`/worker/jobs/${id}`, 'Listing details', '', body),
    mount() {
      const form = document.getElementById('apply-form');
      if (!form) return;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Applying…');
        try {
          await api.post(`/jobs/${id}/apply`, { message: form.elements.message.value });
          toast('Application sent', 'success');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
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
          <div><h3>${esc(a.job_title)}</h3>
            <div class="job-meta"><span class="tag">${esc(a.job_category || '—')}</span><span>Applied ${esc(fmtDate(a.created_at))}</span></div>
          </div>
          <div>${pill(a.status)}</div>
        </header>
        ${a.message ? `<p class="muted" style="margin:8px 0 0">${esc(a.message)}</p>` : ''}
        <div class="btn-row">
          <a class="btn btn-ghost btn-sm" href="#/worker/jobs/${esc(a.job_id)}">Open listing</a>
          ${a.status === 'pending' ? `<button class="btn btn-danger btn-sm" data-withdraw="${esc(a.id)}">Withdraw</button>` : ''}
        </div>
      </article>`
        )
        .join('')}</div>`
    : empty('You have not applied for any listings yet.');

  return {
    title: 'My applications',
    html: shell('/worker/applications', 'My applications', 'Track the status of every application.', body),
    mount() {
      for (const button of document.querySelectorAll('[data-withdraw]')) {
        button.addEventListener('click', async () => {
          busy(button, true, 'Withdrawing…');
          try {
            await api.patch(`/applications/${button.dataset.withdraw}`, { status: 'withdrawn' });
            toast('Application withdrawn', 'success');
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

async function notifications(ctx) {
  const { notifications: list, unread } = await api.get('/notifications');
  const body = `
    <div class="card">
      <div class="section-head">
        <h2>Notifications ${unread ? `<span class="badge badge-24h">${unread} new</span>` : ''}</h2>
        ${unread ? '<button class="btn btn-ghost btn-sm" id="read-all">Mark all as read</button>' : ''}
      </div>
      ${
        list.length
          ? `<div class="list-stack">${list
              .map(
                (n) => `<article class="card card-tight">
          <div class="section-head" style="margin-bottom:4px">
            <strong>${esc(n.title)}</strong>
            <span class="link-quiet">${esc(fmtDateTime(n.created_at))}</span>
          </div>
          <p class="muted" style="margin:0 0 6px">${esc(n.body)}</p>
          ${n.link ? `<a class="link-quiet" href="${esc(n.link)}">Open</a>` : ''}
          ${n.read_at ? '' : '<span class="badge badge-new" style="margin-left:8px">New</span>'}
        </article>`
              )
              .join('')}</div>`
          : empty('No notifications yet.')
      }
    </div>`;

  return {
    title: 'Notifications',
    html: shell('/worker/notifications', 'Notifications', 'New listings that match your category appear here.', body),
    mount() {
      const button = document.getElementById('read-all');
      if (!button) return;
      button.addEventListener('click', async () => {
        busy(button, true, 'Updating…');
        try {
          await api.post('/notifications/read-all');
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}

async function agreements(ctx) {
  const { agreements: list } = await api.get('/agreements');
  const body = list.length
    ? `<div class="list-stack">${list
        .map(
          (a) => `<article class="job-card">
        <header>
          <div><h3>${esc(a.ref)}</h3>
            <div class="job-meta"><span>${esc(a.business.company_name)}</span><span>${esc(fmtDate(a.created_at))}</span></div>
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
    : empty('No agreements yet. A business can send you an agreement from their panel.');

  return {
    title: 'Agreements',
    html: shell('/worker/agreements', 'Agreements', 'Sign on screen and save the PDF.', body)
  };
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

  return { title: 'Invoices', html: shell('/worker/invoices', 'Invoices', 'Create, save and print invoices.', body) };
}

async function profile(ctx) {
  const profile = ctx.user.profile || {};
  const categories = (ctx.meta && ctx.meta.categories) || [];
  const body = `<div class="card">
    <form id="profile-form">
      <div class="form-row two">
        <div class="field"><label for="full_name">Full name</label><input id="full_name" name="full_name" value="${esc(ctx.user.full_name)}" maxlength="120" /></div>
        <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" value="${esc(ctx.user.phone || '')}" maxlength="40" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="category">Work category / skill</label><select id="category" name="category">${options(categories, profile.category)}</select></div>
        <div class="field"><label for="city">City / area</label><input id="city" name="city" value="${esc(profile.city || '')}" maxlength="120" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="aqama">Aqama number (optional)</label><input id="aqama" name="aqama" maxlength="40" inputmode="numeric" placeholder="${esc(profile.aqama_masked || 'Not provided')}" /><div class="hint">Stored masked — only the last 4 characters are kept.</div></div>
        <div class="field"><label for="experience_years">Years of experience</label><input id="experience_years" name="experience_years" type="number" min="0" max="60" value="${esc(profile.experience_years || 0)}" /></div>
      </div>
      <div class="field"><label for="skills">Skills (comma separated)</label><input id="skills" name="skills" value="${esc((profile.skills || []).join(', '))}" maxlength="400" /></div>
      <div class="field"><label for="bio">Short introduction</label><textarea id="bio" name="bio" maxlength="1000">${esc(profile.bio || '')}</textarea></div>
      <div class="field"><label><input type="checkbox" name="available" ${profile.available ? 'checked' : ''} style="width:auto;min-height:0;margin-right:8px" />Available for work</label></div>
      <button class="btn btn-primary" type="submit">Save profile</button>
    </form>
  </div>`;

  return {
    title: 'Profile',
    html: shell('/worker/profile', 'My profile', 'Businesses see this information when they search for workers.', body),
    mount() {
      const form = document.getElementById('profile-form');
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
  if (section === 'jobs') return ctx.parts[2] ? jobDetail(ctx, ctx.parts[2]) : jobList(ctx);
  if (section === 'applications') return applications(ctx);
  if (section === 'notifications') return notifications(ctx);
  if (section === 'agreements') return agreements(ctx);
  if (section === 'invoices') return invoices(ctx);
  if (section === 'profile') return profile(ctx);
  return { title: 'Not found', html: shell('/worker', 'Not found', '', empty('That page does not exist.')) };
}
