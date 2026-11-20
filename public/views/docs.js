import { api } from '../api.js';
import { esc, toast, busy, formObject, money, fmtDate, fmtDateTime, pill, empty, mountSignaturePad, readImageFile } from '../ui.js';
import { options, signaturePadHtml } from './common.js';

const FALLBACK_CURRENCIES = ['SAR', 'USD', 'EUR', 'AED', 'GBP'];

function currencyCodes(ctx) {
  const meta = (ctx && ctx.meta) || {};
  const list = (meta.currency && meta.currency.enabled) || meta.currencies || [];
  const codes = list.map((entry) => (typeof entry === 'string' ? entry : entry && entry.code)).filter(Boolean);
  return codes.length ? codes : FALLBACK_CURRENCIES;
}

function defaultCurrencyCode(ctx) {
  const meta = (ctx && ctx.meta) || {};
  return (meta.currency && meta.currency.default) || meta.default_currency || 'SAR';
}

function currencyOptions(ctx, selected) {
  const active = selected || defaultCurrencyCode(ctx);
  return currencyCodes(ctx)
    .map((code) => `<option value="${esc(code)}"${code === active ? ' selected' : ''}>${esc(code)}</option>`)
    .join('');
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function fetchPdfBlob(path, filename) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) {
    let message = `Could not generate PDF (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.message) message = data.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  return { blob, file: new File([blob], filename, { type: 'application/pdf' }) };
}

async function downloadPdf(path, filename) {
  try {
    const { blob } = await fetchPdfBlob(path, filename);
    saveBlob(blob, filename);
    toast('PDF downloaded', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/**
 * Share the generated PDF through the device share sheet, which is how Android
 * and iOS offer WhatsApp, email and "Save to Files". Browsers without file
 * sharing fall back to saving the PDF and sharing a text summary.
 */
async function sharePdf(path, filename, text) {
  try {
    const { blob, file } = await fetchPdfBlob(path, filename);
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename, text });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    saveBlob(blob, filename);
    if (navigator.share) {
      await navigator.share({ title: filename, text }).catch(() => {});
    } else {
      toast('PDF saved to your device', 'success');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function shareByEmail(subject, body) {
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function shareByWhatsApp(body) {
  window.open(`https://wa.me/?text=${encodeURIComponent(body)}`, '_blank', 'noopener');
}

function partiesBlock(agreement) {
  const b = agreement.business || {};
  const w = agreement.worker || {};
  return `<div class="doc-parties">
    <div class="doc-party">
      <h4>Company / Contractor</h4>
      <p><strong>${esc(b.company_name || '—')}</strong></p>
      <p class="muted">${esc(b.contact_name || '')}${b.phone ? ` · ${esc(b.phone)}` : ''}</p>
      <p class="muted">${esc([b.address, b.country].filter(Boolean).join(', '))}</p>
    </div>
    <div class="doc-party">
      <h4>Worker</h4>
      <p><strong>${esc(w.full_name || '—')}</strong></p>
      <p class="muted">${esc(w.category || '')}${w.phone ? ` · ${esc(w.phone)}` : ''}</p>
      <p class="muted">${esc([w.city, w.country].filter(Boolean).join(', '))}</p>
    </div>
  </div>`;
}

function signatureBlock(agreement) {
  const signatures = agreement.signatures || {};
  const bothSigned = Boolean(signatures.business && signatures.worker);
  const rows = [
    ['business', 'Company / Contractor signature'],
    ['worker', 'Worker signature']
  ];
  return `<div class="sig-status ${bothSigned ? 'sig-status-done' : ''}">${
    bothSigned ? 'Signed by both parties' : 'Awaiting remaining signatures'
  }</div>
  <div class="doc-signatures">
    ${rows
      .map(([role, label]) => {
        const sig = signatures[role];
        return `<div class="doc-signature">
        <div class="sig-line">${sig ? `<img src="${esc(sig.signature)}" alt="Signature of ${esc(sig.name)}" />` : ''}</div>
        <div class="sig-meta">${esc(label)}</div>
        <div class="sig-hint">${sig ? `${esc(sig.name)} · ${esc(fmtDateTime(sig.signed_at))}` : 'Not signed yet'}</div>
      </div>`;
      })
      .join('')}
  </div>`;
}

export async function agreementView(ctx) {
  const id = ctx.parts[1];

  if (!id || id === 'new') return newAgreement(ctx);

  const { agreement } = await api.get(`/agreements/${id}`);
  const canSign = agreement.can_sign;

  const body = `<div class="doc-wrap">
    <div class="doc-toolbar no-print">
      <a class="btn btn-ghost btn-sm" href="#${ctx.user.role === 'admin' ? '/admin/documents' : `/${ctx.user.role}/agreements`}">Back</a>
      <button class="btn btn-primary btn-sm" data-pdf>Download PDF</button>
      <button class="btn btn-navy btn-sm" data-print>Print</button>
    </div>
    <article class="doc" id="print-area">
      <header class="doc-head">
        <img src="/assets/logo.png" alt="WORKBRIDGE" class="doc-logo" />
        <div class="doc-head-right">
          <div class="doc-title">WORK AGREEMENT</div>
          <div class="doc-ref">Ref: ${esc(agreement.ref)}</div>
          <div class="doc-ref">${esc(fmtDateTime(agreement.created_at))}</div>
        </div>
      </header>
      <div class="doc-status">${pill(agreement.status)}</div>
      ${partiesBlock(agreement)}
      <section class="doc-section">
        <h4>Work description</h4>
        <p>${esc(agreement.scope)}</p>
      </section>
      <section class="doc-section">
        <h4>Agreed terms</h4>
        <p>${esc(agreement.terms)}</p>
      </section>
      <section class="doc-section">
        <h4>Engagement details</h4>
        <table class="doc-table">
          <tbody>
            ${agreement.job ? `<tr><th>Listing</th><td>${esc(agreement.job.title)}</td></tr>` : ''}
            <tr><th>Pay</th><td>${money(agreement.pay_amount, agreement.currency)} per ${esc(agreement.pay_period)}</td></tr>
            ${agreement.start_date ? `<tr><th>Start date</th><td>${esc(fmtDate(agreement.start_date))}</td></tr>` : ''}
            ${agreement.end_date ? `<tr><th>End date</th><td>${esc(fmtDate(agreement.end_date))}</td></tr>` : ''}
          </tbody>
        </table>
      </section>
      <section class="doc-section">
        <h4>Electronic signatures</h4>
        ${signatureBlock(agreement)}
      </section>
      <footer class="doc-foot">
        <p>Generated by WORKBRIDGE. Agreement ${esc(agreement.ref)} — both parties can save or print this document.</p>
      </footer>
    </article>

    ${
      canSign
        ? `<div class="card no-print">
        <h3>Sign this agreement</h3>
        <p class="muted">Sign with your finger or stylus in the box below.</p>
        ${signaturePadHtml('agreement-signature', 'Your signature')}
        <button class="btn btn-primary" id="sign-agreement">Sign agreement</button>
      </div>`
        : ''
    }
  </div>`;

  return {
    title: `Agreement ${agreement.ref}`,
    html: body,
    mount() {
      const printButton = document.querySelector('[data-print]');
      if (printButton) printButton.addEventListener('click', () => window.print());
      const pdfButton = document.querySelector('[data-pdf]');
      if (pdfButton) {
        pdfButton.addEventListener('click', () =>
          downloadPdf(`/agreements/${id}/pdf`, `agreement-${agreement.ref}.pdf`)
        );
      }

      const canvas = document.getElementById('agreement-signature');
      if (canvas) {
        const pad = mountSignaturePad(canvas);
        const button = document.getElementById('sign-agreement');
        button.addEventListener('click', async () => {
          if (!pad.isDirty()) return toast('Please draw your signature first.', 'error');
          busy(button, true, 'Signing…');
          try {
            await api.post(`/agreements/${id}/sign`, {
              signature: pad.dataUrl(),
              name: ctx.user.full_name
            });
            toast('Agreement signed', 'success');
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

async function newAgreement(ctx) {
  const [workersRes, jobsRes] = await Promise.all([
    ctx.user.role === 'business' ? api.get('/workers') : Promise.resolve({ workers: [] }),
    api.get('/jobs?status=all').catch(() => ({ jobs: [] }))
  ]);
  const preselected = ctx.query.get('worker') || '';
  const workers = workersRes.workers || [];
  const jobs = (jobsRes.jobs || []).filter((job) => ctx.user.role !== 'business' || job.business.id === ctx.user.id);
  const periods = (ctx.meta && ctx.meta.pay_periods) || ['hour', 'day', 'week', 'month', 'project'];

  const workerField =
    ctx.user.role === 'business'
      ? `<div class="field"><label for="worker_id">Worker</label>
          <select id="worker_id" name="worker_id" required>
            <option value="">Select a worker</option>
            ${workers
              .map((w) => `<option value="${esc(w.id)}"${w.id === preselected ? ' selected' : ''}>${esc(w.full_name)} — ${esc(w.category)}</option>`)
              .join('')}
          </select>
          <p class="sig-hint">No worker listed? Ask them to register as a worker first.</p>
        </div>`
      : `<div class="field"><label for="business_id">Business</label>
          <select id="business_id" name="business_id" required>
            <option value="">Select a business</option>
            ${(ctx.meta && ctx.meta.businesses ? ctx.meta.businesses : [])
              .map((b) => `<option value="${esc(b.id)}">${esc(b.company_name)}</option>`)
              .join('')}
          </select>
          <p class="sig-hint">Businesses appear here once they have registered.</p>
        </div>`;

  const body = `<div class="card">
    <form id="agreement-form">
      ${workerField}
      <div class="field"><label for="job_id">Related listing (optional)</label>
        <select id="job_id" name="job_id">
          <option value="">No listing</option>
          ${jobs.map((job) => `<option value="${esc(job.id)}">${esc(job.title)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="scope">Work description</label><textarea id="scope" name="scope" required maxlength="4000" placeholder="What work will be performed?"></textarea></div>
      <div class="field"><label for="terms">Agreed terms</label><textarea id="terms" name="terms" required maxlength="4000" placeholder="Working hours, payment schedule, notice period, safety rules…"></textarea></div>
      <div class="form-row two">
        <div class="field"><label for="pay_amount">Pay amount</label><input id="pay_amount" name="pay_amount" type="number" min="0" step="0.01" value="0" /></div>
        <div class="field"><label for="currency">Currency</label><select id="currency" name="currency">${currencyOptions(ctx)}</select></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="pay_period">Pay period</label><select id="pay_period" name="pay_period">${options(periods)}</select></div>
        <div class="field"><label for="start_date">Start date</label><input id="start_date" name="start_date" type="date" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="end_date">End date</label><input id="end_date" name="end_date" type="date" /></div>
        <div class="field"><span class="sig-hint">Currency defaults to the platform setting and can be changed per agreement.</span></div>
      </div>
      <button class="btn btn-navy" type="submit">Create agreement</button>
    </form>
    <p class="sig-hint">A unique reference number and timestamp are generated automatically. Both parties then sign on screen.</p>
  </div>`;

  return {
    title: 'New agreement',
    html: body,
    mount() {
      const form = document.getElementById('agreement-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Creating…');
        try {
          const payload = formObject(form);
          const res = await api.post('/agreements', payload);
          toast('Agreement created', 'success');
          location.hash = `#/agreements/${res.agreement.id}`;
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}

export async function invoiceView(ctx) {
  const id = ctx.parts[1];
  if (!id || id === 'new') return newInvoice(ctx);

  const { invoice } = await api.get(`/invoices/${id}`);
  const items = invoice.items || [];
  const body = `<div class="doc-wrap">
    <div class="doc-toolbar no-print">
      <a class="btn btn-ghost btn-sm" href="#${ctx.user.role === 'admin' ? '/admin/documents' : `/${ctx.user.role}/invoices`}">Back</a>
      <button class="btn btn-primary btn-sm" data-pdf>Download PDF</button>
      <button class="btn btn-navy btn-sm" data-share>Share PDF</button>
      <button class="btn btn-ghost btn-sm" data-whatsapp>WhatsApp</button>
      <button class="btn btn-ghost btn-sm" data-email>Email</button>
      <button class="btn btn-ghost btn-sm" data-print>Print</button>
    </div>
    <article class="doc" id="print-area">
      <header class="doc-head">
        <img src="/assets/logo.png" alt="WORKBRIDGE" class="doc-logo" />
        <div class="doc-head-right">
          <div class="doc-title">INVOICE</div>
          <div class="doc-ref">No: ${esc(invoice.serial)}</div>
          <div class="doc-ref">${esc(fmtDate(invoice.created_at))}</div>
        </div>
      </header>
      <div class="doc-parties">
        <div class="doc-party">
          <h4>From</h4>
          <p><strong>${esc(invoice.issuer_name)}</strong></p>
          <p class="muted">${esc(invoice.issuer_phone || '')}</p>
          <p class="muted">${esc([invoice.issuer_address, invoice.issuer_country].filter(Boolean).join(', '))}</p>
        </div>
        <div class="doc-party">
          <h4>Bill to</h4>
          <p><strong>${esc(invoice.client_name)}</strong></p>
          <p class="muted">${esc(invoice.client_phone || '')}</p>
          <p class="muted">${esc([invoice.client_address, invoice.client_country].filter(Boolean).join(', '))}</p>
        </div>
      </div>
      <table class="doc-table doc-items">
        <thead><tr><th>Work / service</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${items
            .map(
              (item) => `<tr>
            <td>${esc(item.description)}</td>
            <td class="num">${esc(item.quantity)}</td>
            <td class="num">${money(item.unit_price, invoice.currency)}</td>
            <td class="num">${money(item.amount, invoice.currency)}</td>
          </tr>`
            )
            .join('')}
        </tbody>
        <tfoot>
          <tr><th colspan="3" class="num">Subtotal</th><td class="num">${money(invoice.subtotal, invoice.currency)}</td></tr>
          <tr><th colspan="3" class="num">VAT (${esc(invoice.vat_rate)}%)</th><td class="num">${money(invoice.vat_amount, invoice.currency)}</td></tr>
          <tr class="doc-total"><th colspan="3" class="num">Total</th><td class="num">${money(invoice.total, invoice.currency)}</td></tr>
        </tfoot>
      </table>
      ${invoice.notes ? `<section class="doc-section"><h4>Notes</h4><p>${esc(invoice.notes)}</p></section>` : ''}
      <div class="doc-signatures">
        <div class="doc-signature">
          <div class="sig-line">${invoice.signature ? `<img src="${esc(invoice.signature)}" alt="Signature" />` : ''}</div>
          <div class="sig-meta">Signature</div>
        </div>
        <div class="doc-signature">
          <div class="sig-line">${invoice.stamp ? `<img src="${esc(invoice.stamp)}" alt="Company stamp" />` : ''}</div>
          <div class="sig-meta">Company stamp</div>
        </div>
      </div>
      <footer class="doc-foot"><p>Generated by WORKBRIDGE — invoice ${esc(invoice.serial)}.</p></footer>
    </article>
  </div>`;

  return {
    title: `Invoice ${invoice.serial}`,
    html: body,
    mount() {
      const printButton = document.querySelector('[data-print]');
      if (printButton) printButton.addEventListener('click', () => window.print());
      const filename = `invoice-${invoice.serial}.pdf`;
      const summary = `WORKBRIDGE invoice ${invoice.serial} from ${invoice.issuer_name} — total ${invoice.total} ${invoice.currency}.`;
      const link = `${location.origin}/#/invoices/${invoice.id}`;

      const pdfButton = document.querySelector('[data-pdf]');
      if (pdfButton) {
        pdfButton.addEventListener('click', () => downloadPdf(`/invoices/${id}/pdf`, filename));
      }

      const shareButton = document.querySelector('[data-share]');
      if (shareButton) {
        shareButton.addEventListener('click', () =>
          sharePdf(`/invoices/${id}/pdf`, filename, `${summary} ${link}`)
        );
      }

      const whatsappButton = document.querySelector('[data-whatsapp]');
      if (whatsappButton) {
        whatsappButton.addEventListener('click', () => shareByWhatsApp(`${summary} ${link}`));
      }

      const emailButton = document.querySelector('[data-email]');
      if (emailButton) {
        emailButton.addEventListener('click', () =>
          shareByEmail(
            `WORKBRIDGE invoice ${invoice.serial}`,
            `${summary}\n\n${link}\n\nOpen the link to download or print the PDF.`
          )
        );
      }
    }
  };
}

async function newInvoice(ctx) {
  const profile = ctx.user.profile || {};
  const body = `<div class="card">
    <form id="invoice-form">
      <h3>Company details</h3>
      <div class="form-row two">
        <div class="field"><label for="issuer_name">Company name</label><input id="issuer_name" name="issuer_name" value="${esc(profile.company_name || ctx.user.full_name)}" maxlength="160" /></div>
        <div class="field"><label for="issuer_phone">Phone</label><input id="issuer_phone" name="issuer_phone" value="${esc(profile.phone || ctx.user.phone || '')}" maxlength="40" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="issuer_address">Address</label><input id="issuer_address" name="issuer_address" value="${esc(profile.address || '')}" maxlength="300" /></div>
        <div class="field"><label for="issuer_country">Country</label><input id="issuer_country" name="issuer_country" value="${esc(profile.country || '')}" maxlength="80" /></div>
      </div>

      <h3>Bill to</h3>
      <div class="form-row two">
        <div class="field"><label for="client_name">Client name</label><input id="client_name" name="client_name" required maxlength="160" /></div>
        <div class="field"><label for="client_phone">Client phone</label><input id="client_phone" name="client_phone" maxlength="40" /></div>
      </div>
      <div class="form-row two">
        <div class="field"><label for="client_address">Client address</label><input id="client_address" name="client_address" maxlength="300" /></div>
        <div class="field"><label for="client_country">Client country</label><input id="client_country" name="client_country" maxlength="80" /></div>
      </div>

      <h3>Work / services</h3>
      <div class="invoice-rows" id="invoice-rows">
        ${[0, 1, 2]
          .map(
            () => `<div class="invoice-row">
          <div class="field"><label>Description</label><input name="description" maxlength="200" placeholder="Service description" /></div>
          <div class="field"><label>Qty</label><input name="quantity" type="number" min="0" step="0.01" value="1" /></div>
          <div class="field"><label>Unit price</label><input name="unit_price" type="number" min="0" step="0.01" value="0" /></div>
        </div>`
          )
          .join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="add-row">Add line</button>

      <div class="form-row two" style="margin-top:12px">
        <div class="field"><label for="currency">Currency</label><select id="currency" name="currency">${currencyOptions(ctx)}</select></div>
        <div class="field"><label for="vat_rate">VAT %</label><input id="vat_rate" name="vat_rate" type="number" min="0" max="100" step="0.01" value="0" /></div>
      </div>

      <div class="totals-box" id="totals-box">
        <div><span>Subtotal</span><span data-subtotal>0.00</span></div>
        <div><span>VAT</span><span data-vat>0.00</span></div>
        <div class="totals-grand"><span>Total</span><span data-total>0.00</span></div>
        <div class="sig-hint" data-ccy>${esc(defaultCurrencyCode(ctx))}</div>
      </div>

      <div class="field"><label for="notes">Notes (optional)</label><textarea id="notes" name="notes" maxlength="1000"></textarea></div>

      <h3>Optional signature and stamp</h3>
      ${signaturePadHtml('invoice-signature', 'Signature (optional)')}
      <div class="field">
        <label for="stamp">Company stamp image (optional)</label>
        <input id="stamp" name="stamp" type="file" accept="image/*" />
      </div>

      <button class="btn btn-primary" type="submit">Create invoice</button>
      <p class="sig-hint">A unique serial number is generated automatically. VAT and totals are calculated on the server.</p>
    </form>
  </div>`;

  return {
    title: 'New invoice',
    html: body,
    mount() {
      const form = document.getElementById('invoice-form');
      const rows = document.getElementById('invoice-rows');
      const pad = mountSignaturePad(document.getElementById('invoice-signature'));

      const recalc = () => {
        const descriptions = [...form.querySelectorAll('[name="description"]')];
        const quantities = [...form.querySelectorAll('[name="quantity"]')];
        const prices = [...form.querySelectorAll('[name="unit_price"]')];
        let subtotal = 0;
        descriptions.forEach((_, index) => {
          const qty = Number(quantities[index].value || 0);
          const price = Number(prices[index].value || 0);
          subtotal += qty * price;
        });
        const rate = Number(form.elements.vat_rate.value || 0);
        const vat = (subtotal * rate) / 100;
        const code = form.elements.currency ? form.elements.currency.value : defaultCurrencyCode(ctx);
        document.querySelector('[data-subtotal]').textContent = subtotal.toFixed(2);
        document.querySelector('[data-vat]').textContent = vat.toFixed(2);
        document.querySelector('[data-total]').textContent = (subtotal + vat).toFixed(2);
        const ccy = document.querySelector('[data-ccy]');
        if (ccy) ccy.textContent = code;
      };

      form.addEventListener('input', recalc);
      recalc();

      document.getElementById('add-row').addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'invoice-row';
        row.innerHTML = `<div class="field"><label>Description</label><input name="description" maxlength="200" placeholder="Service description" /></div>
          <div class="field"><label>Qty</label><input name="quantity" type="number" min="0" step="0.01" value="1" /></div>
          <div class="field"><label>Unit price</label><input name="unit_price" type="number" min="0" step="0.01" value="0" /></div>`;
        rows.appendChild(row);
        recalc();
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        busy(button, true, 'Creating…');
        try {
          const descriptions = [...form.querySelectorAll('[name="description"]')];
          const quantities = [...form.querySelectorAll('[name="quantity"]')];
          const prices = [...form.querySelectorAll('[name="unit_price"]')];
          const items = descriptions
            .map((input, index) => ({
              description: input.value.trim(),
              quantity: Number(quantities[index].value || 0),
              unit_price: Number(prices[index].value || 0)
            }))
            .filter((item) => item.description && item.quantity > 0);

          const stampFile = document.getElementById('stamp').files[0];
          const stamp = stampFile ? await readImageFile(stampFile) : '';

          const payload = {
            ...formObject(form),
            items,
            vat_rate: Number(form.elements.vat_rate.value || 0),
            signature: pad.isDirty() ? pad.dataUrl() : '',
            stamp
          };
          delete payload.description;
          delete payload.quantity;
          delete payload.unit_price;

          const res = await api.post('/invoices', payload);
          toast('Invoice created', 'success');
          location.hash = `#/invoices/${res.invoice.id}`;
          await ctx.refresh();
        } catch (error) {
          toast(error.message, 'error');
          busy(button, false);
        }
      });
    }
  };
}
