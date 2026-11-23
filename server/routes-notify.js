/**
 * NOTIFICATION ROUTES — bell list, unread badge, read state, the per-user sound
 * preference and Web Push subscription registration.
 *
 * Mounted before the legacy notification handlers in routes.js so these
 * versions (which also serve the owner role and the push endpoints) win.
 */
import { Router } from 'express';
import {
  notificationsFor,
  unreadCount,
  soundEnabled,
  setSoundEnabled,
  addPushSubscription,
  removePushSubscription,
  pushPublicKey
} from './notifications.js';
import { persist } from './store.js';

const router = Router();

const fail = (res, status, error, message) => res.status(status).json({ error, message });

function requireUser(req, res) {
  if (!req.user) {
    fail(res, 401, 'auth_required', 'Please sign in first.');
    return null;
  }
  return req.user;
}

const view = (row) => ({
  id: row.id,
  title: row.title,
  body: row.body || '',
  link: row.link || null,
  kind: row.kind || 'general',
  booking_id: row.booking_id || null,
  read: Boolean(row.read_at),
  read_at: row.read_at || null,
  created_at: row.created_at
});

router.get('/notifications', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
  return res.json({
    notifications: notificationsFor(viewer.id, limit).map(view),
    unread: unreadCount(viewer.id),
    sound: soundEnabled(viewer.id)
  });
});

router.post('/notifications/read-all', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const now = new Date().toISOString();
  let updated = 0;
  for (const row of notificationsFor(viewer.id, 4000)) {
    if (!row.read_at) {
      row.read_at = now;
      updated += 1;
    }
  }
  if (updated) persist();
  return res.json({ ok: true, updated, unread: 0 });
});

router.post('/notifications/:id/read', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const row = notificationsFor(viewer.id, 4000).find((item) => item.id === req.params.id);
  if (!row) return fail(res, 404, 'not_found', 'Notification not found.');
  if (!row.read_at) {
    row.read_at = new Date().toISOString();
    persist();
  }
  return res.json({ ok: true, unread: unreadCount(viewer.id) });
});

router.get('/notifications/prefs', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  return res.json({ sound: soundEnabled(viewer.id) });
});

router.patch('/notifications/prefs', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  if (typeof (req.body || {}).sound !== 'boolean') {
    return fail(res, 400, 'invalid_pref', 'sound must be true or false.');
  }
  setSoundEnabled(viewer.id, req.body.sound);
  return res.json({ ok: true, sound: soundEnabled(viewer.id) });
});

router.get('/push/public-key', (req, res) => {
  res.json({ key: pushPublicKey() });
});

router.post('/push/subscribe', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const subscription = (req.body || {}).subscription || req.body;
  const row = addPushSubscription(viewer.id, subscription);
  if (!row) return fail(res, 400, 'invalid_subscription', 'A push subscription endpoint is required.');
  return res.status(201).json({ ok: true, id: row.id });
});

router.post('/push/unsubscribe', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  removePushSubscription(viewer.id, (req.body || {}).endpoint);
  return res.json({ ok: true });
});

export default router;
