#!/usr/bin/env node
/**
 * Focused regression check for the reported invoice problems.
 *
 * A business issues an invoice carrying a PNG signature and a PNG company stamp
 * (what the app actually stores: the signature pad uses canvas.toDataURL and
 * uploaded stamps pass through FileReader unchanged), then downloads the PDF and
 * asserts that BOTH images are embedded. Before the fix the PDF writer accepted
 * only JPEG data URLs, so the signature fell back to a text label and the stamp
 * was silently dropped, while the print view still showed both.
 *
 * Also asserts that an invoice whose stamp cannot be decoded still produces a
 * valid PDF, so invoice generation never fails because of an image.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = Number(process.env.TEST_PORT || 3197);
const BASE = `http://127.0.0.1:${PORT}`;
const stamp = Date.now();

/* ------------------------------------------------------------ PNG fixtures */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Builds a real RGBA PNG; `paint(x, y)` returns [r, g, b, a]. */
function pngDataUrl(width, height, paint) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const at = y * (stride + 1) + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const signaturePng = pngDataUrl(160, 48, (x, y) => (y > 20 && y < 26 ? [11, 32, 63, 255] : [255, 255, 255, 0]));
const stampPng = pngDataUrl(96, 96, (x, y) => {
  const dx = x - 48;
  const dy = y - 48;
  const ring = Math.sqrt(dx * dx + dy * dy);
  return ring > 30 && ring < 42 ? [200, 30, 40, 255] : [255, 255, 255, 0];
});

/* ------------------------------------------------------------------ server */

let server;
let dataDir;

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not become ready');
}

function cookiesFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return raw.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}

async function call(method, url, { body, cookie } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary or empty */
  }
  return { status: res.status, json, text, cookie: cookiesFrom(res) };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/* -------------------------------------------------------------------- main */

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

try {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wb-invoice-'));
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), NODE_ENV: 'test', SETUP_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  await waitForServer();
  console.log(`PASS local server ready on ${BASE}`);

  let cookie = '';
  await step('business registers and signs in', async () => {
    const res = await call('POST', '/api/auth/register', {
      body: {
        role: 'business',
        email: `invoice${stamp}@workbridge.test`,
        password: 'Business#12345',
        full_name: 'Invoice Owner',
        phone: '+971500000123',
        company_name: 'Stamp Test LLC',
        country: 'United Arab Emirates',
        address: 'Demo Street 1'
      }
    });
    assert.equal(res.status, 201, res.text);
    cookie = res.cookie;
    assert.ok(cookie, 'expected a session cookie');
  });

  let invoiceId = '';
  await step('invoice is created with an authorized signature and uploaded stamp', async () => {
    const res = await call('POST', '/api/invoices', {
      cookie,
      body: {
        client_name: 'Demo Client',
        client_phone: '+971500000999',
        client_country: 'United Arab Emirates',
        currency: 'SAR',
        vat_rate: 5,
        items: [{ description: 'Site supervision', quantity: 2, unit_price: 500 }],
        signature: signaturePng,
        stamp: stampPng
      }
    });
    assert.equal(res.status, 201, res.text);
    invoiceId = res.json.invoice.id;
    assert.ok(invoiceId, 'expected an invoice id');
    assert.equal(res.json.invoice.signature, signaturePng, 'signature must be stored unchanged');
    assert.equal(res.json.invoice.stamp, stampPng, 'stamp must be stored unchanged');
  });

  await step('invoice PDF embeds the PNG signature and the PNG company stamp', async () => {
    const res = await fetch(`${BASE}/api/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('latin1');
    assert.ok(text.startsWith('%PDF'), 'response must be a PDF');
    assert.equal(count(text, '/Subtype/Image'), 2, 'expected both the signature and the stamp');
    assert.equal(count(text, '/Filter/FlateDecode'), 2, 'PNG images are embedded as Flate streams');
    assert.equal(count(text, 'Signed electronically'), 0, 'signature image must not fall back to text');
    assert.equal(count(text, 'Company stamp on file'), 0, 'stamp image must not fall back to text');
  });

  await step('invoice PDF still generates when the stamp image is unusable', async () => {
    const created = await call('POST', '/api/invoices', {
      cookie,
      body: {
        client_name: 'Fallback Client',
        currency: 'SAR',
        items: [{ description: 'Consultation', quantity: 1, unit_price: 100 }],
        signature: signaturePng,
        stamp: 'data:image/png;base64,not-a-real-png'
      }
    });
    assert.equal(created.status, 201, created.text);
    const res = await fetch(`${BASE}/api/invoices/${created.json.invoice.id}/pdf`, { headers: { cookie } });
    assert.equal(res.status, 200, 'generation must not fail because of an image');
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    assert.ok(text.startsWith('%PDF'));
    assert.equal(count(text, '/Subtype/Image'), 1, 'the valid signature is still embedded');
  });

  await step('existing invoice records stay readable', async () => {
    const list = await call('GET', '/api/invoices', { cookie });
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.invoices.some((i) => i.id === invoiceId));
  });
} finally {
  if (server) server.kill('SIGTERM');
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'invoice PDF checks passed' : `${failures} invoice PDF check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
