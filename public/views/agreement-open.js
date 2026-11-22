/**
 * Open agreement builder — available to workers and businesses at any time.
 *
 * Modelled on the invoice flow: WORKBRIDGE header, the other party's details,
 * the agreed terms, an optional stamp or letterhead photo (camera or gallery),
 * a preview, then send. The other party accepts or rejects it afterwards.
 */
import { api } from '../api.js';
import { esc, toast, busy, readImageFile, fmtDate } from '../ui.js';

const SUPPORT_EMAIL = 'Limuzin@196vip.si';

function currencyOptions(ctx) {
  const meta = ctx.meta || {};
  const enabled = (meta.currency && meta.currency.enabled) || [];
  const fallback = meta.default_currency ? [meta.default_currency] : [];
  const codes = enabled.length ? enabled : fallback;
  return codes
    .map((code) => `<option value="${esc(code)}" ${code === meta.default_currency ? 'selected' : ''}>${esc(code)}</option>`)
    .join('');
}

export async function openAgreementView(ctx) {
  const { agreements } = await api.get('/agreements');
  const waiting = agreements.filter(
    (agreement) => agreement.acceptance_status === 'pending' && agreement.created_by !== ctx.user.id
  );

  const body = `
    <div class="container" style="max-width:820px">
      <div class="section-head">
        <div>
          <h1>New agreement</h1>
          <p class="muted" style="margin:0">Create an agreement whenever you need one — no waiting for the other side to send it first.</p>
        </div>
        <a class="btn btn-ghost btn-sm" href="#/${ctx.user.role}/agreements">My agreements</a>
      </div>

      ${
        waiting.length
          ? `<div class="card" style="margin-bottom:14px">
              <h3 style="margin-top:0">Waiting for your response</h3>
              ${waiting
                .map(
                  (agreement) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap">
                    <div>
                      <strong>${esc(agreement.ref)}</strong>
                      <p class="muted" style="margin:2px 0 0">${esc(String(agreement.scope).slice(0, 80))}</p>
                    </div>
                    <a class="btn btn-navy btn-sm" href="#/agreements/${esc(agreement.id)}">Review</a>
                  </div>`
                )
                .join('')}
            </div>`
          : ''
      }

      <form id="agreement-form" class="card">
        <h3 style="margin-top:0">1. The other party</h3>
        <div class="field"><label for="ag-name">Name / company</label><input id="ag-name" name="counterparty_name" required /></div>
        <div class="split">
          <div class="field"><label for="ag-phone">Phone</label><input id="ag-phone" name="counterparty_phone" inputmode="tel" /></div>
          <div class="field"><label for="ag-email">Email (so they can accept it in the app)</label><input id="ag-email" name="counterparty_email" type="email" /></div>
        </div>

        <h3>2. Work and terms</h3>
        <div class="field"><label for="ag-scope">Work description</label><textarea id="ag-scope" name="scope" rows="3" required></textarea></div>
        <div class="field"><label for="ag-terms">Agreed terms</label><textarea id="ag-terms" name="terms" rows="4" required></textarea></div>
        <div class="split">
          <div class="field"><label for="ag-start">Start date</label><input id="ag-start" name="start_date" type="date" /></div>
          <div class="field"><label for="ag-end">End date</label><input id="ag-end" name="end_date" type="date" /></div>
        </div>
        <div class="split">
          <div class="field"><label for="ag-pay">Agreed amount</label><input id="ag-pay" name="pay_amount" type="number" min="0" step="0.01" /></div>
          <div class="field"><label for="ag-period">Per</label>
            <select id="ag-period" name="pay_period">
              ${((ctx.meta && ctx.meta.pay_periods) || ['hour', 'day', 'week', 'month', 'project'])
                .map((period) => `<option value="${esc(period)}">${esc(period)}</option>`)
                .join('')}
            </select>
          </div>
        </div>
        <div class="field"><label for="ag-currency">Currency</label>
          <select id="ag-currency" name="currency">${currencyOptions(ctx)}</select>
        </div>

        <h3>3. Stamp or letterhead (optional)</h3>
        <div class="split">
          <div class="field"><label for="ag-stamp">Company stamp — upload or take a photo</label><input id="ag-stamp" name="stamp_image" type="file" accept="image/*" capture="environment" /></div>
          <div class="field"><label for="ag-letterhead">Letterhead — upload or take a photo</label><input id="ag-letterhead" name="letterhead_image" type="file" accept="image/*" capture="environment" /></div>
        </div>

        <div class="btn-row">
          <button type="button" class="btn btn-ghost" id="ag-preview">Preview</button>
          <button type="submit" class="btn btn-navy">Send agreement</button>
        </div>
        <p class="muted" style="margin:8px 0 0">After sending, both parties sign on screen and can save the PDF. Support: ${SUPPORT_EMAIL}</p>
      </form>

      <div id="ag-preview-box" hidden></div>
    </div>`;

  return {
    title: 'New agreement',
    html: body,
    mount() {
      const form = document.getElementById('agreement-form');
      const previewBox = document.getElementById('ag-preview-box');
      const values = () => ({
        counterparty_name: form.counterparty_name.value.trim(),
        counterparty_phone: form.counterparty_phone.value.trim(),
        counterparty_email: form.counterparty_email.value.trim(),
        scope: form.scope.value.trim(),
        terms: form.terms.value.trim(),
        start_date: form.start_date.value,
        end_date: form.end_date.value,
        pay_amount: Number(form.pay_amount.value || 0),
        pay_period: form.pay_period.value,
        currency: form.currency.value
      });

      document.getElementById('ag-preview').addEventListener('click', () => {
        const value = values();
        if (!value.scope || !value.terms) {
          toast('Add the work description and the agreed terms first.', 'error');
          return;
        }
        previewBox.hidden = false;
        previewBox.innerHTML = `<div class="card" style="margin-top:14px">
          <div style="text-align:center;margin-bottom:10px">
            <strong style="font-size:1.1rem">WORKBRIDGE</strong>
            <p class="muted" style="margin:2px 0 0">Agreement preview</p>
          </div>
          <p><strong>Other party:</strong> ${esc(value.counterparty_name || '—')}${value.counterparty_phone ? ` · ${esc(value.counterparty_phone)}` : ''}</p>
          <p><strong>Work:</strong> ${esc(value.scope)}</p>
          <p><strong>Terms:</strong> ${esc(value.terms)}</p>
          <p><strong>Period:</strong> ${value.start_date ? esc(fmtDate(value.start_date)) : '—'} → ${value.end_date ? esc(fmtDate(value.end_date)) : '—'}</p>
          <p><strong>Amount:</strong> ${esc(String(value.pay_amount))} ${esc(value.currency)} per ${esc(value.pay_period)}</p>
          <p class="muted">Signatures are collected after sending, on both parties' devices.</p>
        </div>`;
        previewBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        busy(submit, true, 'Sending…');
        try {
          const value = values();
          const stampInput = document.getElementById('ag-stamp');
          const letterheadInput = document.getElementById('ag-letterhead');
          const stamp = stampInput.files[0] ? await readImageFile(stampInput.files[0]) : null;
          const letterhead = letterheadInput.files[0] ? await readImageFile(letterheadInput.files[0]) : null;
          const result = await api.post('/agreements/open', {
            ...value,
            stamp_image: stamp,
            letterhead_image: letterhead
          });
          toast(`Agreement ${result.agreement.ref} created.`, 'ok');
          location.hash = `#/agreements/${result.agreement.id}`;
        } catch (error) {
          toast(error.message, 'error');
          busy(submit, false);
        }
      });
    }
  };
}
