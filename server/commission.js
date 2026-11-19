/**
 * Commission engine.
 *
 * The administrator sets one platform percentage in the Admin Panel. Every
 * invoice and every agreement created afterwards records exactly one commission
 * entry at the percentage in force at that moment, so the ledger stays
 * auditable when the rate changes later.
 *
 * Commission is administrator-only data: it is never printed on an invoice and
 * the invoice payload carries no commission fields.
 */

import crypto from 'node:crypto';
import { data } from './store.js';
import { nowIso } from './util.js';

export const MAX_RATE = 20;
export const RATE_STEP = 0.5;

const money2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Snap a requested percentage onto the supported 0–20% / 0.5% grid. */
export function normalizeRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.max(0, Math.min(MAX_RATE, n));
  return Math.round(clamped / RATE_STEP) * RATE_STEP;
}

export function isValidRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (n < 0 || n > MAX_RATE) return false;
  return Math.abs(n - normalizeRate(n)) < 1e-9;
}

/** The percentage that applies to documents created right now. */
export function currentCommission() {
  const raw = (data().settings && data().settings.commission) || {};
  const payer = ['business', 'worker', 'both'].includes(raw.payer) ? raw.payer : 'business';
  const rate = normalizeRate(raw.rate);
  return { enabled: Boolean(raw.enabled) && rate > 0, rate, payer };
}

/** Rate plus the commission amount for a document value, or null when off. */
export function commissionQuote(amount) {
  const setting = currentCommission();
  if (!setting.enabled) return null;
  const base = Math.max(0, Number(amount) || 0);
  return { ...setting, amount: money2((base * setting.rate) / 100) };
}

/**
 * Append one immutable ledger row. Returns null when commission is disabled, so
 * callers can simply ignore the result.
 */
export function recordCommission({
  docType,
  docId,
  ref,
  amount,
  currency,
  workerId = null,
  workerName = '',
  businessId = null,
  businessName = '',
  actorId = null
}) {
  const quote = commissionQuote(amount);
  if (!quote) return null;

  const entry = {
    id: crypto.randomUUID(),
    doc_type: docType,
    doc_id: docId,
    ref,
    amount: money2(amount),
    currency: currency || '',
    rate: quote.rate,
    commission_amount: quote.amount,
    payer: quote.payer,
    worker_id: workerId,
    worker_name: workerName || '',
    business_id: businessId,
    business_name: businessName || '',
    recorded_by: actorId,
    created_at: nowIso()
  };

  const db = data();
  if (!Array.isArray(db.commissions)) db.commissions = [];
  db.commissions.unshift(entry);
  return entry;
}

export function commissionLedger() {
  const db = data();
  return [...(db.commissions || [])].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
}

/** Totals per currency for the admin dashboard. */
export function commissionSummary(entries = commissionLedger()) {
  const byCurrency = new Map();
  for (const entry of entries) {
    const key = entry.currency || '—';
    const row =
      byCurrency.get(key) || { currency: key, documents: 0, base_total: 0, commission_total: 0 };
    row.documents += 1;
    row.base_total = money2(row.base_total + (Number(entry.amount) || 0));
    row.commission_total = money2(row.commission_total + (Number(entry.commission_amount) || 0));
    byCurrency.set(key, row);
  }
  return {
    count: entries.length,
    by_currency: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  };
}
