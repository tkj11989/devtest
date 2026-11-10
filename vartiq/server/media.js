'use strict';

/**
 * What can be sent as a photo, video or document in a chat, and how a file is checked.
 *
 * A file that is not end-to-end encrypted is checked by its first bytes, so a program cannot pass as a picture. A file the app
 * encrypted can only be checked by what the sender says it is (the server never sees inside), so downloads are always served as
 * a harmless download (`nosniff`, a locked-down policy, and `attachment` for anything that is not a picture or a video).
 */

const KINDS = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'],
  file: [
    'application/pdf', 'text/plain', 'text/csv', 'application/json', 'application/rtf', 'application/zip',
    'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
  ],
};

/** Names that are programs or web pages: never accepted as a document (checked on plain uploads; the app also refuses to open them). */
const BLOCKED_NAME = /\.(exe|msi|bat|cmd|com|scr|pif|js|mjs|vbs|vbe|wsf|jar|apk|sh|ps1|dll|lnk|reg|html?|xhtml|svg|swf)$/i;

const starts = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf, at, text) => buf.length >= at + text.length && buf.toString('latin1', at, at + text.length) === text;

/** Does the beginning of the file look like what it says it is? */
function sniff(mime, buf) {
  if (!buf.length) return false;
  switch (mime) {
    case 'image/jpeg': return starts(buf, [0xff, 0xd8, 0xff]);
    case 'image/png': return starts(buf, [0x89, 0x50, 0x4e, 0x47]);
    case 'image/gif': return ascii(buf, 0, 'GIF8');
    case 'image/webp': return ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP');
    case 'video/mp4': case 'video/quicktime': case 'video/3gpp': return ascii(buf, 4, 'ftyp');
    case 'video/webm': return starts(buf, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'application/pdf': return ascii(buf, 0, '%PDF');
    case 'application/rtf': return ascii(buf, 0, '{\\rtf');
    case 'application/zip': case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    case 'application/vnd.oasis.opendocument.text': case 'application/vnd.oasis.opendocument.spreadsheet': case 'application/vnd.oasis.opendocument.presentation':
      return starts(buf, [0x50, 0x4b, 0x03, 0x04]);
    case 'application/msword': case 'application/vnd.ms-excel': case 'application/vnd.ms-powerpoint': return starts(buf, [0xd0, 0xcf, 0x11, 0xe0]);
    case 'text/plain': case 'text/csv': case 'application/json': {
      const head = buf.subarray(0, 4096);
      if (head.includes(0)) return false;
      try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return true; } catch { return false; }
    }
    default: return false;
  }
}

/** The kind a MIME type belongs to ('image', 'video', 'file'), or null when it is not allowed. */
const kindOf = (mime) => Object.keys(KINDS).find((k) => KINDS[k].includes(mime)) || null;

/** A file name safe to show and to save under: no folders, no control characters, at most 120 characters. */
function cleanName(name, fallback = 'file') {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(-120);
  return n || fallback;
}

/** A small preview picture as a data URL, or null if it is not one (at most `max` characters). */
const cleanThumb = (t, max = 24000) => (typeof t === 'string' && t.length <= max && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(t) ? t : null);

/** Headers that make a download harmless: pictures and videos show in place, everything else is saved, never run. */
function downloadHeaders(meta, name) {
  const inline = /^(image|video)\//.test(meta.mime) && !meta.encrypted;
  return {
    'Content-Type': meta.encrypted ? 'application/octet-stream' : meta.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, max-age=31536000, immutable',
    ...(inline ? {} : { 'Content-Disposition': `attachment; filename="${cleanName(name, 'file').replace(/"/g, '')}"` }),
  };
}

module.exports = { KINDS, BLOCKED_NAME, sniff, kindOf, cleanName, cleanThumb, downloadHeaders };
