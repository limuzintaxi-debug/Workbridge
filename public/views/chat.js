/**
 * BOOKING CHAT PAGE (#/chat/:id).
 *
 * Only the business that created the booking and the driver it selected can
 * open this page. The server decides that on every request, so this view simply
 * shows what it is allowed to see: before confirmation it renders the reason
 * instead of a conversation.
 */
import { api } from '../api.js';
import { esc, fmtDateTime, toast } from '../ui.js';

const POLL_MS = 5000;

function headerHtml(booking) {
  return `<div class="chat-head">
    <div>
      <strong>${esc(booking.business_name || 'Business')} &harr; ${esc(booking.driver_name || 'Driver')}</strong>
      <div class="muted" style="font-size:0.85rem">${esc(booking.ref || '')}${
        booking.vehicle ? ` · ${esc(booking.vehicle)}` : ''
      } · ${esc(booking.status || '')}</div>
    </div>
  </div>`;
}

function messagesHtml(messages) {
  if (!messages.length) {
    return '<div class="empty">No messages yet. Send the first one below.</div>';
  }
  return messages
    .map(
      (row) => `<div class="chat-msg${row.mine ? ' mine' : ''}">
        <div class="chat-meta"><strong>${esc(row.sender_name || 'User')}</strong>
          <span class="muted">${esc(fmtDateTime(row.created_at))}</span></div>
        <div class="chat-text">${esc(row.text)}</div>
      </div>`
    )
    .join('');
}

export async function chatView(ctx, bookingId) {
  let timer = null;
  let lastCount = 0;

  const shell = (body) => `<div class="container">
    <div class="section-head">
      <div><h1>Booking chat</h1><p class="muted" style="margin:0">Private to you and the other party.</p></div>
      <div class="btn-row"><a class="btn btn-ghost btn-sm" href="#${
        ctx.user && ctx.user.role === 'business' ? '/business/bookings' : '/worker/bookings'
      }">Back to bookings</a></div>
    </div>
    ${body}
  </div>`;

  let initial;
  try {
    initial = await api.get(`/bookings/${bookingId}/chat`);
  } catch (error) {
    return {
      title: 'Booking chat',
      html: shell(`<div class="card"><p>${esc(error.message || 'Chat is not available.')}</p></div>`),
      mount: () => {}
    };
  }

  const html = shell(`<div class="card chat-card" id="chat-card">
    ${headerHtml(initial.booking)}
    <div class="chat-list" id="chat-list">${messagesHtml(initial.messages || [])}</div>
    <form id="chat-form" class="chat-form">
      <input name="text" id="chat-input" maxlength="2000" placeholder="Write a message…" autocomplete="off" required />
      <button class="btn btn-navy" type="submit">Send</button>
    </form>
  </div>`);

  return {
    title: 'Booking chat',
    html,
    mount: () => {
      const list = document.getElementById('chat-list');
      const form = document.getElementById('chat-form');
      const input = document.getElementById('chat-input');
      lastCount = (initial.messages || []).length;

      const paint = (messages) => {
        if (!list) return;
        const atBottom =
          list.scrollHeight - list.scrollTop - list.clientHeight < 60 || messages.length !== lastCount;
        list.innerHTML = messagesHtml(messages);
        if (atBottom) list.scrollTop = list.scrollHeight;
        lastCount = messages.length;
      };
      if (list) list.scrollTop = list.scrollHeight;

      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = (input?.value || '').trim();
        if (!text) return;
        const button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          const result = await api.post(`/bookings/${bookingId}/chat/messages`, { text });
          if (input) input.value = '';
          paint(result.messages || []);
        } catch (error) {
          toast(error.message, true);
        }
        button.disabled = false;
      });

      // New messages from the other party appear without a manual refresh.
      timer = setInterval(async () => {
        if (document.hidden || !document.getElementById('chat-list')) return;
        try {
          const result = await api.get(`/bookings/${bookingId}/chat`);
          if ((result.messages || []).length !== lastCount) paint(result.messages || []);
        } catch {
          /* ignore transient errors */
        }
      }, POLL_MS);
      if (timer.unref) timer.unref();
    }
  };
}
