export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

let defaultCurrency = 'SAR';

/** The administrator-configured platform currency, set from /meta on boot. */
export function setDefaultCurrency(code) {
  if (code) defaultCurrency = String(code).toUpperCase();
}

export function getDefaultCurrency() {
  return defaultCurrency;
}

export function money(amount, currency) {
  const code = currency || defaultCurrency;
  const n = Number(amount || 0);
  return `${code} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ageBadge(job) {
  const key = job.age_bucket || 'older';
  const label = job.age_label || 'Older';
  return `<span class="badge badge-${esc(key)}">${esc(label)}</span>`;
}

export function pill(status) {
  const value = String(status || '').toLowerCase().replace(/\s+/g, '-');
  return `<span class="badge badge-${esc(value)}">${esc(String(status || '').replace(/_/g, ' '))}</span>`;
}

let toastTimer = null;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast ${kind}`.trim();
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3800);
}

export function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

export function fieldValue(form, name) {
  const el = form.elements[name];
  return el ? el.value : '';
}

export function formObject(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

export function busy(button, isBusy, label) {
  if (!button) return;
  if (isBusy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.textContent = label || 'Working…';
  } else {
    button.disabled = false;
    if (button.dataset.label) button.textContent = button.dataset.label;
  }
}

/** Draw-on canvas for touch/mouse signatures. */
export function mountSignaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(280, canvas.clientWidth || canvas.parentElement?.clientWidth || 320);
  const height = 160;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0a0a0a';

  let drawing = false;
  let dirty = false;
  let last = null;

  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    const src = event.touches && event.touches[0] ? event.touches[0] : event;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  };

  const start = (event) => {
    event.preventDefault();
    drawing = true;
    last = point(event);
  };
  const move = (event) => {
    if (!drawing) return;
    event.preventDefault();
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    dirty = true;
  };
  const end = () => {
    drawing = false;
    last = null;
  };

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointerleave', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
    },
    isDirty: () => dirty,
    toDataURL: () => (dirty ? canvas.toDataURL('image/png') : null)
  };
}

export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file.'));
    if (file.size > 1_400_000) return reject(new Error('Image is too large (max 1.4 MB).'));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

export function money0(amount, currency) {
  const code = currency || defaultCurrency;
  return `${code} ${Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}
