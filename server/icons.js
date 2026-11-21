/**
 * Brand icon generator.
 *
 * The approved artwork lives in public/assets/logo.png exactly as supplied: a
 * wide image with white margins around the mark. A wide image is wrong for a
 * favicon or an installed app icon — those need a square canvas with the mark
 * centred inside a safe margin — and an installed PWA keeps whatever icon it
 * was installed with until the icon URL changes.
 *
 * Rather than shipping a build step that has to run before every deploy, the
 * required sizes are derived from those exact bytes at request time:
 *
 *   32    browser favicon
 *   180   Apple touch icon
 *   192   Android / manifest
 *   512   manifest, splash and store-quality icon
 *   512   maskable variant with the larger safe zone Android asks for
 *
 * Nothing is redrawn: the source pixels are located (non-white bounding box),
 * cropped to a square around that box, scaled with area averaging and encoded
 * as PNG. Results are cached in memory. If the source file is ever replaced
 * with something unexpected, the route logs once and falls through to the
 * static file, so the app can never serve a broken image.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';

const SOURCE_PATH = path.join(config.root, 'public', 'assets', 'logo.png');

/** A pixel at or above this value on every channel is treated as background. */
const WHITE = 245;

export const ICON_ROUTES = {
  '/assets/favicon-32.png': { size: 32, padding: 1.08 },
  '/assets/apple-touch-icon.png': { size: 180, padding: 1.14 },
  '/assets/icon-192.png': { size: 192, padding: 1.14 },
  '/assets/icon-512.png': { size: 512, padding: 1.14 },
  '/assets/icon-maskable-512.png': { size: 512, padding: 1.5 }
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

/** Minimal PNG decoder: 8-bit, non-interlaced, grey/RGB/palette/grey+alpha/RGBA. */
function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not_a_png');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const parts = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const body = buffer.subarray(start, start + length);
    offset = start + length + 4;

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error('png_header_missing');
  if (depth !== 8) throw new Error('png_bit_depth_unsupported');
  if (interlace !== 0) throw new Error('png_interlaced_unsupported');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('png_color_type_unsupported');

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('png_data_truncated');

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const value = line[i];
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let result;

      if (filter === 0) {
        result = value;
      } else if (filter === 1) {
        result = value + a;
      } else if (filter === 2) {
        result = value + b;
      } else if (filter === 3) {
        result = value + ((a + b) >> 1);
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else {
        throw new Error('png_filter_unsupported');
      }

      out[i] = result & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0, p = 0; index < width * height; index += 1, p += channels) {
    const o = index * 4;
    if (colorType === 0) {
      rgba[o] = pixels[p];
      rgba[o + 1] = pixels[p];
      rgba[o + 2] = pixels[p];
      rgba[o + 3] = 255;
    } else if (colorType === 2) {
      rgba[o] = pixels[p];
      rgba[o + 1] = pixels[p + 1];
      rgba[o + 2] = pixels[p + 2];
      rgba[o + 3] = 255;
    } else if (colorType === 3) {
      if (!palette) throw new Error('png_palette_missing');
      const entry = pixels[p];
      rgba[o] = palette[entry * 3];
      rgba[o + 1] = palette[entry * 3 + 1];
      rgba[o + 2] = palette[entry * 3 + 2];
      rgba[o + 3] = transparency && entry < transparency.length ? transparency[entry] : 255;
    } else if (colorType === 4) {
      rgba[o] = pixels[p];
      rgba[o + 1] = pixels[p];
      rgba[o + 2] = pixels[p];
      rgba[o + 3] = pixels[p + 1];
    } else {
      rgba[o] = pixels[p];
      rgba[o + 1] = pixels[p + 1];
      rgba[o + 2] = pixels[p + 2];
      rgba[o + 3] = pixels[p + 3];
    }
  }

  return { width, height, rgba };
}

/** Bounding box of everything that is not background. */
function inkBounds(image) {
  const { width, height, rgba } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] < 16) continue;
      if (rgba[i] > WHITE && rgba[i + 1] > WHITE && rgba[i + 2] > WHITE) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0 || maxY < 0) throw new Error('artwork_bounding_box_not_found');
  return { minX, minY, maxX: maxX + 1, maxY: maxY + 1 };
}

/** Square crop centred on the artwork, scaled to `size` with area averaging. */
function renderIcon(image, bounds, size, padding) {
  const { width, height, rgba } = image;
  const boxWidth = bounds.maxX - bounds.minX;
  const boxHeight = bounds.maxY - bounds.minY;
  const side = Math.max(boxWidth, boxHeight) * padding;
  const left = (bounds.minX + bounds.maxX) / 2 - side / 2;
  const top = (bounds.minY + bounds.maxY) / 2 - side / 2;
  const step = side / size;
  const area = step * step;
  const out = Buffer.alloc(size * size * 3);

  for (let y = 0; y < size; y += 1) {
    const sampleTop = top + y * step;
    const sampleBottom = sampleTop + step;
    const yStart = Math.max(0, Math.floor(sampleTop));
    const yEnd = Math.min(height, Math.ceil(sampleBottom));

    for (let x = 0; x < size; x += 1) {
      const sampleLeft = left + x * step;
      const sampleRight = sampleLeft + step;
      const xStart = Math.max(0, Math.floor(sampleLeft));
      const xEnd = Math.min(width, Math.ceil(sampleRight));
      const target = (y * size + x) * 3;

      let red = 0;
      let green = 0;
      let blue = 0;
      let covered = 0;

      for (let py = yStart; py < yEnd; py += 1) {
        const weightY = Math.min(py + 1, sampleBottom) - Math.max(py, sampleTop);
        if (weightY <= 0) continue;
        for (let px = xStart; px < xEnd; px += 1) {
          const weightX = Math.min(px + 1, sampleRight) - Math.max(px, sampleLeft);
          if (weightX <= 0) continue;
          const weight = weightX * weightY;
          const i = (py * width + px) * 4;
          const alpha = rgba[i + 3] / 255;
          red += (rgba[i] * alpha + 255 * (1 - alpha)) * weight;
          green += (rgba[i + 1] * alpha + 255 * (1 - alpha)) * weight;
          blue += (rgba[i + 2] * alpha + 255 * (1 - alpha)) * weight;
          covered += weight;
        }
      }

      // Anything outside the artwork is white, matching the supplied background.
      const background = Math.max(0, area - covered);
      out[target] = Math.round((red + 255 * background) / area);
      out[target + 1] = Math.round((green + 255 * background) / area);
      out[target + 2] = Math.round((blue + 255 * background) / area);
    }
  }

  return out;
}

function encodePng(size, rgb) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

let source = null;
const generated = new Map();

function loadSource() {
  if (!source) {
    const image = decodePng(fs.readFileSync(SOURCE_PATH));
    source = { image, bounds: inkBounds(image) };
  }
  return source;
}

/** Returns the PNG bytes for one of ICON_ROUTES. */
export function iconPng(route) {
  const spec = ICON_ROUTES[route];
  if (!spec) throw new Error(`unknown_icon_route: ${route}`);
  if (generated.has(route)) return generated.get(route);

  const { image, bounds } = loadSource();
  const buffer = encodePng(spec.size, renderIcon(image, bounds, spec.size, spec.padding));
  generated.set(route, buffer);
  return buffer;
}

/**
 * Registers the icon routes. Mount this BEFORE express.static so a generated
 * icon always wins over the raw artwork that sits at the same path.
 */
export function mountIconRoutes(app) {
  for (const route of Object.keys(ICON_ROUTES)) {
    app.get(route, (req, res, next) => {
      try {
        const buffer = iconPng(route);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        res.end(buffer);
      } catch (error) {
        console.warn(
          `[workbridge] could not generate ${route} (${error.message}); serving the static file instead.`
        );
        next();
      }
    });
  }
}
