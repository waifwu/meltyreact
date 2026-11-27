// Trimmed storage of the `.p` archives: which bytes the game can ever read, and the
// offset map between an archive as the game sees it and the shorter copy that is
// stored. Pure functions, no I/O. BROWSER_PORT_PLAN.md §1.2 has the evidence;
// port-work/tools/archive_reads.py is the same model in Python.
//
// How the game finds an entry (mbr.exe, English v2.0):
//  - FUN_0043db20 registers the archives in two tables. The general table has 15
//    slots and is searched from slot 0 up by FUN_00407800 (through FUN_0042db20),
//    FUN_00438ca0 and FUN_00438cd0; the first archive holding the name wins, and a
//    hit whose size (or bytes read) is 0 counts as not found. The music table has 5
//    slots and only FUN_00453c20 searches it, for ".\bgm\%02d.mp3"; there a hit
//    whose offset is 0 counts as not found.
//  - FUN_0042da10 / FUN_0042db20 compare the last path component of the request
//    with the entry name, ignoring ASCII case (CharUpperA, then _strcmpi).
//  - A music track is read through MapViewOfFile from the 64 KB-aligned offset
//    below the entry up to the entry's end (FUN_0041a1a0), so that lead-in is read too.
//  - data03.p is never opened; FUN_00445e20 only checks that it exists.
// The manifest's `lookup` field carries each archive's table and slot.
//
// So the stored copy of an archive keeps: the header and table, every entry that
// no archive searched earlier hides, and, for the music table, each kept entry's
// lead-in. Every byte the game can read is then stored, and the copy keeps the
// original's size and offsets as far as the game can tell (lib/vfs.js maps reads).
//
// An archive that is not available counts as empty. That can only keep more,
// never less, so trimming one archive before another is imported is safe; it is
// just not as small as it could be.

import { pTableBytes } from './pfile.js';

/** Allocation granularity the game rounds MapViewOfFile offsets down to (GetSystemInfo). */
export const VIEW_ALIGN = 0x10000;

const MUSIC_NAME = /^\d{2,}\.MP3$/;

/**
 * The name as the game compares it (ASCII upper case), or null when the name can
 * never match a request (it contains a backslash: requests are cut at the last
 * one) or when it is not plain ASCII (then it is kept and never hides anything,
 * which can only keep more).
 */
function compareKey(name) {
  if (typeof name !== 'string') return undefined;
  if (name.includes('\\')) return null;
  if (!/^[\x01-\x7f]*$/.test(name)) return undefined;
  return name.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Which entries the game can ever read.
 * archives: [{ key, lookup, table }] where `table` is a decoded table (lib/pfile.js
 * decodePTable with names) or null when the archive is not available.
 * Returns Map(key -> Set(entry index)) for every archive that has a table and a
 * lookup role.
 */
export function readableEntries(archives) {
  const out = new Map();
  for (const kind of ['main', 'bgm']) {
    const order = archives.filter((a) => a.lookup && a.lookup.table === kind)
      .sort((a, b) => a.lookup.slot - b.lookup.slot);
    const hidden = new Set();
    for (const a of order) {
      if (!a.table) continue;
      const set = new Set();
      a.table.entries.forEach((e, i) => {
        const k = compareKey(e.name);
        if (k === null) return; // can never be requested
        if (k === undefined) { set.add(i); return; } // unusual name: keep it
        if (kind === 'bgm' && !MUSIC_NAME.test(k)) return; // the music table is only asked for NN.mp3
        if (!hidden.has(k)) set.add(i);
      });
      a.table.entries.forEach((e) => {
        const k = compareKey(e.name);
        if (!k) return;
        // A zero-size hit does not stop the general search; in the music table only a zero offset does not.
        if (kind === 'main' ? e.size > 0 : e.offset !== 0) hidden.add(k);
      });
      out.set(a.key, set);
    }
  }
  for (const a of archives) if (a.table && a.lookup && a.lookup.table === 'none') out.set(a.key, new Set());
  return out;
}

/** Merge [start, end) ranges (sorted or not); adjacent ranges join. */
export function mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Byte ranges of one archive to store, merged and in file order: header and table,
 * the readable entries, and for the music table each readable entry's lead-in.
 */
export function keepRanges({ lookup, table, size }, readable) {
  const ranges = [[0, Math.min(size, pTableBytes(table.count))]];
  for (const i of readable) {
    const e = table.entries[i];
    const end = Math.min(size, e.offset + e.size);
    ranges.push([e.offset, end]);
    if (lookup.table === 'bgm') ranges.push([Math.floor(e.offset / VIEW_ALIGN) * VIEW_ALIGN, e.offset]);
  }
  return mergeRanges(ranges.map(([s, e]) => [Math.max(0, s), e]));
}

/**
 * The plan for a set of archives: Map(key -> { size, storedSize, segments, readable,
 * readableBytes }) for every archive with a table and a lookup role. `segments` is
 * [[virtualStart, length], ...] in file order, stored back to back; it is null when
 * every byte is kept (store the file whole).
 * archives: [{ key, lookup, table, size }], tables as for readableEntries.
 */
export function trimPlan(archives) {
  const readable = readableEntries(archives);
  const plan = new Map();
  for (const a of archives) {
    const set = readable.get(a.key);
    if (!set) continue;
    const ranges = keepRanges(a, set);
    const storedSize = ranges.reduce((s, [b, e]) => s + (e - b), 0);
    let readableBytes = 0;
    for (const i of set) readableBytes += a.table.entries[i].size;
    plan.set(a.key, {
      size: a.size,
      storedSize,
      segments: storedSize === a.size ? null : ranges.map(([b, e]) => [b, e - b]),
      readable: set.size,
      entries: a.table.count,
      readableBytes,
      ranges,
    });
  }
  return plan;
}

/**
 * Map between an archive as the game sees it (virtual offsets, the original size)
 * and its stored copy. `segments`: [[virtualStart, length], ...] in file order,
 * stored back to back from offset 0; null or undefined means the copy is whole.
 * Virtual bytes outside every segment were not stored (the game never reads them).
 */
export class OffsetMap {
  constructor(segments, size) {
    this.size = size;
    this.whole = !segments;
    const segs = segments || [[0, size]];
    this.v = new Float64Array(segs.length); // virtual starts
    this.len = new Float64Array(segs.length);
    this.s = new Float64Array(segs.length); // stored starts
    let s = 0;
    let prevEnd = -1;
    segs.forEach(([v, len], i) => {
      if (!(len > 0) || v < prevEnd || v + len > size) throw new RangeError(`bad segment ${i}: [${v}, +${len}] in a ${size}-byte file`);
      this.v[i] = v; this.len[i] = len; this.s[i] = s;
      s += len; prevEnd = v + len;
    });
    this.storedSize = s;
  }

  /** Index of the last segment starting at or before `v`, or -1. */
  _find(v) {
    let lo = 0;
    let hi = this.v.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.v[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Where virtual [v0, v1) lives in the stored copy. Returns { s0, s1, pieces } with
   * pieces [{ v0, v1, s0 }] for the stored parts, in order; the stored bytes of all
   * pieces are the one contiguous stored range [s0, s1). Parts of [v0, v1) not in a
   * piece were not stored. pieces is empty (and s0 === s1) when nothing is stored.
   */
  span(v0, v1) {
    const pieces = [];
    if (v1 > this.size) v1 = this.size;
    if (v0 >= v1) return { s0: 0, s1: 0, pieces };
    let i = this._find(v0);
    if (i < 0) i = 0;
    for (; i < this.v.length && this.v[i] < v1; i++) {
      const a = Math.max(v0, this.v[i]);
      const b = Math.min(v1, this.v[i] + this.len[i]);
      if (b > a) pieces.push({ v0: a, v1: b, s0: this.s[i] + (a - this.v[i]) });
    }
    if (!pieces.length) return { s0: 0, s1: 0, pieces };
    const last = pieces[pieces.length - 1];
    return { s0: pieces[0].s0, s1: last.s0 + (last.v1 - last.v0), pieces };
  }

  /** True when every byte of virtual [v0, v1) is stored. */
  covers(v0, v1) {
    if (v1 > this.size) v1 = this.size;
    if (v0 >= v1) return true;
    const i = this._find(v0);
    return i >= 0 && this.v[i] + this.len[i] >= v1;
  }
}

/**
 * Stored copies that miss bytes the game can read now. plan: trimPlan(...) for the
 * archives as they are stored; stored: Map(key -> segments or null). Returns
 * [{ key, missing: [start, end] }], the first missing range of each archive.
 * Happens when an archive was trimmed while another archive searched before it
 * held more names than the one stored now.
 */
export function coverageProblems(plan, stored) {
  const out = [];
  for (const [key, p] of plan) {
    if (!stored.has(key)) continue;
    const segs = stored.get(key);
    if (!segs) continue;
    const map = new OffsetMap(segs, p.size);
    const bad = p.ranges.find(([s, e]) => !map.covers(s, e));
    if (bad) out.push({ key, missing: bad });
  }
  return out;
}
