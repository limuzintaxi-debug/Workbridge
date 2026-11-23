/**
 * NOTIFICATIONS — one place that creates a notification, keeps the unread
 * count, stores the user's sound preference and (best effort) sends a Web Push
 * tickle to an installed PWA.
 *
 * Records live in the existing `notifications` collection, which the Supabase
 * adapter mirrors like every other collection, so history survives restarts.
 * The bell itself never depends on push: the browser polls the unread count, so
 * a device without push permission still sees every notification.
 */
import crypto from 'node:crypto';
import { data, persist } from './store.js';
import { nowIso } from './util.js';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:Limuzin@196vip.si';

const b64url = (buffer) =>
  Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

/**
 * VAPID keys are generated once and kept in settings, so an installed PWA does
 * not have to re-subscribe after every restart. No external service is used.
 */
export function vapidKeys() {
  const db = data();
  if (!db.settings) db.settings = {};
  let keys = db.settings.vapid;
  if (!keys || !keys.public_key || !keys.private_key) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
    keys = {
      public_key: b64url(publicKey),
      private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      created_at: nowIso()
    };
    db.settings.vapid = keys;
    persist();
  }
  return keys;
}

export const pushPublicKey = () => vapidKeys().public_key;

/** Short-lived ES256 JWT that authorises the push to the browser's endpoint. */
function vapidJwt(endpoint) {
  const keys = vapidKeys();
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: VAPID_SUBJECT
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: keys.private_key,
    dsaEncoding: 'ieee-p1363'
  });
  return `${signingInput}.${b64url(signature)}`;
}

function subscriptionsOf(userId) {
  return (data().pushSubscriptions || []).filter((row) => row.user_id === userId);
}

/**
 * Empty-payload push: the service worker is woken up and asks the API for its
 * unread notifications, so no payload encryption library is needed. Failures
 * are recorded on the subscription and never block the request that created the
 * notification.
 */
async function sendPushTickle(userId) {
  const subs = subscriptionsOf(userId);
  if (!subs.length) return;
  const keys = vapidKeys();
  for (const sub of subs) {
    try {
      const response = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: '120',
          'Content-Length': '0',
          Authorization: `vapid t=${vapidJwt(sub.endpoint)}, k=${keys.public_key}`
        }
      });
      if (response.status === 404 || response.status === 410) {
        // The browser dropped this subscription; forget it instead of retrying.
        data().pushSubscriptions = (data().pushSubscriptions || []).filter((row) => row.id !== sub.id);
        persist();
      } else {
        sub.last_push_at = nowIso();
        sub.last_status = response.status;
      }
    } catch (error) {
      sub.last_error = String(error && error.message ? error.message : error).slice(0, 200);
      sub.last_push_at = nowIso();
    }
  }
}

/**
 * Create one notification for one user. `kind` and `booking_id` let the bell
 * open the relevant booking, and let the client avoid replaying a sound for a
 * notification it has already announced.
 */
export function notifyUser(userId, { title, body = '', link = null, kind = 'general', booking_id = null } = {}) {
  if (!userId) return null;
  const db = data();
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    title,
    body,
    link,
    kind,
    booking_id,
    read_at: null,
    created_at: nowIso()
  };
  db.notifications.unshift(row);
  // Keep the collection bounded without losing recent history.
  if (db.notifications.length > 4000) db.notifications.length = 4000;
  persist();
  // Fire and forget: a push failure must never fail the booking action.
  sendPushTickle(userId).catch(() => {});
  return row;
}

/** Notify every account holding one of the given roles. */
export function notifyRoles(roles, payload) {
  const list = Array.isArray(roles) ? roles : [roles];
  const targets = data().users.filter((user) => list.includes(user.role) && user.status !== 'suspended');
  return targets.map((user) => notifyUser(user.id, payload)).filter(Boolean);
}

export function notificationsFor(userId, limit = 60) {
  return (data().notifications || [])
    .filter((row) => row.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

export const unreadCount = (userId) =>
  (data().notifications || []).filter((row) => row.user_id === userId && !row.read_at).length;

export const soundEnabled = (userId) => {
  const user = data().users.find((u) => u.id === userId);
  // Default is ON; only an explicit false mutes it.
  return user ? user.notify_sound !== false : true;
};

export function setSoundEnabled(userId, enabled) {
  const user = data().users.find((u) => u.id === userId);
  if (!user) return false;
  user.notify_sound = Boolean(enabled);
  persist();
  return true;
}

export function addPushSubscription(userId, subscription) {
  if (!subscription || !subscription.endpoint) return null;
  const db = data();
  if (!Array.isArray(db.pushSubscriptions)) db.pushSubscriptions = [];
  const existing = db.pushSubscriptions.find(
    (row) => row.user_id === userId && row.endpoint === subscription.endpoint
  );
  if (existing) {
    existing.keys = subscription.keys || existing.keys || null;
    existing.updated_at = nowIso();
    persist();
    return existing;
  }
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    endpoint: subscription.endpoint,
    keys: subscription.keys || null,
    created_at: nowIso()
  };
  db.pushSubscriptions.push(row);
  persist();
  return row;
}

export function removePushSubscription(userId, endpoint) {
  const db = data();
  const before = (db.pushSubscriptions || []).length;
  db.pushSubscriptions = (db.pushSubscriptions || []).filter(
    (row) => !(row.user_id === userId && (!endpoint || row.endpoint === endpoint))
  );
  if (db.pushSubscriptions.length !== before) persist();
}
