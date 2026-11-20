import { esc, ageBadge, pill, money, fmtDate, fmtDateTime } from '../ui.js';

export const LOGO = '/assets/logo.png';

export function options(list, selected) {
  return (list || [])
    .map((value) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(value)}</option>`)
    .join('');
}

export function invoiceRow(inv) {
  const entry = inv.commission;
  const rate = entry ? Number(entry.rate) || 0 : 0;
  const commissionText = rate > 0
    ? `${money(Number(entry.amount) || 0, entry.currency || inv.currency)} · ${rate}%`
    : '0%';
  return `<a class="inv-row" href="#/invoices/${esc(inv.id)}">
      <span class="inv-serial">${esc(inv.serial)}</span>
      <span>${esc(fmtDate(inv.created_at))}</span>
      <span class="inv-total">${money(inv.total, inv.currency)}</span>
      <span class="inv-commission">${esc(commissionText)}</span>
    </a>`;
}

/** Invoice history: one line per invoice with serial, date, bill amount and commission. */
export function invoiceList(list) {
  return `<div class="inv-list">
    <div class="inv-head"><span>Invoice</span><span>Date</span><span>Bill amount</span><span>Commission</span></div>
    ${list.map(invoiceRow).join('')}
  </div>`;
}

export function tabsBar(tabs, path) {
  const here = `#${path}`;
  return `<nav class="subnav no-print">${tabs
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${href === here || (href !== '#/worker' && href !== '#/business' && href !== '#/admin' && here.startsWith(href)) ? 'active' : ''}">${esc(label)}</a>`
    )
    .join('')}</nav>`;
}

export function panelShell({ title, subtitle, tabs, path, body }) {
  return `<div class="container">
    <div class="section-head"><div><h1>${esc(title)}</h1>${
      subtitle ? `<p class="muted" style="margin:0">${esc(subtitle)}</p>` : ''
    }</div></div>
    ${tabs ? tabsBar(tabs, path) : ''}
    ${body}
  </div>`;
}

export function jobCard(job, actions = '') {
  const description = String(job.description || '');
  const short = description.length > 170 ? `${description.slice(0, 170)}…` : description;
  return `<article class="job-card">
    <header>
      <div>
        <h3>${esc(job.title)}</h3>
        <div class="job-meta">
          <span class="tag">${esc(job.category)}</span>
          ${job.location ? `<span>${esc(job.location)}</span>` : ''}
          <span>Posted ${esc(fmtDate(job.created_at))}</span>
          ${job.application_count !== undefined ? `<span>${job.application_count} applicant(s)</span>` : ''}
        </div>
      </div>
      <div style="text-align:right">${ageBadge(job)}<div style="margin-top:4px">${pill(job.status)}</div></div>
    </header>
    <p class="muted" style="margin:8px 0 0">${esc(short)}</p>
    <div class="job-pay">${money(job.pay_amount)} / ${esc(job.pay_period)}</div>
    ${actions ? `<div class="btn-row">${actions}</div>` : ''}
  </article>`;
}

export function signaturePadHtml(id = 'signature', label = 'Signature') {
  return `<div class="field">
    <label for="${id}">${esc(label)}</label>
    <div class="signature-box"><canvas id="${id}" aria-label="${esc(label)} pad"></canvas></div>
    <p class="sig-hint">Sign with your finger on a touchscreen, or draw with the mouse.
      <button type="button" class="btn btn-ghost btn-sm" data-clear-sig="${id}">Clear Signature</button>
    </p>
  </div>`;
}

export function docHead(title, ref, createdAt) {
  return `<div class="doc-head">
    <div>
      <img src="${LOGO}" alt="WORKBRIDGE" />
      <div class="doc-title">${esc(title)}</div>
    </div>
    <div style="text-align:right">
      <div class="doc-ref">Ref: ${esc(ref)}</div>
      <div class="doc-ref">${esc(fmtDateTime(createdAt))}</div>
    </div>
  </div>`;
}

export function printBar(backHref, backLabel) {
  return `<div class="btn-row no-print" style="max-width:780px;margin:0 auto 12px">
    <button class="btn btn-navy" data-print>Save as PDF / Print</button>
    <a class="btn btn-ghost" href="${backHref}">${esc(backLabel)}</a>
  </div>`;
}

export function bindPrintButtons() {
  for (const button of document.querySelectorAll('[data-print]')) {
    button.addEventListener('click', () => window.print());
  }
}

export function institutionsCard(institutions) {
  if (!institutions || !institutions.length) {
    return `<div class="card"><h3>Institutional &amp; Social Support</h3>
      <p class="muted">No institutions have been approved yet.</p>
      <a class="btn btn-ghost btn-sm" href="#/institutions">Register an institution</a></div>`;
  }
  return `<div class="card"><h3>Institutional &amp; Social Support</h3>
    <p class="muted" style="margin-bottom:8px">Approved organizations you can work with.</p>
    <div>${institutions
      .map((i) => `<span class="tag">${esc(i.name)}</span>`)
      .join('')}</div>
    <a class="link-quiet" href="#/institutions">How institutional support works</a></div>`;
}

export function statCards(entries) {
  return `<div class="stats">${entries
    .map(([label, value]) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join('')}</div>`;
}
