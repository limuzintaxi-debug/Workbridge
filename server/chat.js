/**
 * BOOKING CHAT — the business and the selected driver can exchange messages
 * about one booking, and nobody else can.
 *
 * Access is decided here, on the server, from the booking record itself:
 *   • the viewer must be the booking's business owner or its selected driver;
 *   • the booking must already be confirmed by the business (status 'selected'
 *     or later), so an offer alone never opens a conversation;
 *   • a cancelled booking keeps its history readable but takes no new messages.
 *
 * Messages are stored in the `chatMessages` collection, which the Supabase
 * adapter mirrors, and are keyed by booking_id so a conversation can never leak
 * into another booking.
 */
import crypto from 'node:crypto';
import { data, persist } from './store.js';
import { nowIso, str } from './util.js';
import { stageIndex } from './bookings.js';

export const CHAT_MIN_STAGE = stageIndex('selected');
const MAX_LENGTH = 2000;

export const isBookingRecord = (booking) =>
  Boolean(booking && (booking.kind === 'business' || booking.kind === 'customer'));

export function findBooking(id) {
  return (data().rideBookings || []).find((row) => row.id === id && isBookingRecord(row)) || null;
}

/** Chat opens once the business has confirmed a driver, and closes for good
 * when the ride is over: a completed or cancelled booking keeps its messages
 * readable in storage but accepts no new ones and offers no chat button. */
export function chatOpen(booking) {
  if (!booking) return false;
  if (!booking.selected_driver_id) return false;
  if (booking.status === 'cancelled' || booking.status === 'completed') return false;
  return stageIndex(booking.status) >= CHAT_MIN_STAGE;
}

/** The two parties: the business that created the booking and its driver. */
export function isChatParty(booking, viewer) {
  if (!booking || !viewer) return false;
  return viewer.id === booking.business_id || viewer.id === booking.selected_driver_id;
}

export function canUseChat(booking, viewer) {
  return Boolean(booking && viewer && chatOpen(booking) && isChatParty(booking, viewer));
}

export function messagesFor(bookingId) {
  return (data().chatMessages || [])
    .filter((row) => row.booking_id === bookingId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

const otherParty = (booking, viewer) =>
  viewer.id === booking.business_id ? booking.selected_driver_id : booking.business_id;

export function unreadFor(bookingId, viewerId) {
  return messagesFor(bookingId).filter(
    (row) => row.sender_id !== viewerId && !(row.read_by || []).includes(viewerId)
  ).length;
}

export function totalUnread(viewerId) {
  return (data().chatMessages || []).filter(
    (row) => row.sender_id !== viewerId && !(row.read_by || []).includes(viewerId)
  ).length;
}

export function messageView(row, viewerId) {
  return {
    id: row.id,
    booking_id: row.booking_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    sender_role: row.sender_role,
    text: row.text,
    mine: row.sender_id === viewerId,
    created_at: row.created_at
  };
}

export function addMessage(booking, viewer, rawText) {
  const text = str(rawText, MAX_LENGTH);
  if (!text) return { error: 'empty_message' };
  const db = data();
  if (!Array.isArray(db.chatMessages)) db.chatMessages = [];
  const row = {
    id: crypto.randomUUID(),
    booking_id: booking.id,
    booking_ref: booking.ref || '',
    sender_id: viewer.id,
    sender_name: viewer.full_name || (viewer.role === 'business' ? 'Business' : 'Driver'),
    sender_role: viewer.role,
    text,
    read_by: [viewer.id],
    created_at: nowIso()
  };
  db.chatMessages.push(row);
  persist();
  return { message: row, recipient_id: otherParty(booking, viewer) };
}

export function markRead(bookingId, viewerId) {
  let changed = 0;
  for (const row of data().chatMessages || []) {
    if (row.booking_id !== bookingId) continue;
    if (row.sender_id === viewerId) continue;
    if (!Array.isArray(row.read_by)) row.read_by = [];
    if (!row.read_by.includes(viewerId)) {
      row.read_by.push(viewerId);
      changed += 1;
    }
  }
  if (changed) persist();
  return changed;
}
