'use strict';

/**
 * Profile photos: what is accepted, and what a report is.
 *
 * The app crops each photo to a square and shrinks it in the browser, sending a 512 px picture and a 128 px thumbnail.
 * The server never trusts that: it reads the real file type and size from the bytes, and refuses anything that is not
 * a small JPEG, PNG or WebP picture of a sensible size.
 */

const FULL_MAX_BYTES = 400 * 1024;
const THUMB_MAX_BYTES = 48 * 1024;
const FULL_MAX_PX = 1024;
const MIN_PX = 64;
const THUMB_MAX_PX = 256;

const REASONS = [
  { id: 'nudity', label: 'Nudity or sexual content' },
  { id: 'child_safety', label: 'Puts a child at risk' },
  { id: 'harassment', label: 'Harassment or hate' },
  { id: 'violence', label: 'Violence or something shocking' },
  { id: 'impersonation', label: 'Pretends to be someone else' },
  { id: 'other', label: 'Something else' },
];

/** Reports from this many different people hide a photo from everyone but its owner until an administrator looks. */
const AUTO_HIDE_AT = 3;
/** A report that a child may be at risk hides the photo at once. */
const URGENT = ['child_safety'];
const REPORTS_PER_DAY = 20;

/** `{ mime, width, height }` read from the file's own bytes, or null when it is not a JPEG, PNG or WebP picture. */
function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segments to the frame header.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ' && buf.length >= 30) return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X' && buf.length >= 30) return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/** Bytes from a Buffer (socket) or a base64 string (REST). */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(v.replace(/^data:[^,]*,/, '')) && v.length < 2 * FULL_MAX_BYTES) return Buffer.from(v.replace(/^data:[^,]*,/, ''), 'base64');
  return null;
}

/** Check a photo and its thumbnail. Returns `{ full, thumb, mime, thumbMime }` or throws `{ status: 400|413|415, code, message }`. */
function check({ image, thumb }) {
  const bad = (status, code, message) => Object.assign(new Error(message), { status, code });
  const full = toBuffer(image);
  const small = toBuffer(thumb);
  if (!full || !small) throw bad(400, 'invalid_request', 'Send the photo and its thumbnail (`image` and `thumb`, as bytes or base64)');
  if (full.length > FULL_MAX_BYTES || small.length > THUMB_MAX_BYTES) throw bad(413, 'too_large', 'The photo is too large (the app shrinks it first: at most 400 KB, and 48 KB for the thumbnail)');
  const a = inspect(full);
  const b = inspect(small);
  if (!a || !b) throw bad(415, 'unsupported_media_type', 'Use a JPEG, PNG or WebP picture');
  if (a.width < MIN_PX || a.height < MIN_PX || a.width > FULL_MAX_PX || a.height > FULL_MAX_PX) throw bad(400, 'invalid_request', `The photo must be between ${MIN_PX} and ${FULL_MAX_PX} pixels on each side`);
  if (b.width > THUMB_MAX_PX || b.height > THUMB_MAX_PX) throw bad(400, 'invalid_request', `The thumbnail must be at most ${THUMB_MAX_PX} pixels on each side`);
  return { full, thumb: small, mime: a.mime, thumbMime: b.mime };
}

module.exports = { FULL_MAX_BYTES, THUMB_MAX_BYTES, REASONS, AUTO_HIDE_AT, URGENT, REPORTS_PER_DAY, inspect, toBuffer, check };
