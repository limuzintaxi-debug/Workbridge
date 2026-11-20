#!/usr/bin/env node
/**
 * Rebuild every WORKBRIDGE brand asset from the exact approved artwork.
 *
 * Source of truth: public/assets/logo.png — the supplied, approved logo file
 * (1536x1024, navy "W" with an orange handshake on white). Nothing in this
 * script redraws, traces or re-styles the mark: every output is a crop and/or
 * a scale of those exact pixels, so the artwork stays identical to the file
 * the owner approved.
 *
 * Outputs (all written to public/assets):
 *   logo.png              exact supplied artwork (never rewritten here)
 *   favicon-32.png        32x32
 *   apple-touch-icon.png  180x180
 *   icon-192.png          192x192
 *   icon-512.png          512x512
 *   icon-maskable-512.png 512x512 with safe-zone padding for Android masks
 *   logo.svg              SVG wrapper embedding a scaled copy of the artwork
 *   icon.svg              SVG wrapper embedding the 512px app icon
 *
 * Pure Node (zlib only) so it runs anywhere the app builds.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const SRC = path.join(ASSETS, 'logo.png');

/* ------------------------------------------------------------------ CRC/PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i += 1) {
    if (buf[i] !== signature[i]) throw new Error(`${path.basename(file)} is not a PNG file`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('PNG header could not be read');
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (channels === 4) {
        pixels[o] = line[x * 4];
        pixels[o + 1] = line[x * 4 + 1];
        pixels[o + 2] = line[x * 4 + 2];
        pixels[o + 3] = line[x * 4 + 3];
      } else if (channels === 3) {
        pixels[o] = line[x * 3];
        pixels[o + 1] = line[x * 3 + 1];
        pixels[o + 2] = line[x * 3 + 2];
        pixels[o + 3] = 255;
      } else if (channels === 1) {
        const g = line[x];
        pixels[o] = g;
        pixels[o + 1] = g;
        pixels[o + 2] = g;
        pixels[o + 3] = 255;
      } else {
        const g = line[x * 2];
        pixels[o] = g;
        pixels[o + 1] = g;
        pixels[o + 2] = g;
        pixels[o + 3] = line[x * 2 + 1];
      }
    }
    prev = line;
  }
  return { width, height, pixels };
}

function encodePng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------- image manipulation */

/** Bounding box of the actual mark (everything that is not plain white). */
function markBox(img) {
  const { width, height, pixels } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const alpha = pixels[o + 3];
      if (alpha < 12) continue;
      const r = pixels[o];
      const g = pixels[o + 1];
      const b = pixels[o + 2];
      // White background and near-white antialiasing are not part of the mark.
      if (r > 244 && g > 244 && b > 244) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('No logo artwork found in the source image');
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Area-average downscale of a crop, keeping the artwork's colours intact. */
function scaleCrop(img, box, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const { width, pixels } = img;
  for (let y = 0; y < dh; y += 1) {
    const sy0 = box.y + Math.floor((y * box.h) / dh);
    const sy1 = Math.max(sy0 + 1, box.y + Math.floor(((y + 1) * box.h) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx0 = box.x + Math.floor((x * box.w) / dw);
      const sx1 = Math.max(sx0 + 1, box.x + Math.floor(((x + 1) * box.w) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < img.height; sy += 1) {
        for (let sx = sx0; sx < sx1 && sx < width; sx += 1) {
          const o = (sy * width + sx) * 4;
          const alpha = pixels[o + 3] / 255;
          // Composite onto white so every exported asset has a solid background.
          r += pixels[o] * alpha + 255 * (1 - alpha);
          g += pixels[o + 1] * alpha + 255 * (1 - alpha);
          b += pixels[o + 2] * alpha + 255 * (1 - alpha);
          a += 255;
          n += 1;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Square icon: the exact mark, centred on white at the requested fill ratio. */
function squareIcon(img, box, size, fillRatio) {
  const canvas = Buffer.alloc(size * size * 4, 255);
  let dw = Math.max(1, Math.round(size * fillRatio));
  let dh = Math.max(1, Math.round((dw * box.h) / box.w));
  if (dh > size * fillRatio) {
    dh = Math.round(size * fillRatio);
    dw = Math.round((dh * box.w) / box.h);
  }
  const scaled = scaleCrop(img, box, dw, dh);
  const ox = Math.floor((size - dw) / 2);
  const oy = Math.floor((size - dh) / 2);
  for (let y = 0; y < dh; y += 1) {
    scaled.copy(canvas, ((oy + y) * size + ox) * 4, y * dw * 4, y * dw * 4 + dw * 4);
  }
  return encodePng(size, size, canvas);
}

/* -------------------------------------------------------------------- build */

function write(file, data, results) {
  fs.writeFileSync(file, data);
  results.push({ file: path.relative(ROOT, file), bytes: fs.statSync(file).size });
}

function svgWrapper(file, png, viewW, viewH, label, results) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW} ${viewH}" width="${viewW}" height="${viewH}" role="img" aria-label="${label}">
  <title>WORKBRIDGE</title>
  <image href="data:image/png;base64,${png.toString('base64')}" x="0" y="0" width="${viewW}" height="${viewH}" preserveAspectRatio="xMidYMid meet" />
</svg>
`;
  write(file, Buffer.from(svg, 'utf8'), results);
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error('public/assets/logo.png (the approved artwork) is missing');
  const img = decodePng(SRC);
  const box = markBox(img);
  const results = [];

  // Non-destructive: logo.png stays byte-for-byte the approved file.
  const icons = [
    ['favicon-32.png', 32, 0.94],
    ['apple-touch-icon.png', 180, 0.86],
    ['icon-192.png', 192, 0.88],
    ['icon-512.png', 512, 0.88],
    ['icon-maskable-512.png', 512, 0.64] // Android safe zone keeps the mark inside the mask
  ];

  const built = {};
  for (const [name, size, ratio] of icons) {
    const png = squareIcon(img, box, size, ratio);
    built[name] = png;
    write(path.join(ASSETS, name), png, results);
  }

  // SVG wrappers embed a scaled copy of the exact artwork (no external fetch,
  // so they render correctly inside <img> tags and as a favicon).
  const logoPng = (() => {
    const dw = 768;
    const dh = Math.round((dw * box.h) / box.w);
    const canvas = Buffer.alloc(dw * dh * 4, 255);
    const scaled = scaleCrop(img, box, dw, dh);
    scaled.copy(canvas);
    return encodePng(dw, dh, canvas);
  })();
  svgWrapper(path.join(ASSETS, 'logo.svg'), logoPng, 1536, 1024, 'WORKBRIDGE logo: letter W containing a handshake', results);
  svgWrapper(path.join(ASSETS, 'icon.svg'), built['icon-512.png'], 512, 512, 'WORKBRIDGE app icon', results);

  // Verify what we just wrote actually decodes and has the expected dimensions.
  const expectations = {
    'favicon-32.png': [32, 32],
    'apple-touch-icon.png': [180, 180],
    'icon-192.png': [192, 192],
    'icon-512.png': [512, 512],
    'icon-maskable-512.png': [512, 512]
  };
  for (const [name, [w, h]] of Object.entries(expectations)) {
    const decoded = decodePng(path.join(ASSETS, name));
    if (decoded.width !== w || decoded.height !== h) {
      throw new Error(`${name} is ${decoded.width}x${decoded.height}, expected ${w}x${h}`);
    }
  }
  const svg = fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');
  if (!svg.includes('data:image/png;base64,') || !svg.includes('width="1536"')) {
    throw new Error('logo.svg was not written correctly');
  }

  console.log(`Source artwork: ${img.width}x${img.height}, mark box ${box.w}x${box.h} at (${box.x},${box.y})`);
  for (const row of results) console.log(`  ${row.file} — ${row.bytes} bytes`);
  console.log('All brand assets rebuilt from the exact approved artwork.');
}

try {
  main();
} catch (error) {
  console.error(`build-icons failed: ${error.message}`);
  process.exit(1);
}
