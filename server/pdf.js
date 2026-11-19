/**
 * Minimal, dependency-free PDF writer.
 *
 * Produces real PDF 1.4 files (correct xref table, base-14 fonts, embedded
 * JPEG images) so agreements and invoices can be downloaded, printed and
 * archived without a third-party rendering service.
 *
 * Layout is English-language on purpose: Arabic shaping requires an embedded
 * Arabic font, which the browser print view already handles. See README.
 */

import zlib from 'node:zlib';

import { formatMoney } from './currency.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function jpegDimensions(buffer) {
  let i = 2;
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2) break;
    i += 2 + length;
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads the IHDR/PLTE/IDAT chunks of a PNG file. */
function pngChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = { ihdr: null, palette: null, idat: [] };
  let pos = 8;
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > buffer.length) break;
    const data = buffer.subarray(start, end);
    if (type === 'IHDR' && length >= 13) {
      chunks.ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === 'PLTE') {
      chunks.palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      chunks.idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4;
  }
  if (!chunks.ihdr) return null;
  chunks.idat = Buffer.concat(chunks.idat);
  return chunks;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses the per-scanline PNG filters, returning raw samples. */
function unfilterPng(raw, width, height, channels) {
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paethPredictor(left, up, upLeft);
          break;
        default:
          return null;
      }
      out[rowStart + x] = restored & 0xff;
    }
  }
  return out;
}

/**
 * Converts a PNG data URL into an 8-bit RGB stream that PDF can embed.
 * Transparent pixels are composited over white, matching what the print view
 * shows on paper.
 */
function pngToRgb(buffer) {
  const chunks = pngChunks(buffer);
  if (!chunks || !chunks.idat.length) return null;
  const { width, height, bitDepth, colorType, interlace } = chunks.ihdr;
  if (!width || !height || interlace !== 0 || bitDepth !== 8) return null;
  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) return null;

  let raw;
  try {
    raw = zlib.inflateSync(chunks.idat);
  } catch {
    return null;
  }
  const samples = unfilterPng(raw, width, height, channels);
  if (!samples) return null;

  const rgb = Buffer.alloc(width * height * 3);
  const pixels = width * height;
  for (let i = 0, src = 0, dst = 0; i < pixels; i += 1, src += channels, dst += 3) {
    let r;
    let g;
    let b;
    if (colorType === 0 || colorType === 4) {
      r = g = b = samples[src];
    } else if (colorType === 2 || colorType === 6) {
      r = samples[src];
      g = samples[src + 1];
      b = samples[src + 2];
    } else {
      const index = samples[src] * 3;
      if (!chunks.palette || index + 2 >= chunks.palette.length) return null;
      r = chunks.palette[index];
      g = chunks.palette[index + 1];
      b = chunks.palette[index + 2];
    }
    const alpha = colorType === 4 ? samples[src + 1] : colorType === 6 ? samples[src + 3] : 255;
    if (alpha < 255) {
      const back = 255 - alpha;
      r = Math.round((r * alpha + 255 * back) / 255);
      g = Math.round((g * alpha + 255 * back) / 255);
      b = Math.round((b * alpha + 255 * back) / 255);
    }
    rgb[dst] = r;
    rgb[dst + 1] = g;
    rgb[dst + 2] = b;
  }

  return { width, height, buffer: zlib.deflateSync(rgb), filter: 'FlateDecode' };
}

/**
 * Accepts the JPEG and PNG data URLs the app stores for signatures and stamps.
 * Both are embedded; anything else is reported as unsupported so callers can
 * fall back to a visible label instead of silently losing the image.
 */
function parseImage(dataUrl) {
  const value = String(dataUrl || '');
  const jpeg = /^data:image\/(?:jpeg|jpg);base64,(.+)$/i.exec(value);
  if (jpeg) {
    const buffer = Buffer.from(jpeg[1], 'base64');
    const size = jpegDimensions(buffer);
    if (!size || !size.width || !size.height) return null;
    return { buffer, ...size, filter: 'DCTDecode' };
  }
  const png = /^data:image\/png;base64,(.+)$/i.exec(value);
  if (png) {
    const decoded = pngToRgb(Buffer.from(png[1], 'base64'));
    if (!decoded) return null;
    return { ...decoded, filter: 'FlateDecode' };
  }
  return null;
}

export class PdfDoc {
  constructor({ title = 'WORKBRIDGE document' } = {}) {
    this.title = title;
    this.pages = [];
    this.images = [];
    this.page = null;
    this.newPage();
  }

  newPage() {
    this.page = [];
    this.pages.push(this.page);
  }

  _y(top) {
    return PAGE_H - top;
  }

  text(value, x, top, { size = 11, bold = false, color = [0.1, 0.1, 0.1], align = 'left' } = {}) {
    const raw = escapeText(value);
    if (!raw) return;
    let xPos = x;
    if (align !== 'left') {
      const width = this.widthOf(raw, size, bold);
      xPos = align === 'right' ? x - width : x - width / 2;
    }
    this.page.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color[0]} ${color[1]} ${color[2]} rg ` +
        `1 0 0 1 ${xPos.toFixed(2)} ${this._y(top).toFixed(2)} Tm (${raw}) Tj ET`
    );
  }

  widthOf(value, size = 11, bold = false) {
    return String(value || '').length * size * (bold ? 0.55 : 0.5);
  }

  line(x1, top1, x2, top2, { width = 0.7, color = [0.78, 0.8, 0.84] } = {}) {
    this.page.push(
      `${color[0]} ${color[1]} ${color[2]} RG ${width} w ` +
        `${x1.toFixed(2)} ${this._y(top1).toFixed(2)} m ${x2.toFixed(2)} ${this._y(top2).toFixed(2)} l S`
    );
  }

  rect(x, top, w, h, { fill = [0.96, 0.97, 0.99], stroke = null, width = 0.7 } = {}) {
    const y = this._y(top + h);
    const ops = [];
    if (fill) ops.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
    if (stroke) ops.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG ${width} w`);
    ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.page.push(ops.join(' '));
  }

  _place(parsed, x, top, w, h) {
    this.images.push(parsed);
    const name = `Im${this.images.length}`;
    const y = this._y(top + h);
    this.page.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`);
    return true;
  }

  image(dataUrl, x, top, w, h) {
    const parsed = parseImage(dataUrl);
    if (!parsed) return false;
    return this._place(parsed, x, top, w, h);
  }

  /**
   * Draws an image centred inside a box without distorting it, which is how the
   * print view lays out signatures and stamps.
   */
  imageFit(dataUrl, x, top, maxW, maxH) {
    const parsed = parseImage(dataUrl);
    if (!parsed) return false;
    const scale = Math.min(maxW / parsed.width, maxH / parsed.height);
    const w = parsed.width * scale;
    const h = parsed.height * scale;
    return this._place(parsed, x + (maxW - w) / 2, top + (maxH - h) / 2, w, h);
  }

  /** Wraps text to a width in points, returning the rendered lines. */
  wrap(value, maxWidth, size = 11, bold = false) {
    const words = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (this.widthOf(candidate, size, bold) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  paragraph(value, x, top, maxWidth, { size = 10.5, bold = false, lineHeight = 14, color } = {}) {
    let cursor = top;
    for (const line of this.wrap(value, maxWidth, size, bold)) {
      this.text(line, x, cursor, { size, bold, color });
      cursor += lineHeight;
    }
    return cursor;
  }

  toBuffer() {
    const bodies = [];
    const add = (body) => {
      bodies.push(body);
      return bodies.length;
    };

    const catalogNo = add(null); // 1
    const pagesNo = add(null); // 2
    const fontRegular = add(
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>'
    );
    const fontBold = add('<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>');

    const imageNos = this.images.map((img) =>
      add({
        dict:
          `<</Type/XObject/Subtype/Image/Width ${img.width}/Height ${img.height}` +
          `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/${img.filter || 'DCTDecode'}` +
          `/Length ${img.buffer.length}>>`,
        stream: img.buffer
      })
    );

    const xObjectEntries = imageNos.map((no, index) => `/Im${index + 1} ${no} 0 R`).join(' ');
    const pageNos = [];
    for (const ops of this.pages) {
      const content = Buffer.from(`${ops.join('\n')}\n`, 'latin1');
      const contentNo = add({ dict: `<</Length ${content.length}>>`, stream: content });
      const pageNo = add(
        `<</Type/Page/Parent ${pagesNo} 0 R/MediaBox[0 0 ${PAGE_W} ${PAGE_H}]` +
          `/Resources<</Font<</F1 ${fontRegular} 0 R/F2 ${fontBold} 0 R>>` +
          (xObjectEntries ? `/XObject<<${xObjectEntries}>>` : '') +
          `>>/Contents ${contentNo} 0 R>>`
      );
      pageNos.push(pageNo);
    }

    bodies[catalogNo - 1] = `<</Type/Catalog/Pages ${pagesNo} 0 R>>`;
    bodies[pagesNo - 1] =
      `<</Type/Pages/Count ${pageNos.length}/Kids[${pageNos.map((n) => `${n} 0 R`).join(' ')}]>>`;

    const chunks = [];
    let offset = 0;
    const push = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
      chunks.push(buffer);
      offset += buffer.length;
    };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const offsets = [];
    bodies.forEach((body, index) => {
      const no = index + 1;
      offsets[no] = offset;
      if (typeof body === 'string') {
        push(`${no} 0 obj\n${body}\nendobj\n`);
      } else {
        push(`${no} 0 obj\n${body.dict}\nstream\n`);
        push(body.stream);
        push('\nendstream\nendobj\n');
      }
    });

    const xrefStart = offset;
    let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
    for (let no = 1; no <= bodies.length; no += 1) {
      xref += `${String(offsets[no]).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);
    push(
      `trailer\n<</Size ${bodies.length + 1}/Root ${catalogNo} 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`
    );

    return Buffer.concat(chunks);
  }
}

const NAVY = [0.06, 0.16, 0.31];
const ORANGE = [0.95, 0.45, 0.09];
const GREY = [0.42, 0.45, 0.5];

function header(doc, title, reference, dateLabel) {
  doc.rect(0, 0, PAGE_W, 74, { fill: NAVY });
  doc.rect(0, 74, PAGE_W, 3, { fill: ORANGE });
  doc.text('WORKBRIDGE', 40, 34, { size: 19, bold: true, color: [1, 1, 1] });
  doc.text('Booking • Agreement • Institutional & Social Support • Invoice Maker', 40, 52, {
    size: 8,
    color: [0.85, 0.88, 0.94]
  });
  doc.text(title, PAGE_W - 40, 34, { size: 15, bold: true, color: [1, 1, 1], align: 'right' });
  doc.text(reference, PAGE_W - 40, 52, { size: 9, color: [0.85, 0.88, 0.94], align: 'right' });
  doc.text(dateLabel, PAGE_W - 40, 64, { size: 9, color: [0.85, 0.88, 0.94], align: 'right' });
}

function partyBox(doc, { label, name, lines }, x, top, width) {
  doc.rect(x, top, width, 86, { fill: [0.96, 0.97, 0.99], stroke: [0.85, 0.87, 0.9] });
  doc.text(label.toUpperCase(), x + 12, top + 18, { size: 8, bold: true, color: GREY });
  doc.text(name || '—', x + 12, top + 34, { size: 11, bold: true, color: NAVY });
  let y = top + 50;
  for (const line of lines.filter(Boolean)) {
    doc.text(line, x + 12, y, { size: 9, color: [0.28, 0.3, 0.34] });
    y += 12;
  }
}

function footer(doc, note) {
  doc.line(40, PAGE_H - 58, PAGE_W - 40, PAGE_H - 58);
  doc.text('Generated by WORKBRIDGE', 40, PAGE_H - 44, { size: 8, color: GREY });
  doc.text(note, PAGE_W - 40, PAGE_H - 44, { size: 8, color: GREY, align: 'right' });
}

function signatureBlock(doc, agreement, top) {
  const roles = [
    ['business', 'Company / Contractor signature', agreement.business?.company_name],
    ['worker', 'Worker signature', agreement.worker?.full_name]
  ];
  doc.text('Electronic signatures', 40, top, { size: 11, bold: true, color: NAVY });
  let y = top + 16;
  const boxWidth = (PAGE_W - 80 - 16) / 2;

  roles.forEach(([role, label, name], index) => {
    const signature = agreement.signatures?.[role];
    const x = 40 + index * (boxWidth + 16);
    doc.rect(x, y, boxWidth, 96, { fill: [1, 1, 1], stroke: [0.85, 0.87, 0.9] });
    doc.text(label, x + 10, y + 14, { size: 8, color: GREY });
    if (signature?.signature) {
      const embedded = doc.image(signature.signature, x + 10, y + 20, boxWidth - 20, 50);
      if (!embedded) {
        doc.text('Signed electronically', x + 10, y + 46, { size: 10, bold: true, color: NAVY });
      }
    } else {
      doc.text('Awaiting signature', x + 10, y + 46, { size: 10, color: [0.6, 0.62, 0.66] });
    }
    doc.line(x + 10, y + 76, x + boxWidth - 10, y + 76);
    doc.text(signature?.name || name || '', x + 10, y + 88, { size: 9, bold: true });
    if (signature?.signed_at) {
      doc.text(
        `Signed ${new Date(signature.signed_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        x + boxWidth - 10,
        y + 88,
        { size: 7, color: GREY, align: 'right' }
      );
    }
  });

  return y + 96;
}

export function buildAgreementPdf(agreement, { generatedAt = new Date() } = {}) {
  const doc = new PdfDoc({ title: `Agreement ${agreement.ref}` });
  header(
    doc,
    'EMPLOYMENT AGREEMENT',
    `Ref ${agreement.ref}`,
    generatedAt.toISOString().slice(0, 10)
  );

  let y = 104;
  const half = (PAGE_W - 80 - 16) / 2;
  partyBox(
    doc,
    {
      label: 'Company / Contractor',
      name: agreement.business?.company_name,
      lines: [
        agreement.business?.contact_name ? `Contact: ${agreement.business.contact_name}` : '',
        agreement.business?.phone ? `Phone: ${agreement.business.phone}` : '',
        agreement.business?.address || '',
        agreement.business?.country || ''
      ]
    },
    40,
    y,
    half
  );
  partyBox(
    doc,
    {
      label: 'Worker',
      name: agreement.worker?.full_name,
      lines: [
        agreement.worker?.category ? `Category: ${agreement.worker.category}` : '',
        agreement.worker?.phone ? `Phone: ${agreement.worker.phone}` : '',
        agreement.worker?.aqama_masked ? `Aqama: ${agreement.worker.aqama_masked}` : ''
      ]
    },
    40 + half + 16,
    y,
    half
  );

  y += 110;
  doc.text('Work description', 40, y, { size: 11, bold: true, color: NAVY });
  y = doc.paragraph(agreement.scope || '—', 40, y + 16, PAGE_W - 80, { size: 10 });

  y += 12;
  doc.text('Agreed terms', 40, y, { size: 11, bold: true, color: NAVY });
  y = doc.paragraph(agreement.terms || '—', 40, y + 16, PAGE_W - 80, { size: 10 });

  y += 14;
  doc.rect(40, y, PAGE_W - 80, 64, { fill: [0.96, 0.97, 0.99], stroke: [0.85, 0.87, 0.9] });
  doc.text('Agreed pay', 52, y + 16, { size: 8, bold: true, color: GREY });
  doc.text(
    `${formatMoney(agreement.pay_amount, agreement.currency)} per ${agreement.pay_period}`,
    52,
    y + 34,
    { size: 13, bold: true, color: NAVY }
  );
  doc.text('Period', PAGE_W / 2, y + 16, { size: 8, bold: true, color: GREY });
  doc.text(
    `${agreement.start_date || '—'} → ${agreement.end_date || 'ongoing'}`,
    PAGE_W / 2,
    y + 34,
    { size: 10 }
  );
  doc.text('Status', PAGE_W - 52, y + 16, { size: 8, bold: true, color: GREY, align: 'right' });
  doc.text(String(agreement.status || '').replace(/_/g, ' ').toUpperCase(), PAGE_W - 52, y + 34, {
    size: 10,
    bold: true,
    align: 'right'
  });

  // Commission is shown on the agreement (never on an invoice) using the
  // percentage that was in force when the agreement was created.
  if (agreement.commission_rate) {
    doc.text(
      `Platform commission ${agreement.commission_rate}%${
        agreement.commission_amount
          ? ` (${formatMoney(agreement.commission_amount, agreement.currency)})`
          : ''
      } - paid by ${agreement.commission_payer || 'business'}`,
      52,
      y + 52,
      { size: 8, color: GREY }
    );
  }

  y += 84;
  if (y > PAGE_H - 240) {
    doc.newPage();
    y = 60;
  }
  signatureBlock(doc, agreement, y);
  footer(doc, agreement.ref);
  return doc.toBuffer();
}

export function buildInvoicePdf(invoice, { generatedAt = new Date() } = {}) {
  const doc = new PdfDoc({ title: `Invoice ${invoice.serial}` });
  header(doc, 'INVOICE', `No ${invoice.serial}`, generatedAt.toISOString().slice(0, 10));

  let y = 104;
  const half = (PAGE_W - 80 - 16) / 2;
  partyBox(
    doc,
    {
      label: 'From',
      name: invoice.issuer_name,
      lines: [
        invoice.issuer_phone ? `Phone: ${invoice.issuer_phone}` : '',
        invoice.issuer_address || '',
        invoice.issuer_country || ''
      ]
    },
    40,
    y,
    half
  );
  partyBox(
    doc,
    {
      label: 'Bill to',
      name: invoice.client_name,
      lines: [
        invoice.client_phone ? `Phone: ${invoice.client_phone}` : '',
        invoice.client_address || '',
        invoice.client_country || ''
      ]
    },
    40 + half + 16,
    y,
    half
  );

  y += 112;
  const columns = [40, 330, 400, 470, PAGE_W - 40];
  doc.rect(40, y, PAGE_W - 80, 22, { fill: NAVY });
  doc.text('Description', columns[0] + 8, y + 15, { size: 9, bold: true, color: [1, 1, 1] });
  doc.text('Qty', columns[1], y + 15, { size: 9, bold: true, color: [1, 1, 1], align: 'right' });
  doc.text('Unit price', columns[2], y + 15, {
    size: 9,
    bold: true,
    color: [1, 1, 1],
    align: 'right'
  });
  doc.text('Amount', columns[4] - 8, y + 15, {
    size: 9,
    bold: true,
    color: [1, 1, 1],
    align: 'right'
  });

  y += 22;
  for (const item of invoice.items || []) {
    const lines = doc.wrap(item.description, 270, 9.5);
    const rowHeight = Math.max(20, lines.length * 12 + 8);
    if (y + rowHeight > PAGE_H - 200) {
      doc.newPage();
      y = 60;
    }
    doc.line(40, y + rowHeight, PAGE_W - 40, y + rowHeight);
    lines.forEach((line, index) => doc.text(line, columns[0] + 8, y + 14 + index * 12, { size: 9.5 }));
    doc.text(String(item.quantity), columns[1], y + 14, { size: 9.5, align: 'right' });
    doc.text(formatMoney(item.unit_price, invoice.currency), columns[2], y + 14, {
      size: 9.5,
      align: 'right'
    });
    doc.text(formatMoney(item.amount ?? item.quantity * item.unit_price, invoice.currency), columns[4] - 8, y + 14, {
      size: 9.5,
      align: 'right'
    });
    y += rowHeight;
  }

  y += 14;
  const totalsX = PAGE_W - 240;
  const rows = [
    ['Subtotal', formatMoney(invoice.subtotal, invoice.currency)],
    [`VAT (${invoice.vat_rate}%)`, formatMoney(invoice.vat_amount, invoice.currency)],
    ['Total', formatMoney(invoice.total, invoice.currency)]
  ];
  rows.forEach(([label, value], index) => {
    const bold = index === rows.length - 1;
    if (bold) doc.line(totalsX, y - 6, PAGE_W - 40, y - 6, { width: 1 });
    doc.text(label, totalsX, y + 10, { size: bold ? 11 : 9.5, bold });
    doc.text(value, PAGE_W - 40, y + 10, { size: bold ? 12 : 9.5, bold, align: 'right' });
    y += bold ? 24 : 16;
  });

  if (invoice.notes) {
    y += 10;
    doc.text('Notes', 40, y, { size: 10, bold: true, color: NAVY });
    y = doc.paragraph(invoice.notes, 40, y + 14, PAGE_W - 80, { size: 9.5 });
  }

  const stampTop = Math.max(y + 20, PAGE_H - 200);
  doc.text('Authorised signature', 40, stampTop, { size: 8, bold: true, color: GREY });
  doc.rect(40, stampTop + 8, 220, 86, { fill: [1, 1, 1], stroke: [0.85, 0.87, 0.9] });
  if (invoice.signature) {
    if (!doc.imageFit(invoice.signature, 48, stampTop + 14, 204, 56)) {
      doc.text('Signed electronically', 48, stampTop + 44, { size: 9, color: NAVY });
    }
  }
  doc.line(48, stampTop + 78, 252, stampTop + 78);
  doc.text(invoice.issuer_name || '', 48, stampTop + 90, { size: 9, bold: true });

  if (invoice.stamp) {
    doc.text('Company stamp', 300, stampTop, { size: 8, bold: true, color: GREY });
    doc.rect(300, stampTop + 8, 120, 86, { fill: [1, 1, 1], stroke: [0.85, 0.87, 0.9] });
    if (!doc.imageFit(invoice.stamp, 306, stampTop + 14, 108, 74)) {
      doc.text('Company stamp on file', 312, stampTop + 50, { size: 8, color: GREY });
    }
  }

  footer(doc, invoice.serial);
  return doc.toBuffer();
}
