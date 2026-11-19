/** Shared domain helpers. Kept framework-free so they are easy to unit test. */

export const CATEGORIES = [
  'Driver',
  'Laborer',
  'Electrician',
  'Plumber',
  'Carpenter',
  'Mason',
  'Painter',
  'Cleaner',
  'Security Guard',
  'Welder',
  'Mechanic',
  'Other'
];

export const INSTITUTION_TYPES = [
  'NGO',
  'Charity',
  'Social Support Organization',
  'Government Body',
  'Community Center',
  'Other'
];

export const PAY_PERIODS = ['hour', 'day', 'week', 'month', 'project'];

const HOUR = 60 * 60 * 1000;

/**
 * Listing age buckets. Listings are never deleted by age — the bucket is a
 * visual signal only, and the owner/admin decides when to close or remove.
 */
export function ageBucket(createdAt, now = Date.now()) {
  const hours = (now - new Date(createdAt).getTime()) / HOUR;
  if (hours < 24) return { key: 'new', label: 'New', hours: Math.max(0, Math.floor(hours)) };
  if (hours < 48) return { key: '24h', label: '24 Hours Old', hours: Math.floor(hours) };
  if (hours < 72) return { key: '48h', label: '48 Hours Old', hours: Math.floor(hours) };
  return { key: 'older', label: 'Older', hours: Math.floor(hours) };
}

/** Only the last four characters of an Aqama number are ever persisted. */
export function maskAqama(value) {
  const raw = String(value || '').replace(/\s+/g, '');
  if (!raw) return null;
  const tail = raw.slice(-4);
  return `•••• ${tail}`;
}

export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function nowIso() {
  return new Date().toISOString();
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

export function str(value, max = 2000) {
  const s = String(value ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
