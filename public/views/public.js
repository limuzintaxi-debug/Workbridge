import { api } from '../api.js';
import { esc, toast, busy, formObject } from '../ui.js';
import { t } from '../i18n.js';
import { options, institutionsCard } from './common.js';

// Must stay in sync with PANEL_HOME in app.js: without the 'owner' entry the
// owner signs in through #/admin/signin and is dropped into the Primary Admin
// dashboard instead of the separate Owner panel.
const PANEL_HOME = { worker: '#/worker', business: '#/business', admin: '#/admin', owner: '#/owner' };
const SUPPORT_EMAIL = 'Limuzin@196vip.si';

export async function homeView(ctx) {
  let institutions = [];
  try {
    institutions = (await api.get('/institutions')).institutions || [];
  } catch {
    institutions = [];
  }

  const html = `
  <section class="hero">
    <img class="hero-logo" src="/assets/logo.png?v=2" alt="WORKBRIDGE logo" width="210" height="140" />
    <h1 class="hero-title">WORKBRIDGE</h1>
    <p class="tagline">Booking • Agreement • Institutional &amp; Social Support • Invoice Maker</p>
    <p class="hero-sub">Connecting Workers, Businesses &amp; Support Organizations</p>
    <p class="hero-actions">Find Work • Make Agreements • Create Invoices</p>
  </section>

  <div class="panels">
    <section class="panel panel-worker">
      <h2>WORKER</h2>
      <p>Find work, apply to listings, sign agreements and create invoices — all from your phone.</p>
      <div class="btn-row">
        <a class="btn btn-primary" href="#/worker/signup">Sign Up</a>
        <a class="btn btn-ghost" href="#/worker/signin">Sign In</a>
      </div>
    </section>
    <section class="panel panel-business">
      <h2>BUSINESS</h2>
      <p>Post work opportunities, find workers, manage agreements and issue invoices.</p>
      <div class="btn-row">
        <a class="btn btn-navy" href="#/business/signup">Sign Up</a>
        <a class="btn btn-ghost" href="#/business/signin">Sign In</a>
      </div>
    </section>
  </div>

  <div class="container" style="padding-bottom:0">
    <div class="grid grid-2">
      <div class="card">
        <h3>BOOK YOUR CAR</h3>
        <p class="muted">Small Car, Go, Business or VIP — send a booking in one simple step.</p>
        <a class="btn btn-navy btn-sm" href="#/book-car">Book your car</a>
      </div>
      <div class="card">
        <h3>WORKBRIDGE MALL</h3>
        <p class="muted">Vehicles to buy &amp; sell, and electronic shops with discount products.</p>
        <a class="btn btn-ghost btn-sm" href="#/mall">Open the Mall</a>
      </div>
    </div>
    <div class="grid grid-2">
      ${institutionsCard(institutions)}
      <div class="card">
        <h3>Institutional &amp; Social Support</h3>
        <p class="muted">Support organizations can register to be listed. Every registration is reviewed by an administrator before it appears.</p>
        <a class="btn btn-ghost btn-sm" href="#/institutions">Register an institution</a>
      </div>
    </div>
    <div class="card">
      <h3>Help &amp; Support</h3>
      <p class="muted">Questions about your account, listings, agreements or invoices? Email us at
        <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
      <a class="btn btn-ghost btn-sm" href="#/support">Open Help &amp; Support</a>
    </div>
    <p class="admin-entry"><a href="#/admin/signin">Admin Login</a> · <a href="#/admin-apply">Apply for admin access</a></p>
    <p class="hero-panels-note">Protected by role-based access — institutional contact details are never published.</p>
  </div>`;

  return { title: 'Home', html };
}

export async function supportView(ctx) {
  const email = (ctx.meta && ctx.meta.support_email) || SUPPORT_EMAIL;
  const html = `<div class="container">
    <h1>Help &amp; Support</h1>
    <div class="card">
      <h3>Contact us by email</h3>
      <p>Our only support channel is email: <a href="mailto:${esc(email)}">${esc(email)}</a></p>
      <p class="muted">We do not offer phone support or live chat. Please include your account email and a short description of the issue.</p>
      <a class="btn btn-navy" href="mailto:${esc(email)}?subject=WORKBRIDGE%20support%20request">Email support</a>
    </div>
    <div class="card">
      <h3>Common questions</h3>
      <p><strong>How do I find work?</strong> Create a worker account, complete your profile and open Find Work to see listings.</p>
      <p><strong>How long do listings stay online?</strong> Listings are never deleted automatically. They show New, 24 Hours Old, 48 Hours Old or Older, and stay visible until the business closes them or an administrator removes them.</p>
      <p><strong>How do agreements work?</strong> A business sends an agreement with the work description and terms. Both parties sign on screen, and the signed PDF can be saved or printed.</p>
      <p><strong>Can I use this on my phone?</strong> Yes — WORKBRIDGE is a Progressive Web App. Open it in your mobile browser and choose "Add to Home screen".</p>
    </div>
    <div class="card">
      <h3>Institutional &amp; Social Support</h3>
      <p class="muted">Register your organization for review. Only approved organization names are shown in the app; addresses and contact details are never published.</p>
      <a class="btn btn-ghost" href="#/institutions">Institution registration</a>
    </div>
  </div>`;
  return { title: 'Help & Support', html };
}

export async function institutionsView(ctx) {
  let institutions = [];
  try {
    institutions = (await api.get('/institutions')).institutions || [];
  } catch {
    institutions = [];
  }
  const types = (ctx.meta && ctx.meta.institution_types) || [
    'NGO',
    'Charity',
    'Social Support Organization',
    'Other'
  ];

  const html = `<div class="container">
    <h1>Institutional &amp; Social Support</h1>
    <p class="muted">Support organizations can register to be listed in WORKBRIDGE. Registrations are reviewed and approved by an administrator before they appear to workers and businesses. Addresses and contact details are never displayed publicly.</p>

    <div class="card">
      <h3>Approved institutions</h3>
      ${
        institutions.length
          ? `<div>${institutions
              .map((i) => `<span class="tag">${esc(i.name)} · ${esc(i.type)}</span>`)
              .join('')}</div>`
          : '<p class="muted">No institutions have been approved yet.</p>'
      }
    </div>

    <div class="card">
      <h3>Register an institution</h3>
      <p class="muted">Submitted registrations go to the Admin Panel for review.</p>
      <form id="institution-form" novalidate>
        <div class="form-row two">
          <div class="field"><label for="i-name">Institution name</label><input id="i-name" name="name" required maxlength="160" /></div>
          <div class="field"><label for="i-type">Type</label><select id="i-type" name="type">${options(types)}</select></div>
        </div>
        <div class="form-row two">
          <div class="field"><label for="i-contact">Contact person</label><input id="i-contact" name="contact_name" required maxlength="120" /></div>
          <div class="field"><label for="i-email">Email</label><input id="i-email" name="email" type="email" required maxlength="160" /></div>
        </div>
        <div class="form-row two">
          <div class="field"><label for="i-phone">Phone</label><input id="i-phone" name="phone" maxlength="40" /></div>
          <div class="field"><label for="i-address">Address (never shown publicly)</label><input id="i-address" name="address" maxlength="300" /></div>
        </div>
        <div class="field"><label for="i-description">What support do you offer?</label><textarea id="i-description" name="description" maxlength="2000"></textarea></div>
        <p class="sig-hint">Only approved institutions are listed. Addresses and contact details stay private.</p>
        <button class="btn btn-navy" type="submit">Submit for review</button>
      </form>
      <div id="institution-result" style="margin-top:10px"></div>
    </div>
  </div>`;

  return {
    title: 'Institutional & Social Support',
    html,
    mount() {
      const form = document.getElementById('institution-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Submitting…');
        try {
          const res = await api.post('/institutions', formObject(form));
          document.getElementById('institution-result').innerHTML =
            `<div class="notice">${esc(res.message || 'Registration submitted for review.')}</div>`;
          form.reset();
          toast('Registration submitted for review', 'success');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(button, false);
        }
      });
    }
  };
}

/* ------------------------------------------- dedicated administrator login */

const ADMIN_ROLES = ['owner', 'admin'];

async function ownerStatus() {
  const fallback = {
    setup_required: false,
    recovery_enabled: false
  };
  try {
    const status = await api.get('/auth/owner-status');
    return { ...fallback, ...(status || {}) };
  } catch {
    return fallback;
  }
}

function adminNotice(status) {
  return `<div class="notice notice-navy">
    Administrator accounts are created by the platform owner. There is no public admin registration and no
    admin sign-up link on this page.
    ${
      status.setup_required
        ? ' No administrator exists yet — <a href="#/setup">create the administrator account</a> to enable sign-in.'
        : ''
    }
  </div>`;
}

export async function adminSigninView(ctx) {
  if (ctx.user) return { redirect: PANEL_HOME[ctx.user.role] || '#/' };
  const status = await ownerStatus();

  const html = `<div class="container" style="max-width:640px">
    <div class="card">
      <img class="auth-logo" src="/assets/logo.png?v=2" alt="WORKBRIDGE logo" width="180" height="120" />
      <h1>Administrator sign in</h1>
      <p class="muted">Owner Admin and Primary Admin accounts only.</p>
      ${adminNotice(status)}
      <form id="admin-signin" novalidate style="margin-top:12px">
        <div class="field">
          <label for="admin-email">Administrator email</label>
          <input id="admin-email" name="email" type="email" required maxlength="160" autocomplete="username" />
        </div>
        <div class="field">
          <label for="admin-password">Password</label>
          <input id="admin-password" name="password" type="password" required autocomplete="current-password" />
        </div>
        <div class="notice" id="admin-signin-error" hidden></div>
        <button class="btn btn-navy btn-block" type="submit">Sign in as administrator</button>
      </form>
      <div class="btn-row" style="margin-top:12px">
        <a class="link-quiet" href="#/admin/recover">Owner password recovery</a>
        <a class="link-quiet" href="#/">Back to home</a>
      </div>
    </div>
  </div>`;

  const mount = () => {
    const form = document.getElementById('admin-signin');
    const errorBox = document.getElementById('admin-signin-error');
    if (!form) return;
    const showError = (message) => {
      if (!errorBox) return;
      errorBox.hidden = !message;
      errorBox.textContent = message || '';
      errorBox.style.borderColor = '#c62828';
      errorBox.style.color = '#c62828';
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError('');
      const button = form.querySelector('button[type="submit"]');
      const body = formObject(form);
      busy(button, true, 'Signing in…');
      try {
        const res = await api.post('/auth/login', { email: body.email, password: body.password });
        const role = res && res.user ? res.user.role : '';
        if (!ADMIN_ROLES.includes(role)) {
          // Never leave a worker or business session behind after an admin attempt.
          await api.post('/auth/logout').catch(() => {});
          ctx.setUser(null);
          showError('That account is not an administrator. Use the Worker or Business sign-in instead.');
          return;
        }
        ctx.setUser(res.user);
        toast('Signed in as administrator');
        location.hash = PANEL_HOME[role] || '#/admin';
      } catch (error) {
        showError((error && error.message) || 'Sign in failed. Check the administrator email and password.');
      } finally {
        busy(button, false);
      }
    });
  };

  return { title: 'Administrator sign in', html, mount };
}

/**
 * Private owner sign-in. Deliberately not linked from the public site, the admin
 * login page or the admin panel: the owner shares this URL only from the owner
 * panel. It accepts owner credentials only, so owner and admin authentication
 * remain separate entry points.
 */
export async function ownerSigninView(ctx) {
  if (ctx.user) return { redirect: PANEL_HOME[ctx.user.role] || '#/' };
  const html = `<div class="container" style="max-width:560px">
    <div class="card">
      <img class="auth-logo" src="/assets/logo.png?v=2" alt="WORKBRIDGE logo" width="180" height="120" />
      <h1>Owner sign in</h1>
      <p class="muted">Private owner access. This page is not linked from the public website and shows no owner details.</p>
      <form id="owner-signin" novalidate>
        <div class="field">
          <label for="owner-email">Owner email</label>
          <input id="owner-email" name="email" type="email" required maxlength="160" autocomplete="username" />
        </div>
        <div class="field">
          <label for="owner-password">Password</label>
          <input id="owner-password" name="password" type="password" required autocomplete="current-password" />
        </div>
        <div class="notice" id="owner-signin-error" hidden></div>
        <button class="btn btn-navy btn-block" type="submit">Sign in as owner</button>
      </form>
      <div class="btn-row" style="margin-top:12px"><a class="link-quiet" href="#/">Back to home</a></div>
    </div>
  </div>`;
  const mount = () => {
    const form = document.getElementById('owner-signin');
    const errorBox = document.getElementById('owner-signin-error');
    if (!form) return;
    const showError = (message) => {
      if (!errorBox) return;
      errorBox.hidden = !message;
      errorBox.textContent = message || '';
      errorBox.style.borderColor = '#c62828';
      errorBox.style.color = '#c62828';
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError('');
      const button = form.querySelector('button[type="submit"]');
      const body = formObject(form);
      busy(button, true, 'Signing in…');
      try {
        const res = await api.post('/auth/login', { email: body.email, password: body.password });
        const role = res && res.user ? res.user.role : '';
        if (role !== 'owner') {
          await api.post('/auth/logout').catch(() => {});
          ctx.setUser(null);
          showError('These credentials are not an owner account.');
          return;
        }
        ctx.setUser(res.user);
        toast('Signed in as owner');
        location.hash = PANEL_HOME.owner || '#/owner';
      } catch (error) {
        showError((error && error.message) || 'Sign in failed.');
      } finally {
        busy(button, false);
      }
    });
  };
  return { title: 'Owner sign in', html, mount };
}

export async function adminRecoverView(ctx) {
  if (ctx.user) return { redirect: PANEL_HOME[ctx.user.role] || '#/' };
  const status = await ownerStatus();

  const html = `<div class="container" style="max-width:640px">
    <div class="card">
      <h1>Owner password recovery</h1>
      <p class="muted">Set a new password for the Owner Admin or a Primary Admin account without depending on email delivery.</p>
      ${
        status.recovery_enabled
          ? `<div class="notice notice-navy">This form requires the server setup token. It is configured in the hosting
              environment as <code>SETUP_TOKEN</code>; ask the platform owner for its value. Every recovery is recorded in the audit log.</div>
             <form id="owner-recover" novalidate style="margin-top:12px">
               <div class="field">
                 <label for="recover-email">Administrator email</label>
                 <input id="recover-email" name="email" type="email" required maxlength="160" autocomplete="username" />
               </div>
               <div class="field">
                 <label for="recover-password">New password (minimum 10 characters)</label>
                 <input id="recover-password" name="password" type="password" required minlength="10" autocomplete="new-password" />
               </div>
               <div class="field">
                 <label for="recover-confirm">Repeat new password</label>
                 <input id="recover-confirm" name="confirm" type="password" required minlength="10" autocomplete="new-password" />
               </div>
               <div class="field">
                 <label for="recover-token">Owner recovery token</label>
                 <input id="recover-token" name="setup_token" type="password" required autocomplete="off" />
                 <div class="hint">The token is never stored in the application and cannot be read from this page.</div>
               </div>
               <div class="notice" id="owner-recover-error" hidden></div>
               <button class="btn btn-navy btn-block" type="submit">Set administrator password</button>
             </form>`
          : `<div class="notice">Owner recovery is disabled because the server has no setup token configured.
              Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for help, or configure
              <code>SETUP_TOKEN</code> in the hosting environment and reload this page.</div>`
      }
      <div class="btn-row" style="margin-top:12px">
        <a class="link-quiet" href="#/admin/signin">Back to administrator sign in</a>
      </div>
    </div>
  </div>`;

  const mount = () => {
    const form = document.getElementById('owner-recover');
    if (!form) return;
    const errorBox = document.getElementById('owner-recover-error');
    const showError = (message) => {
      if (!errorBox) return;
      errorBox.hidden = !message;
      errorBox.textContent = message || '';
      errorBox.style.borderColor = '#c62828';
      errorBox.style.color = '#c62828';
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError('');
      const button = form.querySelector('button[type="submit"]');
      const body = formObject(form);
      if (body.password !== body.confirm) {
        showError('The two passwords do not match.');
        return;
      }
      busy(button, true, 'Updating…');
      try {
        await api.post('/auth/owner-recover', {
          email: body.email,
          password: body.password,
          setup_token: body.setup_token
        });
        toast('Administrator password updated');
        location.hash = '#/admin/signin';
      } catch (error) {
        showError((error && error.message) || 'The administrator password could not be updated.');
      } finally {
        busy(button, false);
      }
    });
  };

  return { title: 'Owner password recovery', html, mount };
}

export async function authView(ctx) {
  const role = ctx.role;
  const mode = ctx.mode;
  if (role === 'admin' && mode === 'signup') return { redirect: '#/admin/signin' };

  const isSignup = mode === 'signup';
  const title = isSignup ? `Create your ${role} account` : `${role[0].toUpperCase()}${role.slice(1)} sign in`;

  // The administrator account is never created by public registration. When no
  // administrator exists yet, the sign-in page must point at the first-run form
  // instead of leaving the owner with a form that can never succeed.
  let setupRequired = false;
  if (role === 'admin' && !isSignup) {
    try {
      const status = await api.get('/setup/status');
      setupRequired = Boolean(status && status.setup_required);
    } catch (error) {
      setupRequired = false;
    }
  }
  const categories = (ctx.meta && ctx.meta.categories) || ['Driver', 'Laborer', 'Electrician', 'Plumber', 'Other'];

  const signupFields =
    role === 'worker'
      ? `<div class="form-row two">
           <div class="field"><label for="full_name">Full name</label><input id="full_name" name="full_name" required maxlength="120" autocomplete="name" /></div>
           <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" required maxlength="40" autocomplete="tel" /></div>
         </div>
         <div class="form-row two">
           <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="160" autocomplete="email" /></div>
           <div class="field"><label for="category">Work category / skill</label><select id="category" name="category" required>${options(categories)}</select></div>
         </div>
         <div class="form-row two">
           <div class="field"><label for="aqama">Aqama number (optional)</label><input id="aqama" name="aqama" maxlength="40" inputmode="numeric" /><div class="hint">Only the last 4 characters are stored, in masked form.</div></div>
           <div class="field"><label for="city">City / area</label><input id="city" name="city" maxlength="120" /></div>
         </div>
         <div class="form-row two">
           <div class="field"><label for="experience_years">Years of experience</label><input id="experience_years" name="experience_years" type="number" min="0" max="60" value="0" /></div>
           <div class="field"><label for="skills">Skills (comma separated)</label><input id="skills" name="skills" maxlength="400" placeholder="Heavy vehicle, Delivery routes" /></div>
         </div>
         <div class="field"><label for="bio">Short introduction</label><textarea id="bio" name="bio" maxlength="1000"></textarea></div>`
      : `<div class="form-row two">
           <div class="field"><label for="company_name">Company name</label><input id="company_name" name="company_name" required maxlength="160" /></div>
           <div class="field"><label for="full_name">Contact person</label><input id="full_name" name="full_name" required maxlength="120" /></div>
         </div>
         <div class="form-row two">
           <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="160" autocomplete="email" /></div>
           <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" required maxlength="40" autocomplete="tel" /></div>
         </div>
         <div class="form-row two">
           <div class="field"><label for="country">Country</label><input id="country" name="country" maxlength="80" /></div>
           <div class="field"><label for="address">Address</label><input id="address" name="address" maxlength="300" /></div>
         </div>
         <div class="field"><label for="website">Website (optional)</label><input id="website" name="website" maxlength="200" /></div>
         <div class="field"><label for="about">About the business</label><textarea id="about" name="about" maxlength="1000"></textarea></div>`;

  const html = `<div class="container" style="max-width:640px">
    <div class="card">
      <img class="auth-logo" src="/assets/logo.png?v=2" alt="WORKBRIDGE logo" width="180" height="120" />
      <h1>${esc(title)}</h1>
      ${
        role === 'admin'
          ? `<div class="notice notice-navy">Admin accounts are created by the platform owner. There is no public admin registration.${
              setupRequired
                ? ' No administrator exists yet — <a href="#/setup">create the administrator account</a> to enable sign-in.'
                : ''
            }</div>`
          : `<p class="muted">${isSignup ? 'All fields marked required must be completed.' : 'Sign in with the email and password you registered with.'}</p>`
      }
      <form id="auth-form" novalidate style="margin-top:12px">
        ${isSignup ? signupFields : ''}
        ${
          isSignup
            ? ''
            : `<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email" maxlength="160" /></div>`
        }
        <div class="field"><label for="password">${esc(t('auth.password'))}</label><input id="password" name="password" type="password" required minlength="8" autocomplete="${isSignup ? 'new-password' : 'current-password'}" /></div>
        ${isSignup ? '' : `<p style="margin:-6px 0 12px"><a class="link-quiet" href="#/reset-password">${esc(t('auth.forgot'))}</a></p>`}
        ${isSignup ? '' : ''}
        ${isSignup ? '<p class="sig-hint">Prototype: use test data only. Never enter real personal information.</p>' : ''}
        <button class="btn ${role === 'worker' ? 'btn-primary' : 'btn-navy'} btn-block" type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
      </form>
      <div class="btn-row" style="margin-top:12px">
        ${
          role === 'admin'
            ? '<a class="link-quiet" href="#/">Back to home</a>'
            : isSignup
              ? `<a class="link-quiet" href="#/${role}/signin">Already have an account? Sign in</a>`
              : `<a class="link-quiet" href="#/${role}/signup">Create a ${role} account</a>`
        }
      </div>
      ${
        isSignup || role === 'admin'
          ? ''
          : `<div class="notice" style="margin-top:14px">Signed in accounts are protected by role-based access. Passwords are stored only as salted hashes.</div>`
      }
    </div>
    ${
      role === 'admin'
        ? ''
        : `<p class="hero-panels-note">${role === 'worker' ? 'Looking to hire?' : 'Looking for work?'} <a href="#/${role === 'worker' ? 'business' : 'worker'}/signin">${role === 'worker' ? 'Business sign in' : 'Worker sign in'}</a></p>`
    }
  </div>`;

  return {
    title,
    html,
    mount() {
      const form = document.getElementById('auth-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, isSignup ? 'Creating account…' : 'Signing in…');
        try {
          const payload = { ...formObject(form), role };
          const res = await api.post(isSignup ? '/auth/register' : '/auth/login', payload);
          if (res.status === 'pending' || !res.user) {
            toast(res.message || t('auth.pending'), 'success');
            document
              .getElementById('auth-form')
              .insertAdjacentHTML('afterend', `<div class="notice notice-navy">${esc(res.message || t('auth.pending'))}</div>`);
            busy(button, false);
            form.reset();
            return;
          }
          ctx.setUser(res.user);
          toast(isSignup ? 'Account created' : 'Signed in', 'success');
          // Redirect by the role that was actually authenticated, not by the
          // route that submitted the form: the owner signs in through
          // #/admin/signin but belongs on the separate Owner panel.
          location.hash = PANEL_HOME[(res.user && res.user.role) || role] || PANEL_HOME[role];
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}
