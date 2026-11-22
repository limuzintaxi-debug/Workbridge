import { api } from '../api.js';
import { esc, toast, busy, formObject } from '../ui.js';
import { t } from '../i18n.js';

/**
 * Account lifecycle screens: password recovery, first-run administrator
 * creation, and signed-in account management (password change).
 */

export async function resetPasswordView(ctx) {
  const token = ctx.query.get('token') || '';
  const email = ctx.query.get('email') || '';

  if (token) {
    const html = `<div class="container" style="max-width:560px">
      <div class="card">
        <h1>${esc(t('auth.resetTitle'))}</h1>
        <form id="reset-form" novalidate>
          <div class="field"><label for="password">${esc(t('auth.newPassword'))}</label>
            <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password" /></div>
          <div class="field"><label for="confirm">${esc(t('auth.confirmPassword'))}</label>
            <input id="confirm" name="confirm" type="password" required minlength="8" autocomplete="new-password" /></div>
          <button class="btn btn-navy btn-block" type="submit">${esc(t('auth.setPassword'))}</button>
        </form>
        <div id="reset-result" style="margin-top:10px"></div>
      </div>
    </div>`;

    return {
      title: t('auth.resetTitle'),
      html,
      mount() {
        const form = document.getElementById('reset-form');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const values = formObject(form);
          if (values.password !== values.confirm) {
            toast('Passwords do not match.', 'error');
            return;
          }
          const button = form.querySelector('button[type="submit"]');
          busy(button, true, 'Saving…');
          try {
            await api.post('/auth/reset-password', { token, password: values.password });
            document.getElementById('reset-result').innerHTML =
              '<div class="notice notice-navy">Password updated. You can now sign in.</div>';
            toast('Password updated', 'success');
            setTimeout(() => {
              location.hash = '#/worker/signin';
            }, 1200);
          } catch (error) {
            toast(error.message, 'error');
            busy(button, false);
          }
        });
      }
    };
  }

  const html = `<div class="container" style="max-width:560px">
    <div class="card">
      <h1>${esc(t('auth.resetTitle'))}</h1>
      <p class="muted">${esc(t('auth.resetSent'))}</p>
      <form id="forgot-form" novalidate>
        <div class="field"><label for="email">${esc(t('auth.email'))}</label>
          <input id="email" name="email" type="email" required value="${esc(email)}" autocomplete="email" /></div>
        <button class="btn btn-navy btn-block" type="submit">${esc(t('auth.resetSend'))}</button>
      </form>
      <div id="forgot-result" style="margin-top:10px"></div>
      <div class="btn-row" style="margin-top:12px"><a class="link-quiet" href="#/">Back to home</a></div>
    </div>
  </div>`;

  return {
    title: t('auth.resetTitle'),
    html,
    mount() {
      const form = document.getElementById('forgot-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Sending…');
        try {
          const res = await api.post('/auth/forgot-password', formObject(form));
          const box = document.getElementById('forgot-result');
          const typedEmail = String(formObject(form).email || '').trim();
          // A green message is only shown when the server confirms an email was
          // actually handed to the provider. Anything else states the real reason.
          if (res.email_sent) {
            box.innerHTML = `<div class="notice">Reset link sent to <strong>${esc(
              typedEmail
            )}</strong>. It works once and expires in 30 minutes. If it does not arrive within a few minutes, check the spam folder.</div>`;
            toast('Reset link sent', 'success');
          } else if (res.account_found === false) {
            box.innerHTML = `<div class="notice" style="border-color:#c62828;color:#c62828">No WORKBRIDGE account uses <strong>${esc(
              typedEmail
            )}</strong>, so no email was sent. Enter the exact address you registered with, or create an account.</div>`;
            toast('No account uses that email', 'error');
          } else {
            box.innerHTML = `<div class="notice">${esc(
              res.message || 'Check your inbox for the reset link.'
            )}</div>`;
          }
          if (res.reset_url) {
            box.innerHTML += `<p class="sig-hint">Development helper — open your reset link: <a href="${esc(
              res.reset_url
            )}">${esc(res.reset_url)}</a></p>`;
          }
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(button, false);
        }
      });
    }
  };
}

export async function setupView() {
  let status;
  try {
    status = await api.get('/setup/status');
  } catch (error) {
    return { title: 'Setup', html: `<div class="container"><div class="notice notice-danger">${esc(error.message)}</div></div>` };
  }
  if (!status.setup_required) return { redirect: '#/admin/signin' };

  const html = `<div class="container" style="max-width:600px">
    <div class="card">
      <h1>Create the administrator account</h1>
      <p class="muted">This page is only available until the first administrator exists. No public administrator registration is offered anywhere else.</p>
      <div class="notice notice-navy">Storage: <strong>${esc(status.persistence_driver)}</strong> · Authentication: <strong>${esc(status.auth_driver)}</strong></div>
      <form id="setup-form" novalidate style="margin-top:12px">
        <div class="field"><label for="full_name">Full name</label><input id="full_name" name="full_name" required maxlength="120" /></div>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="160" autocomplete="email" /></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="10" autocomplete="new-password" /></div>
        ${
          status.setup_token_required
            ? '<div class="field"><label for="setup_token">Setup token</label><input id="setup_token" name="setup_token" required /><div class="hint">Provided by the platform owner in the server environment.</div></div>'
            : ''
        }
        <button class="btn btn-navy btn-block" type="submit">Create administrator</button>
      </form>
      <div id="setup-result" style="margin-top:10px"></div>
    </div>
  </div>`;

  return {
    title: 'Administrator setup',
    html,
    mount() {
      const form = document.getElementById('setup-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Creating…');
        try {
          await api.post('/setup/admin', formObject(form));
          toast('Administrator created', 'success');
          location.hash = '#/admin/signin';
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}

export async function accountView(ctx) {
  const user = ctx.user;
  if (!user) return { redirect: '#/' };

  const html = `<div class="container" style="max-width:640px">
    <h1>${esc(t('auth.account'))}</h1>
    <div class="card">
      <h3>${esc(t('auth.account'))}</h3>
      <p><strong>${esc(user.full_name || '')}</strong></p>
      <p class="muted">${esc(user.email || '')} · ${esc(user.role || '')}</p>
      <p class="muted">${esc(t('common.status'))}: ${esc(user.status || '')}</p>
    </div>
    <div class="card">
      <h3>${esc(t('auth.changePassword'))}</h3>
      <form id="password-form" novalidate>
        <div class="field"><label for="current_password">${esc(t('auth.currentPassword'))}</label>
          <input id="current_password" name="current_password" type="password" required autocomplete="current-password" /></div>
        <div class="field"><label for="new_password">${esc(t('auth.newPassword'))}</label>
          <input id="new_password" name="new_password" type="password" required minlength="8" autocomplete="new-password" /></div>
        <div class="field"><label for="confirm_password">${esc(t('auth.confirmPassword'))}</label>
          <input id="confirm_password" name="confirm_password" type="password" required minlength="8" autocomplete="new-password" /></div>
        <button class="btn btn-navy" type="submit">${esc(t('auth.changePassword'))}</button>
      </form>
      <p class="sig-hint">Changing your password signs out other devices.</p>
    </div>
    <div class="card">
      <h3>${esc(t('common.language'))}</h3>
      <p class="muted">Switch between English and Arabic (right-to-left) from the language buttons at the top of every page.</p>
    </div>
  </div>`;

  return {
    title: t('auth.account'),
    html,
    mount() {
      const form = document.getElementById('password-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = formObject(form);
        if (values.new_password !== values.confirm_password) {
          toast('New passwords do not match.', 'error');
          return;
        }
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Saving…');
        try {
          await api.post('/auth/change-password', {
            current_password: values.current_password,
            new_password: values.new_password
          });
          toast('Password changed', 'success');
          form.reset();
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          busy(button, false);
        }
      });
    }
  };
}
