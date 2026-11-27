// Minimal zip writer and reader for exporting and importing the user area
// (configs, replays, saves: small files). No dependencies.
//
// Writer: stored (uncompressed) entries, UTF-8 names, no zip64 (the user area
// is far below 4 GB). Reader: stored and deflate entries (deflate through
// DecompressionStream('deflate-raw'), present in Chrome 103+, Firefox 113+,
// Safari 16.4+ and Node 18+), sizes taken from the central directory so zips
// written with data descriptors (macOS Finder, Windows Explorer) work.

let CRC_TABLE = null;
export function crc32(bytes, crc = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a zip. files: [{ path: 'ReACT/replay/vs00_0.rpd', data: Uint8Array, mtime?: Date }].
 * Directory entries are written for paths ending in '/'. Returns Uint8Array.
 */
export function writeZip(files) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const data = f.data || new Uint8Array(0);
    const crc = crc32(data);
    const { time, date } = dosDateTime(f.mtime || new Date());
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    locals.push(lh, data);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x031e, true); // made by: Unix, 3.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    const isDir = f.path.endsWith('/');
    cv.setUint32(38, ((isDir ? 0o40755 : 0o100644) << 16) >>> 0 | (isDir ? 0x10 : 0), true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, p); p += part.length; }
  return out;
}

export class ZipError extends Error {
  constructor(msg) { super(msg); this.name = 'ZipError'; }
}

/**
 * Validate an entry path from an untrusted zip. Returns the cleaned
 * '/'-separated path, or throws ZipError for absolute paths, drive letters,
 * backslashes, '..' or '.' components, and empty components.
 */
export function safeZipPath(p) {
  if (p.includes('\\')) throw new ZipError(`backslash in zip entry name: ${p}`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new ZipError(`absolute path in zip: ${p}`);
  const isDir = p.endsWith('/');
  const parts = (isDir ? p.slice(0, -1) : p).split('/');
  for (const c of parts) {
    if (c === '' || c === '.' || c === '..') throw new ZipError(`unsafe path component in zip entry: ${p}`);
    if (c.includes('\0')) throw new ZipError(`NUL in zip entry name`);
  }
  return parts.join('/') + (isDir ? '/' : '');
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new ZipError('deflate entries need DecompressionStream, not available here');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip. Returns [{ path, data: Uint8Array|null (null for directories), isDir }].
 * Paths are validated with safeZipPath. CRCs are checked.
 */
export async function readZip(bytes, { maxTotal = 256 << 20 } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a zip file (no end-of-central-directory record)');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError('zip64 archives are not supported');
  const dec = new TextDecoder();
  const out = [];
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('corrupt central directory');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const rawName = u8.subarray(p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw new ZipError('encrypted zip entries are not supported');
    const name = (flags & 0x0800) ? dec.decode(rawName) : String.fromCharCode(...rawName);
    if (name.startsWith('__MACOSX/')) continue; // Finder resource forks
    const path = safeZipPath(name);
    const isDir = path.endsWith('/');
    if (isDir) { out.push({ path, data: null, isDir }); continue; }
    total += usize;
    if (total > maxTotal) throw new ZipError(`zip expands past ${maxTotal} bytes; refusing`);
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new ZipError(`corrupt local header for ${path}`);
    const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const comp = u8.subarray(dataStart, dataStart + csize);
    if (comp.length !== csize) throw new ZipError(`truncated entry ${path}`);
    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = await inflateRaw(comp);
    else throw new ZipError(`unsupported compression method ${method} for ${path}`);
    if (data.length !== usize) throw new ZipError(`size mismatch for ${path}`);
    if (crc32(data) !== crc) throw new ZipError(`CRC mismatch for ${path}`);
    out.push({ path, data, isDir });
  }
  return out;
}
