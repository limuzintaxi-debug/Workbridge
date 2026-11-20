import { api } from './api.js';
import { esc, setDefaultCurrency } from './ui.js';
import { t, initLang, langSwitcher, bindLangSwitcher } from './i18n.js';
import * as pub from './views/public.js';
import * as worker from './views/worker.js';
import * as business from './views/business.js';
import * as admin from './views/admin.js';
import * as docs from './views/docs.js';
import * as account from './views/account.js';

const state = { user: null, meta: null };

const PANEL_HOME = { worker: '#/worker', business: '#/business', admin: '#/admin' };

const NAV = {
  worker: [
    ['#/worker', 'nav.dashboard'],
    ['#/worker/jobs', 'nav.findWork'],
    ['#/worker/applications', 'nav.applications'],
    ['#/worker/agreements', 'nav.agreements'],
    ['#/worker/invoices', 'nav.invoices'],
    ['#/worker/notifications', 'nav.alerts'],
    ['#/worker/profile', 'nav.profile']
  ],
  business: [
    ['#/business', 'nav.dashboard'],
    ['#/business/jobs', 'nav.listings'],
    ['#/business/jobs/new', 'nav.postWork'],
    ['#/business/workers', 'nav.workers'],
    ['#/business/applications', 'nav.applications'],
    ['#/business/agreements', 'nav.agreements'],
    ['#/business/invoices', 'nav.invoices'],
    ['#/business/profile', 'nav.profile']
  ],
  admin: [
    ['#/admin', 'nav.overview'],
    ['#/admin/users', 'nav.users'],
    ['#/admin/institutions', 'nav.institutions'],
    ['#/admin/listings', 'nav.listings'],
    ['#/admin/documents', 'nav.documents'],
    ['#/admin/commission', 'nav.commission'],
    ['#/admin/reports', 'nav.reports'],
    ['#/admin/settings', 'nav.settings']
  ]
};

const PUBLIC_NAV = [
  ['#/worker/signin', 'nav.findWork'],
  ['#/business/signin', 'nav.postWork'],
  ['#/institutions', 'nav.institutions'],
  ['#/support', 'nav.help']
];

function topbarHtml(path) {
  const role = state.user ? state.user.role : null;
  const links = role ? NAV[role] || [] : PUBLIC_NAV;
  const active = (href) => (`#${path}` === href || (`#${path}`).startsWith(`${href}/`) ? 'active' : '');
  return `<a class="brand" href="#/"><img src="/assets/logo.png" alt="" width="51" height="34" /><span class="brand-name">WORK<span>BRIDGE</span></span></a>
    <nav>
      ${links
        .map(([href, key]) => `<a href="${href}" class="${active(href)}">${esc(t(key))}</a>`)
        .join('')}
      ${langSwitcher()}
      ${
        role
          ? `<a href="#/account" class="${active('#/account')} hide-sm">${esc(t('auth.account'))}</a><span class="who">${esc(
              state.user.full_name
            )} · ${esc(role)}</span><button class="btn btn-ghost btn-sm" data-signout>${esc(t('nav.signOut'))}</button>`
          : `<a href="#/admin/signin">${esc(t('nav.admin'))}</a>`
      }
    </nav>`;
}

function footerHtml() {
  return `<div>WORKBRIDGE — ${esc(t('brand.tagline'))}</div>
    <div style="margin-top:6px">Help &amp; Support: <a href="mailto:Limuzin@196vip.si">Limuzin@196vip.si</a> · <a href="#/institutions">${esc(
      t('home.institutionTitle')
    )}</a></div>
    <div class="muted" style="margin-top:6px;font-size:0.75rem">© ${new Date().getFullYear()} WORKBRIDGE</div>`;
}

function commissionBanner() {
  if (!state.user) return '';
  const setting = (state.meta && state.meta.commission) || { rate: 0, payer: 'business' };
  const rate = Number(setting.rate) || 0;
  const payer =
    setting.payer === 'worker'
      ? 'worker pays'
      : setting.payer === 'both'
        ? 'worker & business pay'
        : 'business pays';
  return `<div class="commission-bar" id="commission-bar" data-rate="${rate}">
    <span>${esc(t('commission.current'))}: <strong>${rate}%</strong></span>
    <span class="muted">${rate > 0 ? esc(payer) : esc(t('commission.off'))}</span>
  </div>`;
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
    },
    setCommission: (commission) => {
      if (state.meta && commission) state.meta.commission = commission;
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
  if (path === '/reset-password') return account.resetPasswordView(ctx);
  if (path === '/setup') return account.setupView(ctx);

  const authMatch = path.match(/^\/(worker|business|admin)\/(signin|signup)$/);
  if (authMatch) {
    return pub.authView({ ...ctx, role: authMatch[1], mode: authMatch[2] });
  }

  if (parts[0] === 'worker') return guard('worker', ctx) || worker.view(ctx);
  if (parts[0] === 'business') return guard('business', ctx) || business.view(ctx);
  if (parts[0] === 'admin') return guard('admin', ctx) || admin.view(ctx);
  if (path === '/account') {
    return guardAny(['worker', 'business', 'admin'], ctx) || account.accountView(ctx);
  }
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
let pendingRender = false;
let renderedHash = null;

function currentHash() {
  return location.hash || '#/';
}

async function render() {
  // A navigation that arrives while a render is in flight must never be dropped:
  // queue it and run again as soon as the current render has finished.
  if (rendering) {
    pendingRender = true;
    return;
  }
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
      if (location.hash !== view.redirect) {
        location.hash = view.redirect;
      } else {
        // Already on the redirect target: record it so we do not loop.
        renderedHash = currentHash();
      }
      return;
    }

    const container = document.getElementById('view');
    container.innerHTML = `${commissionBanner()}${view.html || ''}`;
    document.getElementById('topbar').innerHTML = topbarHtml(path);
    bindLangSwitcher(document.getElementById('topbar'), () => render());
    document.getElementById('footer').innerHTML = footerHtml();
    document.title = view.title
      ? `${view.title} · WORKBRIDGE`
      : 'WORKBRIDGE — Booking • Agreement • Institutional & Social Support • Invoice Maker';
    renderedHash = currentHash();

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
    // Safety net: if the URL changed while we were rendering, render it now.
    if (pendingRender || currentHash() !== renderedHash) {
      pendingRender = false;
      render().catch(() => {});
    }
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
  const meta = state.meta || {};
  setDefaultCurrency((meta.currency && meta.currency.default) || meta.default_currency || 'SAR');
  initLang((meta.languages && meta.languages.default) || 'en');
}

window.addEventListener('hashchange', render);

// Clean paths (for example /setup) are served the app shell by the server, so map
// them onto the hash router to keep deep links working.
const DEEP_LINK = /^\/(setup|support|institutions|reset-password|account|worker|business|admin|agreements|invoices)(\/|$)/;

function normalizeDeepLink() {
  if (location.hash && location.hash !== '#') return;
  const pathname = location.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/' || !DEEP_LINK.test(pathname)) return;
  history.replaceState(null, '', `${pathname}#${pathname}`);
}

window.addEventListener('DOMContentLoaded', async () => {
  normalizeDeepLink();
  await Promise.all([loadSession(), loadMeta()]);
  await render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
