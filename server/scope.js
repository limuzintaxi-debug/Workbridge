/**
 * Administrative scope helpers.
 *
 * Roles:
 *  - owner : the platform owner. Full control everywhere, and the only role
 *            that can approve, re-scope or revoke admins.
 *  - admin : approved by the owner. Either `global` (whole platform) or
 *            `regional` (one assigned country and/or city).
 *
 * Every admin route filters through these helpers, so a regional admin can only
 * read and write records inside the assigned area — the restriction lives on the
 * server, never in the browser.
 */

const norm = (value) => String(value || '').trim().toLowerCase();

export function isOwner(user) {
  return Boolean(user && user.role === 'owner');
}

/** Owner counts as an admin everywhere; the admin panel treats it as primary. */
export function isAdminLike(user) {
  return Boolean(user && (user.role === 'admin' || user.role === 'owner'));
}

export function adminScope(user) {
  if (!user) return { level: 'none', country: '', city: '', label: 'No access' };
  if (user.role === 'owner') {
    return { level: 'global', country: '', city: '', label: 'Owner — global access' };
  }
  const raw = user.admin_scope || {};
  const level = raw.level === 'regional' ? 'regional' : 'global';
  const country = level === 'regional' ? String(raw.country || '').trim() : '';
  const city = level === 'regional' ? String(raw.city || '').trim() : '';
  const label =
    level === 'global'
      ? 'Global access'
      : [city, country].filter(Boolean).join(', ') || 'Regional access (unassigned)';
  return { level, country, city, label };
}

/** True when the admin may act on a record carrying these location fields. */
export function inScope(user, record = {}) {
  const scope = adminScope(user);
  if (scope.level === 'global') return true;
  if (scope.level === 'none') return false;
  const country = norm(record.country);
  const city = norm(record.city || record.location || record.area);
  // A regional admin with no assigned area sees nothing rather than everything.
  if (!scope.country && !scope.city) return false;
  if (scope.country && country !== norm(scope.country)) return false;
  if (scope.city && city !== norm(scope.city)) return false;
  return true;
}

export function filterByScope(user, rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => inScope(user, row));
}

/** Structured scope payload accepted from the owner. */
export function normalizeScope(input) {
  const raw = input || {};
  const level = raw.level === 'regional' ? 'regional' : 'global';
  if (level === 'global') return { level: 'global', country: '', city: '' };
  return {
    level: 'regional',
    country: String(raw.country || '').trim().slice(0, 80),
    city: String(raw.city || '').trim().slice(0, 80)
  };
}
