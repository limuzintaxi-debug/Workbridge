/**
 * AUTOMATIC CHAT POPUP.
 *
 * The bell already polls the server, so it is the natural trigger: when a chat
 * notification arrives, notify.js fires `wb:chat-ping` and this module opens a
 * small floating conversation window. The new message is readable immediately
 * and can be answered without leaving the page the user is on.
 *
 * Nothing here decides access. The existing booking chat API still refuses
 * anyone who is not a party to the booking, before confirmation, and for a
 * completed or cancelled ride — so a popup simply never appears in those cases.
 *
 * Styles live with the component so the global stylesheet does not need a
 * change, and only one popup can exist at a time.
 */
import { api } from './api.js';
import { esc, fmtDateTime, toast } from './ui.js';

const POLL_MS = 5000;

let viewer = null;
let bound = false;
let current = null; // { bookingId, root, list, timer, signature }

const CSS = `
.chat-popup{position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 24px));max-height:min(70vh,460px);
  display:flex;flex-direction:column;background:#fff;border:1px solid #e2e6ef;border-radius:14px;
  box-shadow:0 18px 40px rgba(10,20,50,.22);z-index:1200;overflow:hidden}
.chat-popup-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;
  background:#0b1f45;color:#fff}
.chat-popup-head .muted{color:rgba(255,255,255,.75);font-size:.78rem}
.chat-popup-close{background:transparent;border:0;color:#fff;font-size:1.4rem;line-height:1;cursor:pointer;padding:0 4px}
.chat-popup-list{padding:10px 12px;overflow-y:auto;flex:1 1 auto;min-height:110px}
.chat-popup .chat-form{display:flex;gap:6px;padding:8px 10px;border-top:1px solid #e2e6ef;margin:0}
.chat-popup .chat-form input{flex:1 1 auto;min-width:0}
.chat-popup-open{display:block;text-align:center;font-size:.8rem;padding:0 0 8px;color:#0b1f45}
@media (max-width:520px){.chat-popup{right:8px;left:8px;bottom:8px;width:auto;max-height:62vh}}
`;

function ensureStyles() {
  if (document.getElementById('chat-popup-style')) return;
  const style = document.createElement('style');
  style.id = 'chat-popup-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

const messagesHtml = (messages) =>
  messages
    .map(
      (row) => `<div class="chat-msg${row.mine ? ' mine' : ''}">
        <div class="chat-meta"><strong>${esc(row.sender_name || 'User')}</strong>
          <span class="muted">${esc(fmtDateTime(row.created_at))}</span></div>
        <div class="chat-text">${esc(row.text)}</div>
      </div>`
    )
    .join('');

function close() {
  if (!current) return;
  clearInterval(current.timer);
  if (current.root && current.root.parentNode) current.root.parentNode.removeChild(current.root);
  current = null;
}

/** Repaint only when the conversation actually changed: no flicker, no repeats. */
function paint(state, { jump = false } = {}) {
  if (!current || !current.list) return;
  const messages = state.messages || [];
  const signature = messages.map((row) => row.id).join(',');
  if (signature === current.signature) return;
  const list = current.list;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = messages.length
    ? messagesHtml(messages)
    : '<div class="empty">No messages yet. Send the first one below.</div>';
  current.signature = signature;
  if (jump || atBottom) list.scrollTop = list.scrollHeight;
  const status = current.root.querySelector('[data-popup-status]');
  if (status && state.booking) {
    status.textContent = `${state.booking.ref || ''}${state.booking.status ? ` · ${state.booking.status}` : ''}`;
  }
}

async function refresh() {
  if (!current) return;
  const bookingId = current.bookingId;
  try {
    const state = await api.get(`/bookings/${bookingId}/chat`);
    if (!current || current.bookingId !== bookingId) return;
    paint(state);
  } catch (error) {
    // Chat is refused once the booking is completed or cancelled: close quietly.
    if (error && (error.status === 403 || error.status === 404)) close();
  }
}

async function open(bookingId) {
  if (!viewer || !bookingId) return;
  // The full chat page already shows this conversation.
  if (location.hash.replace(/^#/, '') === `/chat/${bookingId}`) return;
  if (current && current.bookingId === bookingId) {
    refresh();
    return;
  }

  let state;
  try {
    state = await api.get(`/bookings/${bookingId}/chat`);
  } catch {
    return; // Not confirmed yet, or the ride is over: no popup.
  }
  if (!state || !state.chat_open) return;
  if (current && current.bookingId === bookingId) return;

  close();
  ensureStyles();

  const root = document.createElement('div');
  root.className = 'chat-popup';
  root.id = 'chat-popup';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Booking chat');
  root.innerHTML = `<div class="chat-popup-head">
      <div>
        <strong>${esc(state.booking.business_name || 'Business')} &harr; ${esc(
    state.booking.driver_name || 'Driver'
  )}</strong>
        <div class="muted" data-popup-status></div>
      </div>
      <button type="button" class="chat-popup-close" data-popup-close aria-label="Close chat">&times;</button>
    </div>
    <div class="chat-list chat-popup-list" data-popup-list></div>
    <form class="chat-form" data-popup-form>
      <input name="text" maxlength="2000" placeholder="Write a message…" autocomplete="off" required />
      <button class="btn btn-navy btn-sm" type="submit">Send</button>
    </form>
    <a class="chat-popup-open" href="#/chat/${esc(bookingId)}" data-popup-open>Open full chat</a>`;
  document.body.appendChild(root);

  current = {
    bookingId,
    root,
    list: root.querySelector('[data-popup-list]'),
    timer: null,
    signature: ''
  };
  paint(state, { jump: true });

  root.querySelector('[data-popup-close]').addEventListener('click', close);
  root.querySelector('[data-popup-open]').addEventListener('click', close);

  const form = root.querySelector('[data-popup-form]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.querySelector('input[name=text]');
    const text = (input.value || '').trim();
    if (!text) return;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const result = await api.post(`/bookings/${bookingId}/chat/messages`, { text });
      input.value = '';
      if (current && current.bookingId === bookingId) paint(result, { jump: true });
    } catch (error) {
      toast(error.message, true);
    }
    button.disabled = false;
  });

  current.timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
  if (current.timer.unref) current.timer.unref();
}

/**
 * Called after every render with the signed-in user. The listener is installed
 * once, so navigating between pages never stacks duplicate popups.
 */
export function initChatPopup(user) {
  viewer = user || null;
  if (!viewer) {
    close();
    return;
  }
  if (bound) return;
  bound = true;

  window.addEventListener('wb:chat-ping', (event) => {
    const detail = event.detail || {};
    if (detail.bookingId) open(detail.bookingId);
  });

  // Following "Open full chat" or navigating to that conversation closes the
  // popup so the same messages are not shown twice.
  window.addEventListener('hashchange', () => {
    if (current && location.hash.replace(/^#/, '') === `/chat/${current.bookingId}`) close();
  });
}
