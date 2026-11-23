/**
 * NOTIFICATION BELL, SOUND AND WEB PUSH.
 *
 * The bell is one component shared by every signed-in dashboard. It polls the
 * unread count, so it keeps working without push permission, and it plays a
 * short two-tone chime (generated in the browser, no audio file to download)
 * when the unread count grows.
 *
 * The sound preference is stored per user on the server, so it survives logout,
 * a new device and a server restart. Visual notifications stay on when the
 * sound is muted.
 *
 * Push is best effort: an installed PWA on a browser that supports Web Push gets
 * a tickle from the service worker; where the platform does not support it, the
 * bell and the in-app sound still work and nothing is claimed to be delivered.
 */
import { api } from './api.js';
import { esc, fmtDateTime } from './ui.js';

let started = false;
let timer = null;
let soundOn = true;
let lastUnread = null;
let audioContext = null;

const POLL_MS = 12000;

/** Bell button + slide-down list. Safe to re-render: listeners are delegated. */
export function bellHtml() {
  return `<div class="bell" id="notif-bell">
    <button type="button" class="bell-btn" data-bell-toggle aria-label="Notifications" aria-expanded="false">
      <span aria-hidden="true">&#128276;</span>
      <span class="bell-badge" data-bell-badge hidden>0</span>
    </button>
    <div class="bell-panel" data-bell-panel hidden>
      <div class="bell-head">
        <strong>Notifications</strong>
        <button type="button" class="link-btn" data-bell-readall>Mark all read</button>
      </div>
      <label class="bell-sound">
        <input type="checkbox" data-bell-sound checked />
        <span>Notification sound</span>
      </label>
      <div class="bell-list" data-bell-list><div class="empty">Loading&hellip;</div></div>
    </div>
  </div>`;
}

function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioContext) audioContext = new Ctx();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const now = audioContext.currentTime;
    // Two rising notes: audible without being intrusive.
    [
      { at: 0, hz: 880 },
      { at: 0.16, hz: 1180 }
    ].forEach(({ at, hz }) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.22, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.24);
    });
  } catch {
    // Audio is a nicety; never break the page for it.
  }
}

function paintBadge(unread) {
  const badge = document.querySelector('[data-bell-badge]');
  if (!badge) return;
  const count = Number(unread) || 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = count === 0;
}

function itemHtml(row) {
  return `<button type="button" class="bell-item${row.read ? '' : ' unread'}" data-notif-open="${esc(
    row.id
  )}" data-notif-link="${esc(row.link || '')}">
    <span class="bell-item-title">${esc(row.title)}</span>
    ${row.body ? `<span class="bell-item-body">${esc(row.body)}</span>` : ''}
    <span class="bell-item-time">${esc(fmtDateTime(row.created_at))}</span>
  </button>`;
}

function paintList(rows) {
  const list = document.querySelector('[data-bell-list]');
  if (!list) return;
  list.innerHTML = rows.length
    ? rows.map(itemHtml).join('')
    : '<div class="empty">No notifications yet.</div>';
}

function paintSound(on) {
  soundOn = on !== false;
  const box = document.querySelector('[data-bell-sound]');
  if (box) box.checked = soundOn;
}

async function refresh({ announce = true } = {}) {
  if (!document.getElementById('notif-bell')) return;
  let result;
  try {
    result = await api.get('/notifications?limit=40');
  } catch {
    return; // Signed out, or the page is mid-navigation.
  }
  paintBadge(result.unread);
  paintList(result.notifications || []);
  paintSound(result.sound);
  if (announce && lastUnread !== null && result.unread > lastUnread && soundOn) chime();
  lastUnread = result.unread;
}

function closePanel() {
  const panel = document.querySelector('[data-bell-panel]');
  const button = document.querySelector('[data-bell-toggle]');
  if (panel) panel.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}

/** One delegated listener + one poll timer, however often the bell re-renders. */
export function initNotifications() {
  if (started) {
    refresh({ announce: false });
    return;
  }
  started = true;

  document.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-bell-toggle]');
    if (toggle) {
      const panel = document.querySelector('[data-bell-panel]');
      const open = panel && panel.hidden;
      if (panel) panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) refresh({ announce: false });
      return;
    }

    const readAll = event.target.closest('[data-bell-readall]');
    if (readAll) {
      readAll.disabled = true;
      try {
        await api.post('/notifications/read-all');
        lastUnread = 0;
        await refresh({ announce: false });
      } catch {
        /* ignore */
      }
      readAll.disabled = false;
      return;
    }

    const item = event.target.closest('[data-notif-open]');
    if (item) {
      const id = item.dataset.notifOpen;
      const link = item.dataset.notifLink;
      try {
        await api.post(`/notifications/${id}/read`);
      } catch {
        /* still navigate */
      }
      closePanel();
      if (link) window.location.hash = link.replace(/^#/, '#');
      else refresh({ announce: false });
      return;
    }

    // Clicking outside the panel closes it.
    if (!event.target.closest('#notif-bell')) closePanel();
  });

  document.addEventListener('change', async (event) => {
    const box = event.target.closest('[data-bell-sound]');
    if (!box) return;
    const next = Boolean(box.checked);
    try {
      const saved = await api.patch('/notifications/prefs', { sound: next });
      paintSound(saved.sound);
      if (saved.sound) chime();
    } catch {
      box.checked = !next;
    }
  });

  timer = setInterval(() => refresh(), POLL_MS);
  if (timer.unref) timer.unref();
  refresh({ announce: false });
}

const urlBase64ToUint8Array = (value) => {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

/**
 * Ask for notification permission and register this device. Returns a reason
 * instead of pretending success when the platform cannot deliver push.
 */
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'This browser does not support Web Push.' };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'Notifications are blocked in the browser settings.' };
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'Notification permission was not granted.' };

  const registration = await navigator.serviceWorker.ready;
  const { key } = await api.get('/push/public-key');
  if (!key) return { ok: false, reason: 'Push is not configured on the server.' };

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    }));
  await api.post('/push/subscribe', { subscription: subscription.toJSON() });
  return { ok: true };
}
