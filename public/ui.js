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

  const clear = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    dirty = false;
    drawing = false;
    last = null;
  };

  // signaturePadHtml renders a Clear button beside the pad; bind it here so every
  // signature surface (agreements and invoices) can reset a mistake and re-sign.
  const clearButton = canvas.id
    ? document.querySelector(`[data-clear-sig="${canvas.id}"]`)
    : null;
  if (clearButton) {
    clearButton.addEventListener('click', (event) => {
      event.preventDefault();
      clear();
    });
  }

  const dataUrl = () => (dirty ? canvas.toDataURL('image/png') : null);

  return {
    clear,
    isDirty: () => dirty,
    // Invoice and agreement forms read the drawn signature through this name;
    // keep both spellings so neither caller can throw before it reaches the API.
    dataUrl,
    toDataURL: dataUrl
  };
}

const IMAGE_MAX_SIDE = 1600;
const IMAGE_MAX_SOURCE = 12_000_000;

/**
 * Re-encodes an uploaded picture as a JPEG or PNG data URL.
 *
 * The PDF writer can only embed JPEG and PNG, while phone pickers happily hand
 * back WebP, BMP, GIF or HEIC files. Converting here (and flattening any
 * transparency onto white) means a JPG/JPEG/PNG stamp or signature always
 * reaches the PDF instead of being dropped as an unsupported data URL.
 */
function reencodeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        try {
          const width = image.naturalWidth || image.width || 1;
          const height = image.naturalHeight || image.height || 1;
          const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const context = canvas.getContext('2d');
          if (!context) return reject(new Error('Could not read that image.'));
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const png = /^image\/png$/i.test(file.type);
          resolve(canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92));
        } catch (error) {
          reject(new Error('Could not read that image.'));
        }
      };
      image.onerror = () =>
        reject(new Error('That image format is not supported. Please use a JPG, JPEG or PNG file.'));
      image.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

export async function readImageFile(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  if (file.size > IMAGE_MAX_SOURCE) throw new Error('Image is too large (max 12 MB).');
  return reencodeImage(file);
}

export function money0(amount, currency) {
  const code = currency || defaultCurrency;
  return `${code} ${Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}
