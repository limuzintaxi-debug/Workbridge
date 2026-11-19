import { api } from './api.js';
import { esc } from './ui.js';
import * as pub from './views/public.js';
import * as worker from './views/worker.js';
import * as business from './views/business.js';
import * as admin from './views/admin.js';
import * as docs from './views/docs.js';

const state = { user: null, meta: null };

const PANEL_HOME = { worker: '#/worker', business: '#/business', admin: '#/admin' };

const NAV = {
  worker: [
    ['#/worker', 'Dashboard'],
    ['#/worker/jobs', 'Find Work'],
    ['#/worker/applications', 'Applications'],
    ['#/worker/agreements', 'Agreements'],
    ['#/worker/invoices', 'Invoices'],
    ['#/worker/notifications', 'Alerts'],
    ['#/worker/profile', 'Profile']
  ],
  business: [
    ['#/business', 'Dashboard'],
    ['#/business/jobs', 'Listings'],
    ['#/business/jobs/new', 'Post Work'],
    ['#/business/workers', 'Workers'],
    ['#/business/applications', 'Applications'],
    ['#/business/agreements', 'Agreements'],
    ['#/business/invoices', 'Invoices'],
    ['#/business/profile', 'Profile']
  ],
  admin: [
    ['#/admin', 'Overview'],
    ['#/admin/users', 'Users'],
    ['#/admin/institutions', 'Institutions'],
    ['#/admin/listings', 'Listings'],
    ['#/admin/documents', 'Documents'],
    ['#/admin/reports', 'Reports'],
    ['#/admin/settings', 'Settings']
  ]
};

const PUBLIC_NAV = [
  ['#/worker/signin', 'Find Work'],
  ['#/business/signin', 'Post Work'],
  ['#/institutions', 'Institutions'],
  ['#/support', 'Help']
];

function topbarHtml(path) {
  const role = state.user ? state.user.role : null;
  const links = role ? NAV[role] || [] : PUBLIC_NAV;
  const active = (href) => (`#${path}` === href || (`#${path}`).startsWith(`${href}/`) ? 'active' : '');
  return `<a class="brand" href="#/"><img src="/assets/logo.svg" alt="" /><span class="brand-name">WORK<span>BRIDGE</span></span></a>
    <nav>
      ${links
        .map(([href, label]) => `<a href="${href}" class="${active(href)}">${esc(label)}</a>`)
        .join('')}
      ${
        role
          ? `<span class="who">${esc(state.user.full_name)} · ${esc(role)}</span><button class="btn btn-ghost btn-sm" data-signout>Sign out</button>`
          : `<a href="#/admin/signin">Admin</a>`
      }
    </nav>`;
}

function footerHtml() {
  return `<div>WORKBRIDGE — Booking • Agreement • Institutional &amp; Social Support • Invoice Maker</div>
    <div style="margin-top:6px">Help &amp; Support: <a href="mailto:Limuzin@196vip.si">Limuzin@196vip.si</a> · <a href="#/institutions">Institutional &amp; Social Support</a></div>
    <div class="muted" style="margin-top:6px;font-size:0.75rem">Prototype environment — demo data only.</div>`;
}

function ctxFor(parts, query) {
  return {
    user: state.user,
    meta: state.meta,
    parts,
    query,
    refresh: render,
    setUser: (user) => {
      state.user = user || null;
    }
  };
}

function guard(role, ctx) {
  if (!state.user) {
    return { redirect: role === 'admin' ? '#/admin/signin' : `#/${role}/signin` };
  }
  if (state.user.role !== role) {
    return { redirect: PANEL_HOME[state.user.role] || '#/' };
  }
  return null;
}

function guardAny(roles, ctx) {
  if (!state.user) return { redirect: '#/' };
  if (!roles.includes(state.user.role)) return { redirect: PANEL_HOME[state.user.role] || '#/' };
  return null;
}

async function route(path, parts, query) {
  const ctx = ctxFor(parts, query);

  if (path === '/') return pub.homeView(ctx);
  if (path === '/support') return pub.supportView(ctx);
  if (path === '/institutions') return pub.institutionsView(ctx);

  const authMatch = path.match(/^\/(worker|business|admin)\/(signin|signup)$/);
  if (authMatch) {
    return pub.authView({ ...ctx, role: authMatch[1], mode: authMatch[2] });
  }

  if (parts[0] === 'worker') return guard('worker', ctx) || worker.view(ctx);
  if (parts[0] === 'business') return guard('business', ctx) || business.view(ctx);
  if (parts[0] === 'admin') return guard('admin', ctx) || admin.view(ctx);
  if (parts[0] === 'agreements') {
    return guardAny(['worker', 'business', 'admin'], ctx) || docs.agreementView(ctx);
  }
  if (parts[0] === 'invoices') {
    return guardAny(['worker', 'business', 'admin'], ctx) || docs.invoiceView(ctx);
  }

  return {
    title: 'Page not found',
    html: `<div class="container"><div class="empty">Page not found. <a href="#/">Back to home</a></div></div>`
  };
}

function errorView(error) {
  const status = error && error.status;
  if (status === 401) {
    return {
      title: 'Sign in',
      html: `<div class="container"><div class="notice notice-danger">Please sign in to continue.</div>
        <p style="margin-top:12px"><a class="btn btn-navy" href="#/">Go to home</a></p></div>`
    };
  }
  return {
    title: 'Something went wrong',
    html: `<div class="container"><div class="notice notice-danger">${esc(
      (error && error.message) || 'Something went wrong.'
    )}</div></div>`
  };
}

let rendering = false;

async function render() {
  if (rendering) return;
  rendering = true;
  try {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathPart, queryPart] = raw.split('?');
    const path = pathPart || '/';
    const query = new URLSearchParams(queryPart || '');
    const parts = path.split('/').filter(Boolean);

    let view;
    try {
      view = await route(path, parts, query);
    } catch (error) {
      if (error && error.status === 401) {
        state.user = null;
        await loadSession();
      }
      view = errorView(error);
    }

    if (view && view.redirect) {
      if (location.hash !== view.redirect) location.hash = view.redirect;
      rendering = false;
      return;
    }

    const container = document.getElementById('view');
    container.innerHTML = view.html || '';
    document.getElementById('topbar').innerHTML = topbarHtml(path);
    document.getElementById('footer').innerHTML = footerHtml();
    document.title = view.title
      ? `${view.title} · WORKBRIDGE`
      : 'WORKBRIDGE — Booking • Agreement • Institutional & Social Support • Invoice Maker';

    for (const button of document.querySelectorAll('[data-signout]')) {
      button.addEventListener('click', async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          /* ignore */
        }
        state.user = null;
        location.hash = '#/';
        await render();
      });
    }

    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    if (typeof view.mount === 'function') await view.mount();
  } finally {
    rendering = false;
  }
}

async function loadSession() {
  try {
    const me = await api.get('/auth/me');
    state.user = me.user || null;
  } catch {
    state.user = null;
  }
}

async function loadMeta() {
  try {
    state.meta = await api.get('/meta');
  } catch {
    state.meta = {
      categories: ['Driver', 'Laborer', 'Electrician', 'Plumber', 'Other'],
      institution_types: ['NGO', 'Charity', 'Social Support Organization', 'Other'],
      pay_periods: ['hour', 'day', 'week', 'month', 'project'],
      support_email: 'Limuzin@196vip.si',
      commission: { enabled: false, rate: 0, payer: 'business' }
    };
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadSession(), loadMeta()]);
  await render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
