// Decoder and self-check for the game's `.p` archive table (BROWSER_PORT_PLAN.md
// §2.6 and Appendix B). Pure functions, no I/O: callers hand in the bytes.
//
// Layout:
//   u32 flags                 0 in most archives, 1 in the two MP3 archives
//   u32 count ^ KEY
//   count x 0x44-byte entries:
//     char name[0x3B]         byte j of entry i XOR ((i*j*3 + 0x3D) & 0xFF)
//     u8   pad                (to 0x3C)
//     u32  offset             plain
//     u32  size ^ KEY
// Entry bodies follow the table. Only the table is decoded here; bodies are
// obfuscated too, but the recompiled game decodes them itself.

export const P_KEY = 0xe3df59ac;
export const P_HEADER_SIZE = 8;
export const P_ENTRY_SIZE = 0x44;
const NAME_LEN = 0x3b;

/** Decoded entry count from the first 8 bytes. */
export function pEntryCount(header) {
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return (dv.getUint32(4, true) ^ P_KEY) >>> 0;
}

/** Number of bytes of header + table for a given count. */
export function pTableBytes(count) {
  return P_HEADER_SIZE + count * P_ENTRY_SIZE;
}

/**
 * Highest plausible entry count for a file of this size: every entry needs a
 * table slot. A corrupt header decodes to billions, so callers must check the
 * count against this before reading the table.
 */
export function pMaxCount(fileSize) {
  return Math.max(0, Math.floor((fileSize - P_HEADER_SIZE) / P_ENTRY_SIZE));
}

/** Decode a name field. Returns raw bytes up to the first NUL. */
function decodeNameBytes(table, base, i) {
  const out = new Uint8Array(NAME_LEN);
  let n = 0;
  for (let j = 0; j < NAME_LEN; j++) {
    const b = table[base + j] ^ ((i * j * 3 + 0x3d) & 0xff);
    if (b === 0) break;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

let sjis = null;
function decodeName(bytes) {
  // Names are Shift-JIS (CP932) in principle; TextDecoder('shift_jis') exists in
  // all three browsers and in Node with full ICU. ASCII names decode the same.
  if (sjis === null) {
    try { sjis = new TextDecoder('shift_jis'); } catch { sjis = new TextDecoder('latin1'); }
  }
  return sjis.decode(bytes);
}

/**
 * Decode the table. `bytes` must hold at least the header and the whole table
 * (pTableBytes(count)). Returns { flags, count, entries:[{index,name,offset,size}] }.
 * With { names: false } names are skipped (faster for the self-check).
 */
export function decodePTable(bytes, { names = true } = {}) {
  if (bytes.byteLength < P_HEADER_SIZE) throw new PFormatError('shorter than the 8-byte header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = dv.getUint32(0, true);
  const count = pEntryCount(bytes);
  const need = pTableBytes(count);
  if (bytes.byteLength < need) {
    throw new PFormatError(`table needs ${need} bytes for ${count} entries, have ${bytes.byteLength}`);
  }
  const entries = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = P_HEADER_SIZE + i * P_ENTRY_SIZE;
    const offset = dv.getUint32(base + 0x3c, true);
    const size = (dv.getUint32(base + 0x40, true) ^ P_KEY) >>> 0;
    entries[i] = {
      index: i,
      name: names ? decodeName(decodeNameBytes(bytes, base, i)) : undefined,
      offset,
      size,
    };
  }
  return { flags, count, entries };
}

export class PFormatError extends Error {
  constructor(msg) { super(msg); this.name = 'PFormatError'; }
}

/**
 * Self-check a decoded table against the file size (plan §1.2, §5 Phase 1).
 * Required (errors): every entry lies inside the file and after the table, and
 * the last entry ends exactly at end of file. Also reported, as facts:
 * whether entries are in offset order and packed with no gaps or overlaps.
 * Returns { ok, errors:[string], count, flags, sumSizes, tableEnd, ordered, contiguous }.
 */
export function checkPTable(table, fileSize) {
  const errors = [];
  const { count, entries, flags } = table;
  const tableEnd = pTableBytes(count);
  if (count === 0) errors.push('archive table is empty');
  if (tableEnd > fileSize) errors.push(`table end ${tableEnd} is past end of file ${fileSize}`);
  let sumSizes = 0;
  let ordered = true;
  let contiguous = true;
  let expectNext = tableEnd;
  let firstBad = null;
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    sumSizes += e.size;
    const end = e.offset + e.size;
    if (firstBad === null && (e.offset < tableEnd || end > fileSize)) {
      firstBad = `entry ${i} spans ${e.offset}..${end}, outside the data area ${tableEnd}..${fileSize}`;
    }
    if (i > 0 && e.offset < entries[i - 1].offset) ordered = false;
    if (e.offset !== expectNext) contiguous = false;
    expectNext = end;
  }
  if (firstBad) errors.push(firstBad);
  if (!firstBad && count > 0 && !contiguous) {
    errors.push(ordered ? 'entries leave gaps or overlap (expected packed back to back after the table)'
                        : 'entries are not in offset order');
  }
  if (count > 0) {
    const last = entries[count - 1];
    const lastEnd = last.offset + last.size;
    if (lastEnd !== fileSize) {
      errors.push(`last entry ends at ${lastEnd}, file size is ${fileSize} (expected equal)`);
    }
  }
  return { ok: errors.length === 0, errors, count, flags, sumSizes, tableEnd, ordered, contiguous };
}

/**
 * Convenience for callers with random access: `readAt(offset, length)` returns
 * (or resolves to) a Uint8Array. Works with sync and async readers.
 * Returns the checkPTable result plus `table` (names decoded only on request).
 */
export async function checkPArchive(readAt, fileSize, opts = {}) {
  if (fileSize < P_HEADER_SIZE) {
    return { ok: false, errors: [`file is ${fileSize} bytes, shorter than the 8-byte header`], count: 0 };
  }
  const header = await readAt(0, P_HEADER_SIZE);
  const count = pEntryCount(header);
  const max = pMaxCount(fileSize);
  if (count > max) {
    return {
      ok: false,
      errors: [`header says ${count} entries but a ${fileSize}-byte file holds at most ${max} (corrupt header or not a .p archive)`],
      count,
    };
  }
  const bytes = await readAt(0, pTableBytes(count));
  const table = decodePTable(bytes, { names: !!opts.names });
  const res = checkPTable(table, fileSize);
  if (opts.names) res.table = table;
  return res;
}

/**
 * The decoded table (names included) of an archive whose header and table pass the
 * self-check against `fileSize`, or null. `readAt(offset, length)` may return a
 * promise. Used to plan trimmed storage (lib/ptrim.js), which needs every table.
 */
export async function readCheckedTable(readAt, fileSize) {
  if (fileSize < P_HEADER_SIZE) return null;
  const count = pEntryCount(await readAt(0, P_HEADER_SIZE));
  if (count > pMaxCount(fileSize)) return null;
  const table = decodePTable(await readAt(0, pTableBytes(count)));
  return checkPTable(table, fileSize).ok ? table : null;
}
