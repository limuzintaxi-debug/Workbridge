/**
 * CHAT ROUTES — one conversation per booking, opened only for the business and
 * the driver it selected after confirmation.
 *
 * Every endpoint re-checks access from the booking record, so hiding a button in
 * the browser is never the security boundary: an unselected driver calling these
 * URLs directly gets 403.
 */
import { Router } from 'express';
import {
  findBooking,
  canUseChat,
  chatOpen,
  messagesFor,
  messageView,
  addMessage,
  markRead,
  unreadFor,
  totalUnread
} from './chat.js';
import { notifyUser } from './notifications.js';
import { data } from './store.js';

const router = Router();

const fail = (res, status, error, message) => res.status(status).json({ error, message });

function requireUser(req, res) {
  if (!req.user) {
    fail(res, 401, 'auth_required', 'Please sign in first.');
    return null;
  }
  return req.user;
}

const nameOf = (id, fallback) => {
  const user = data().users.find((row) => row.id === id);
  return user ? user.full_name || fallback : fallback;
};

function chatHeader(booking, viewer) {
  return {
    booking_id: booking.id,
    ref: booking.ref || '',
    status: booking.status,
    vehicle: booking.selected_vehicle || '',
    business_name: booking.business_name || nameOf(booking.business_id, 'Business'),
    driver_name: booking.selected_driver_name || nameOf(booking.selected_driver_id, 'Driver'),
    viewer_role: viewer.role
  };
}

/** Conversation state for one booking. 403 until the booking is confirmed. */
router.get('/bookings/:id/chat', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');

  const allowed = canUseChat(booking, viewer);
  if (!allowed) {
    return res.status(403).json({
      error: 'chat_unavailable',
      message: chatOpen(booking)
        ? 'Only the business and the selected driver can open this chat.'
        : 'Chat opens after the business confirms the selected driver.',
      chat_open: false
    });
  }

  markRead(booking.id, viewer.id);
  return res.json({
    chat_open: true,
    booking: chatHeader(booking, viewer),
    messages: messagesFor(booking.id).map((row) => messageView(row, viewer.id)),
    unread: 0
  });
});

/** Send a message. Only the two parties, only after confirmation. */
router.post('/bookings/:id/chat/messages', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');

  if (!canUseChat(booking, viewer)) {
    return fail(
      res,
      403,
      'chat_unavailable',
      chatOpen(booking)
        ? 'Only the business and the selected driver can use this chat.'
        : 'Chat opens after the business confirms the selected driver.'
    );
  }

  const result = addMessage(booking, viewer, req.body && req.body.text);
  if (result.error === 'empty_message') {
    return fail(res, 400, 'empty_message', 'Please type a message first.');
  }

  const otherId = result.recipient_id;
  notifyUser(otherId, {
    title: `New message — ${booking.ref || 'booking'}`,
    body: `${viewer.full_name || (viewer.role === 'business' ? 'Business' : 'Driver')}: ${result.message.text.slice(0, 90)}`,
    link: `#/chat/${booking.id}`,
    kind: 'chat',
    booking_id: booking.id
  });

  return res.status(201).json({
    message: messageView(result.message, viewer.id),
    messages: messagesFor(booking.id).map((row) => messageView(row, viewer.id))
  });
});

/** Mark the other party's messages in this booking as read. */
router.post('/bookings/:id/chat/read', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  const booking = findBooking(req.params.id);
  if (!booking) return fail(res, 404, 'not_found', 'Booking not found.');
  if (!canUseChat(booking, viewer)) return fail(res, 403, 'chat_unavailable', 'Chat is not available.');
  const updated = markRead(booking.id, viewer.id);
  return res.json({ ok: true, updated, unread: unreadFor(booking.id, viewer.id) });
});

/** Small counter the bell uses without loading the whole list. */
router.get('/chat/unread', (req, res) => {
  const viewer = requireUser(req, res);
  if (!viewer) return undefined;
  return res.json({ chat: totalUnread(viewer.id) });
});

export default router;
