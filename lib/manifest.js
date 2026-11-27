// The manifest of files the port needs, and the pure checks against it.
//
// Sizes are from BROWSER_PORT_PLAN.md §1.2. SHA-256 values were computed with
// `shasum -a 256` from the extracted files (Appendix A recipe) on 2026-11-22;
// they are facts about the files, not their contents.
//
// Hash policy (why the two kinds differ):
//  - mbr.exe: `required`. The recompiled code is generated from exactly this
//    file, so any other exe is unusable. A mismatch is an error.
//  - archives and the movie: `advisory`. Their hashes come from a single copy.
//    The game finds data through each archive's own table, so the binding
//    checks are the exact size and the table self-check (plan §5 Phase 1). A
//    hash mismatch with both of those passing is reported as a warning (the
//    file is kept and usable, but differs from the reference copy).
//
// The hash is computed while the file is copied (lib/sha256.js), so it costs
// CPU (about 180 MB/s in V8) but no extra I/O.

export const MANIFEST_VERSION = 1;

/** OPFS directory names. The imported tree is never written by the file-access module. */
export const GAME_DIR = 'game';
export const USER_DIR = 'user';
export const STATE_FILE = 'import-state.json';

/** Folders under game/ (and user/), matching the virtual drive layout in lib/paths.js. */
export const REACT_DIR = 'ReACT';
export const BASE_DIR = 'MeltyBlood';

const f = (dir, name, size, sha256, extra = {}) => ({ dir, name, size, sha256, ...extra });

// `lookup` says how the game finds entries in an archive (BROWSER_PORT_PLAN.md §1.2,
// FUN_0043db20): `table: 'main'` with its slot in the general table, searched from slot
// 0 up; `table: 'bgm'` with its slot in the music table (".\\bgm\\%02d.mp3" only);
// `table: 'none'`, never opened (only checked to exist). lib/ptrim.js uses it to store
// only what the game can read. Entries without `lookup` are stored whole.
export const MANIFEST = Object.freeze([
  f(REACT_DIR, 'mbr.exe', 585728, '2dbfbf2fc32042cce18208c77373e716eebaca7dd487337f773972116691a9aa',
    { kind: 'exe', hashPolicy: 'required', note: 'English v2.0 executable (the disc exe is 548,864 bytes)' }),
  f(REACT_DIR, '00.p', 112813273, 'b4228cf898c92762a578c33eeae064fff6e71a5dfc5e7caf83180be691556a0f', { kind: 'p', entries: 843, flags: 0, lookup: { table: 'main', slot: 3 } }),
  f(REACT_DIR, '01.p', 371600936, '8616b745b53bcbdb5d8f9319f0c71ae2246561779f43ff3954c043abf0e3162f', { kind: 'p', entries: 98, flags: 0, lookup: { table: 'main', slot: 4 } }),
  f(REACT_DIR, '02.p', 287670272, 'aca41bdeb569b53c309d07fa3f3366dbf168215b7f49bb673840194a38b67bb7', { kind: 'p', entries: 44, flags: 0, lookup: { table: 'main', slot: 5 } }),
  f(REACT_DIR, '03.p', 11107326, 'd186f81f78435cfe375c96a5e352d7395bd51182b8e1cb8ae827e54d1a8e238f', { kind: 'p', entries: 91, flags: 0, lookup: { table: 'main', slot: 6 } }),
  f(REACT_DIR, '04.p', 3927204, '9cdf4cc12f37c4f9191396506885823eb7418a93ef72872e7ce46c6123849faa', { kind: 'p', entries: 11, flags: 0, lookup: { table: 'main', slot: 7 } }),
  f(REACT_DIR, '05.p', 711140, '5bea496a368a2186e8254901813c2e7d46e63954424752cdca7992ad5bdfe55c', { kind: 'p', entries: 179, flags: 0, lookup: { table: 'main', slot: 8 } }),
  f(REACT_DIR, '06.p', 217595162, '37bdaebb296946d1980714179af257151c6c320b863a15910ba8780c8b300231', { kind: 'p', entries: 2881, flags: 0, lookup: { table: 'main', slot: 9 } }),
  f(REACT_DIR, '10.p', 78988531, 'a2fc79af3bf31d4527da47d398d38227d2c79d331ade3f0a5b9206a6c31e39e4', { kind: 'p', entries: 36, flags: 1, lookup: { table: 'bgm', slot: 2 } }),
  f(REACT_DIR, '00ft.p', 99030468, '4eb299049f6b7af2cc6f86698fed8048d5a3749e892587709d5a5db3f47224f7', { kind: 'p', entries: 475, flags: 0, lookup: { table: 'main', slot: 1 } }),
  f(REACT_DIR, '07.p', 264607397, 'be7fade751e5522cd527d9ee52a8bea221f6e1273137ca476a56ed837f30ae57', { kind: 'p', entries: 98, flags: 0, lookup: { table: 'main', slot: 2 } }),
  f(BASE_DIR, 'data00.p', 142109890, 'c430ec2ca92f91abf25f5d8670953a55a6017e4d897cabe8f1f87d8e90768f39', { kind: 'p', entries: 34, flags: 1, lookup: { table: 'bgm', slot: 4 } }),
  f(BASE_DIR, 'data01.p', 221368791, 'ff13844ef10cc9e1567c2b418af927b755e721db6522e53866b74de52382973b', { kind: 'p', entries: 1432, flags: 0, lookup: { table: 'main', slot: 12 } }),
  f(BASE_DIR, 'data02.p', 59938295, 'ff4a9765b4cd2e0eac9a7262c1836e129404efe2e2b3862d37751e27981e4cf8', { kind: 'p', entries: 238, flags: 0, lookup: { table: 'main', slot: 11 } }),
  f(BASE_DIR, 'data03.p', 138797062, '7117f6a5288300aac184460195e3d724c01bfa5d079fe1b063f03ae86bc49b9d', { kind: 'p', entries: 76, flags: 0, lookup: { table: 'none' } }),
  f(BASE_DIR, 'MBOP.mpg', 42405892, '19f38c3fcb8e1dc44e45c3636872b8323dc95e68bd34241568e881604d15f89a', { kind: 'movie' }),
].map((e) => Object.freeze({ hashPolicy: 'advisory', ...e })));

export const MANIFEST_TOTAL_BYTES = MANIFEST.reduce((s, e) => s + e.size, 0); // 2,052,671,639

/** "ReACT/mbr.exe" */
export const entryKey = (e) => `${e.dir}/${e.name}`;

const lc = (s) => s.toLowerCase();

/**
 * Match picked files to manifest entries by file name, case-insensitively
 * (folder structure is ignored: every required name is unique).
 *
 * candidates: [{ name, size, path, ref }]  (ref is opaque: a File or handle)
 * Returns {
 *   matches: [{ entry, candidate|null, rejected:[{candidate, reason}] }]  one per manifest entry
 *   ignored: number of picked files that are not in the manifest
 * }
 * When several files share a name, the one with the manifest size wins; the
 * others are listed in `rejected` with the reason. When none has the right
 * size, the match is null and every candidate is rejected ("expected X bytes,
 * found Y").
 */
export function matchCandidates(manifest, candidates) {
  const byName = new Map();
  for (const e of manifest) byName.set(lc(e.name), { entry: e, list: [] });
  let ignored = 0;
  for (const c of candidates) {
    const slot = byName.get(lc(c.name));
    if (slot) slot.list.push(c); else ignored++;
  }
  const matches = [];
  for (const { entry, list } of byName.values()) {
    let chosen = null;
    const rejected = [];
    for (const c of list) {
      if (!chosen && c.size === entry.size) { chosen = c; continue; }
      rejected.push({
        candidate: c,
        reason: c.size === entry.size
          ? `duplicate of ${chosen.path} (same size); the first one found is used`
          : `wrong size: expected ${fmtBytes(entry.size)}, found ${fmtBytes(c.size)}` +
            (entry.kind === 'exe' && c.size === 548864 ? ' (this is the disc exe; the English v2.0 patch replaces it)' : ''),
      });
    }
    matches.push({ entry, candidate: chosen, rejected });
  }
  return { matches, ignored };
}

/**
 * Judge one imported file. `found`: { size, sha256?, pcheck? } where pcheck is
 * the lib/pfile.js checkPTable/checkPArchive result.
 * Returns { status: 'ok'|'warning'|'error', problems:[{ check, expected, found, severity }] }.
 */
export function verifyEntry(entry, found) {
  const problems = [];
  const add = (check, expected, got, severity = 'error') => problems.push({ check, expected, found: got, severity });
  if (found.size !== entry.size) add('size', fmtBytes(entry.size), fmtBytes(found.size));
  if (found.sha256 !== undefined && found.sha256 !== null && found.sha256 !== entry.sha256) {
    add('sha256', entry.sha256, found.sha256, entry.hashPolicy === 'required' ? 'error' : 'warning');
  }
  if (entry.kind === 'p') {
    const pc = found.pcheck;
    if (!pc) add('archive table', 'self-check run', 'not checked');
    else {
      for (const msg of pc.errors) add('archive table', 'valid table ending at end of file', msg);
      if (pc.ok && entry.entries !== undefined && pc.count !== entry.entries) {
        add('archive entries', String(entry.entries), String(pc.count), 'warning');
      }
    }
  }
  const status = problems.some((p) => p.severity === 'error') ? 'error' : problems.length ? 'warning' : 'ok';
  return { status, problems };
}

/**
 * Compare what is stored in OPFS with the manifest.
 * stored: [{ dir, name, size }] for every file under game/ (dir is the folder name).
 * Returns { missing:[entry], extra:[{dir,name,size}], present:[{entry, stored}] }.
 * Names compare case-insensitively.
 */
export function diffStored(manifest, stored) {
  const want = new Map(manifest.map((e) => [lc(entryKey(e)), e]));
  const present = [];
  const extra = [];
  const seen = new Set();
  for (const s of stored) {
    const k = lc(`${s.dir}/${s.name}`);
    const e = want.get(k);
    if (e && !seen.has(k)) { present.push({ entry: e, stored: s }); seen.add(k); } else extra.push(s);
  }
  const missing = manifest.filter((e) => !seen.has(lc(entryKey(e))));
  return { missing, extra, present };
}

export function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  const s = n.toLocaleString('en-US');
  if (n < 1024 * 1024) return `${s} B`;
  return `${s} B (${(n / 1048576).toFixed(1)} MiB)`;
}
