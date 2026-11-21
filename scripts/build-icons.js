#!/usr/bin/env node
/**
 * Regenerate the WORKBRIDGE brand icons from the approved artwork.
 *
 * The approved logo is a single wide raster image (public/assets/logo.png). A
 * favicon and an installed app icon must be square PNGs at fixed sizes, so this
 * script crops the artwork to its mark, centres it on a white square canvas and
 * writes every size the browser, iOS and the PWA manifest ask for.
 *
 * It never redraws, traces or recolours the mark: every pixel comes from
 * logo.png. Run it after replacing that file:
 *
 *     node scripts/build-icons.js
 *
 * ImageMagick (`convert`) is used because it decodes and resamples PNG reliably;
 * this is a developer tool, not part of the application runtime or build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const SRC = path.join(ASSETS, 'logo.png');

/**
 * `content` is the size the mark itself is resized to before it is centred on
 * the `size` canvas. The maskable icon keeps a wider margin so Android's
 * circular/squircle masks never clip the mark.
 */
const ICONS = [
  { file: 'favicon-32.png', size: 32, content: 27 },
  { file: 'apple-touch-icon.png', size: 180, content: 155 },
  { file: 'icon-192.png', size: 192, content: 165 },
  { file: 'icon-512.png', size: 512, content: 440 },
  { file: 'icon-maskable-512.png', size: 512, content: 410 }
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (!fs.existsSync(SRC)) {
  throw new Error('public/assets/logo.png (the approved artwork) is missing');
}

// A file can be named .png and still not be a PNG — for example after being
// copied through a text pipeline that replaced its non-UTF-8 bytes. Fail loudly
// instead of writing icons that no browser can decode.
const source = fs.readFileSync(SRC);
if (!source.subarray(0, 8).equals(PNG_SIGNATURE)) {
  throw new Error(
    'public/assets/logo.png is not a valid PNG: the file signature is missing. ' +
      'Re-copy the approved artwork as a binary file (cp / upload, never through text).'
  );
}

for (const icon of ICONS) {
  const target = path.join(ASSETS, icon.file);
  execFileSync(
    'convert',
    [
      SRC,
      '-fuzz', '5%',
      '-trim', '+repage',
      '-resize', `${icon.content}x${icon.content}`,
      '-background', 'white',
      '-gravity', 'center',
      '-extent', `${icon.size}x${icon.size}`,
      '-strip',
      target
    ],
    { stdio: 'inherit' }
  );
  const written = fs.readFileSync(target);
  if (!written.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${icon.file} was not written as a valid PNG`);
  }
  console.log(`wrote public/assets/${icon.file} (${icon.size}x${icon.size})`);
}

console.log(`\n${ICONS.length} icons generated from public/assets/logo.png`);
