import { data } from './store.js';
import { parseCookies, verifySession, SESSION_COOKIE } from './security.js';

/** Resolves the signed cookie into `req.user` (or null) on every request. */
export function attachSession(req, res, next) {
  req.user = null;
  req.session = null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const payload = verifySession(token);
    if (payload) {
      const user = data().users.find((u) => u.id === payload.uid);
      // A password change bumps session_epoch, which invalidates older cookies.
      const epochMatches = (user?.session_epoch || 0) === (payload.epoch || 0);
      if (user && user.status === 'active' && epochMatches) {
        req.user = user;
        req.session = payload;
      }
    }
  }
  next();
}

/** Small helper so every view/route shapes a user the same way. */
export function publicUser(user, profile) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    full_name: user.full_name,
    phone: user.phone,
    status: user.status,
    created_at: user.created_at,
    profile: profile || null
  };
}

export function profileFor(user) {
  if (!user) return null;
  const db = data();
  if (user.role === 'worker') {
    // Match on either key: a legacy or repaired row may carry only its own id,
    // and a strict user_id match made the profile look absent to its owner.
    return (
      db.workerProfiles.find((p) => p && p.user_id === user.id) ||
      db.workerProfiles.find((p) => p && p.id === user.id) ||
      null
    );
  }
  if (user.role === 'business') {
    return (
      db.businessProfiles.find((p) => p && p.user_id === user.id) ||
      db.businessProfiles.find((p) => p && p.id === user.id) ||
      null
    );
  }
  return null;
}
