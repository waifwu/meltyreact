// File-access module for the wasm host (BROWSER_PORT_PLAN.md §4.3 "Files").
//
// One object, `GameFs`, gives the HLE a virtual C:\ drive:
//   - imported files (OPFS game/), read-only, through a block cache;
//   - a writable user area (OPFS user/) for configs, replays and saves, held
//     in memory and written behind to OPFS; it never touches game/.
// Paths are Windows paths, matched case-insensitively (lib/paths.js).
//
// Threading: the host model is not decided yet (plan §4.4), so the module
// works in both:
//   mode 'async' (main thread, JSPI/Asyncify): imported files are read through
//     File snapshots; `await fs.read(...)`. Cache hits are also available
//     synchronously through `readSync`, which throws NeedsAsync on a miss.
//   mode 'sync' (dedicated Worker): imported files are opened once with
//     FileSystemSyncAccessHandle; every read is synchronous (`readSync`).
// Everything except reads of imported files is synchronous in both modes,
// because the user area lives in memory. Mounting and flushing are async.
// See web/README.md "File-access module" for the full interface.
//
// Trimmed archives (lib/ptrim.js): an archive stored without the entries the game
// can never read keeps its original size and offsets here. Reads are mapped onto
// the shorter stored copy; bytes that were not stored read as 0, and every read the
// caller asks for that touches them is counted in info.gapReads (it should stay 0).
// At mount, trimmed copies are checked to hold everything the game can read with
// the archives stored now.

import { BlockCache, blockSpan, blockBounds, DEFAULT_BLOCK_SIZE, DEFAULT_CACHE_BYTES } from './blockcache.js';
import { resolveWinPath, matchWildcard, splitPattern, foldCase, DEFAULT_MOUNTS, DEFAULT_CWD } from './paths.js';
import { GAME_DIR, USER_DIR, entryKey, MANIFEST } from './manifest.js';
import { OffsetMap, trimPlan, coverageProblems } from './ptrim.js';
import { readCheckedTable } from './pfile.js';
import { DEFAULT_ROOT, getRoot, getDir, readState, listTree, writeWholeFile, removeIfExists, openSyncRead } from './opfs.js';
import { writeZip, readZip, ZipError } from './zip.js';

/** Win32 error numbers for each code, for the HLE's SetLastError. */
export const WIN32_ERRORS = Object.freeze({
  ENOENT: 2, // ERROR_FILE_NOT_FOUND
  ENOTDIR: 3, // ERROR_PATH_NOT_FOUND (a parent is missing or not a folder)
  EACCES: 5, // ERROR_ACCESS_DENIED (imported files are read-only)
  EBADF: 6, // ERROR_INVALID_HANDLE
  EISDIR: 5,
  EINVAL: 87, // ERROR_INVALID_PARAMETER
  EEXIST: 80, // ERROR_FILE_EXISTS
  EBUSY: 32, // ERROR_SHARING_VIOLATION
  EIO: 1117, // ERROR_IO_DEVICE
});

export class VfsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VfsError';
    this.code = code;
    this.win32 = WIN32_ERRORS[code] ?? 31; // ERROR_GEN_FAILURE
  }
}

/** Thrown by readSync in async mode when a needed block is not cached yet. */
export class NeedsAsync extends Error {
  constructor() { super('read needs I/O; call the async read() or prefetch()'); this.name = 'NeedsAsync'; }
}

const USER_LIMIT_WARN = 64 << 20;

/**
 * Mount the virtual drive.
 * options:
 *   mode: 'async' | 'sync'          (default 'async'; 'sync' needs a dedicated Worker)
 *   root: OPFS directory name       (default 'mbr'), or rootHandle: a FileSystemDirectoryHandle
 *   mounts, cwd                     (lib/paths.js DEFAULT_MOUNTS / DEFAULT_CWD)
 *   blockSize, cacheBytes           (default 1 MiB / 64 MiB in async mode, no cache in sync mode;
 *                                    cacheBytes 0 disables the cache)
 *   readAhead                       (bytes, default 0: off; async mode with a cache only) when a
 *                                    read follows on from the last one of the same file and misses
 *                                    up to its end, the same fetch also takes up to this many
 *                                    bytes after it (blocks not cached yet), so a game that reads an
 *                                    archive piece by piece pays one round trip instead of several
 *   manifest                        (entries that must be present; default the real manifest)
 *   requireComplete                 (default true: throw if a manifest file is not imported)
 *   autoFlushMs                     (default 250; write-behind delay for the user area, null = manual)
 *   onWarning                       ((kind, text) => void) told when the user area cannot be kept:
 *                                    'unavailable' at mount (no OPFS: it lives in memory only, see
 *                                    `persistent`), 'flush-failed' for every flush that fails, and
 *                                    'flush-ok' for the first one that works again
 */
export async function mountGameFs(options = {}) {
  const fs = new GameFs(options);
  await fs._mount(options);
  return fs;
}

export class GameFs {
  constructor({ mode = 'async', mounts = DEFAULT_MOUNTS, cwd = DEFAULT_CWD, blockSize = DEFAULT_BLOCK_SIZE,
    cacheBytes, readAhead = 0, freshAhead = 4 << 20, autoFlushMs = 250, onWarning = null } = {}) {
    if (mode !== 'async' && mode !== 'sync') throw new TypeError(`mode must be 'async' or 'sync'`);
    // Measured (PROGRESS.md): a sync access handle read costs 1.5-13 us, about
    // the same as a cache hit, so sync mode defaults to no cache. In async mode
    // every miss is a 100-200 us promise round trip, so the cache matters.
    if (cacheBytes === undefined) cacheBytes = mode === 'sync' ? 0 : DEFAULT_CACHE_BYTES;
    this.mode = mode;
    this.mounts = mounts;
    this.cwd = cwd;
    this.cacheBytes = cacheBytes;
    this.readAhead = readAhead;
    this.freshAhead = freshAhead; // read-ahead after a fresh seek to a substantial asset (_readAhead)
    this._setBlockSize(blockSize);
    this.autoFlushMs = autoFlushMs;
    this.game = new Map(); // folded key -> { id, key, name, size, file?, ah? }
    this.gameDirs = new Map(); // folded dir key -> Map(foldedName -> { name, isDir })
    this.user = new Map(); // folded key -> node { name, isDir, data, length, mtime }
    this.dirty = new Map(); // folded key -> change number; written behind by flush()
    this._changeSeq = 0;
    this.deleted = new Map(); // folded key -> original-case path parts, to remove from OPFS
    this.fds = new Map();
    this.nextFd = 3;
    this.info = { handleMode: null, sharedReaders: null, userWriteMethod: null, warnings: [], trimmed: 0, storedBytes: 0, gapReads: 0, gapReadList: [] };
    this._flushChain = Promise.resolve();
    this._flushTimer = null;
    this._flushFailing = false;
    this.onWarning = onWarning;
    this.closed = false;
  }

  /** Whether the user area is written to OPFS. False: it lives in memory and ends with the page. */
  get persistent() { return !!this.root; }

  /** Keep a warning for the host (info.warnings, the last ten) and tell it now (onWarning). */
  _warn(kind, text) {
    this.info.warnings = [...this.info.warnings.slice(-9), text];
    this._tell(kind, text);
  }

  _tell(kind, text) {
    if (typeof this.onWarning !== 'function') return;
    try { this.onWarning(kind, text); } catch (e) { console.warn('vfs: onWarning threw', e); }
  }

  /**
   * The cache's block size (before anything is read). A bundle split into pieces says which
   * it was split for (_mount): a block is then exactly one piece, one request and no more.
   */
  _setBlockSize(blockSize) {
    this.cache = this.cacheBytes > 0 ? new BlockCache({ blockSize, maxBytes: this.cacheBytes }) : null;
    this.blockSize = blockSize;
    // at most a quarter of the cache, so a read's own blocks (at most half, shouldBypass) and its
    // read-ahead always fit together
    this.readAheadBlocks = this.cache && this.mode === 'async'
      ? Math.max(0, Math.min(Math.floor(this.readAhead / blockSize), Math.floor(this.cache.maxBlocks / 4))) : 0;
  }

  // ------------------------------------------------------------ mounting

  async _mount({ root = DEFAULT_ROOT, rootHandle, manifest = MANIFEST, requireComplete = true, bundleUrl } = {}) {
    const manifestUrl = bundleUrl || new URL('../data/bundle-manifest.json', import.meta.url).href;
    const resp = await fetch(manifestUrl, { cache: 'no-store' });
    if (!resp.ok) throw new VfsError('ENOENT', `cannot load bundle manifest (${resp.status}): ${manifestUrl}`);
    const bundle = await resp.json();
    // The pieces of a split bundle are whole requests, so the cache's blocks follow them: the
    // block size the bundle was split for (blockSize: each piece is one block of the original
    // file, tools/make-site.mjs), or the size of its pieces where they are cut by stored
    // offset (an earlier split: a block of a trimmed archive then lies across two of them).
    const split = (bundle.files || []).filter((f) => f.chunks && f.chunkSize > 0);
    const pieceSize = bundle.blockSize || (split.length ? Math.max(...split.map((f) => f.chunkSize)) : 0);
    if (pieceSize && pieceSize !== this.blockSize && (pieceSize & (pieceSize - 1)) === 0) this._setBlockSize(pieceSize);
    let id = 0;
    for (const mt of this.mounts) this._gameDir(foldCase(mt.dir));
    for (const f of bundle.files || []) {
      const relKey = `${f.dir}/${f.name}`;
      let map = null;
      if (f.segments) {
        map = new OffsetMap(f.segments, f.size);
        if (map.storedSize !== f.storedSize) throw new VfsError('EINVAL', `bundle segment size mismatch for ${relKey}`);
        this.info.trimmed++;
      }
      this.info.storedBytes += f.storedSize;
      const key = foldCase(relKey);
      const wholeFetch = !!(f.chunks && f.chunkSize <= (1 << 20)) || f.storedSize <= (1 << 20);
      const file = f.chunks
        ? new ChunkedHttpFile(
            f.chunks.map((c) => new HttpFile(new URL(c.path, manifestUrl).href, c.size, { wholeFetch })),
            f.storedSize,
          )
        : new HttpFile(new URL(f.path, manifestUrl).href, f.storedSize, { wholeFetch });
      const rec = { id: id++, key, name: f.name, size: f.size, map, segments: f.segments || null, file };
      this.game.set(key, rec);
      this._gameDir(foldCase(f.dir)).set(foldCase(f.name), { name: f.name, isDir: false });
    }
    if (requireComplete) {
      const missing = manifest.filter((e) => !this.game.has(foldCase(entryKey(e))));
      if (missing.length) {
        throw new VfsError('ENOENT', `missing from bundle: ${missing.map(entryKey).join(', ')}`);
      }
    }
    this.info.handleMode = 'http-range';
    try {
      this.root = rootHandle || (await getRoot(root));
      await this._loadUser();
    } catch (e) {
      this.root = null;
      this._warn('unavailable', `OPFS unavailable; saves will stay in memory for this session (${e && e.message || e})`);
    }
    // The game cannot create folders (no CreateDirectory import) and needs replay\ (plan §2.6).
    for (const mt of this.mounts) if (foldCase(mt.dir) === 'react') this._mkdirUser([mt.dir, 'replay']);
    this._scheduleFlush();
  }

  async _checkTrimmed(manifest) {
    const roles = manifest.filter((e) => e.kind === 'p' && e.lookup);
    const gs = roles.map((e) => this.game.get(foldCase(entryKey(e))));
    if (!roles.length || gs.some((g) => !g) || !gs.some((g) => g.map)) return;
    const archives = [];
    for (let i = 0; i < roles.length; i++) {
      const file = await gs[i].handle.getFile();
      const table = await readCheckedTable(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), gs[i].size);
      archives.push({ key: entryKey(roles[i]), lookup: roles[i].lookup, table, size: gs[i].size });
    }
    const stored = new Map(roles.map((e, i) => [entryKey(e), gs[i].segments]));
    const bad = coverageProblems(trimPlan(archives), stored);
    if (bad.length) {
      throw new VfsError('ENOENT', `stored copies lack entries the game can read: ${bad.map((b) => b.key).join(', ')} (import them again on the import page)`);
    }
  }

  _gameDir(dkey) {
    let m = this.gameDirs.get(dkey);
    if (!m) { m = new Map(); this.gameDirs.set(dkey, m); }
    return m;
  }

  async _openSyncHandles() {
    // Prefer shared read-only handles so several readers (a second tab, the
    // import page's verify) can coexist; browsers without the `mode` option
    // ignore it and give an exclusive lock.
    const open = openSyncRead;
    const opened = [];
    try {
      for (const g of this.game.values()) { g.ah = await open(g.handle); opened.push(g); }
    } catch (e) {
      for (const g of opened) try { g.ah.close(); } catch {}
      throw new VfsError('EBUSY', `cannot open imported files for reading (${e.name}: ${e.message}); another tab or the import page may hold them`);
    }
    // Probe whether a second reader can open the same file.
    const first = this.game.values().next().value;
    if (first) {
      try { const again = await open(first.handle); again.close(); this.info.sharedReaders = true; }
      catch { this.info.sharedReaders = false; }
    }
    this.info.handleMode = this.info.sharedReaders ? 'read-only (shared)' : 'exclusive';
  }

  async _loadUser() {
    const userRoot = await getDir(this.root, [USER_DIR], { create: true });
    const files = await listTreeWithDirs(userRoot);
    let total = 0;
    for (const f of files) {
      if (f.isDir) { this._mkdirUser(f.parts); continue; }
      this._mkdirUser(f.parts.slice(0, -1));
      const data = new Uint8Array(await (await f.handle.getFile()).arrayBuffer());
      total += data.length;
      this.user.set(foldCase(f.parts.join('/')), { name: f.parts[f.parts.length - 1], isDir: false, data, length: data.length, mtime: Date.now() });
    }
    if (total > USER_LIMIT_WARN) this.info.warnings.push(`user area holds ${total} bytes in memory`);
  }

  // ------------------------------------------------------------ lookup

  _resolve(path, opts) {
    let r;
    try { r = resolveWinPath(path, { mounts: this.mounts, cwd: this.cwd, ...opts }); }
    catch (e) { throw new VfsError('EINVAL', e.message); }
    if (!r) throw new VfsError('ENOTDIR', `path is outside the virtual drive: ${path}`);
    return r;
  }

  /** Where a path lands: { area: 'user'|'game'|null, key, isDir } (diagnostics and tests). */
  resolve(path) {
    const r = this._resolve(path);
    const u = this.user.get(r.key);
    if (u) return { area: 'user', key: r.key, isDir: u.isDir };
    if (this.game.has(r.key)) return { area: 'game', key: r.key, isDir: false };
    if (this.gameDirs.has(r.key)) return { area: 'game', key: r.key, isDir: true };
    return { area: null, key: r.key, isDir: false };
  }

  _isDirKey(key) {
    const u = this.user.get(key);
    if (u) return u.isDir;
    return this.gameDirs.has(key);
  }

  _parentKey(key) {
    const i = key.lastIndexOf('/');
    return i < 0 ? null : key.slice(0, i);
  }

  /** { name, size, isDir, area } or null. */
  stat(path) {
    const r = this._resolve(path);
    const u = this.user.get(r.key);
    if (u) return { name: u.name, size: u.isDir ? 0 : u.length, isDir: u.isDir, area: 'user' };
    const g = this.game.get(r.key);
    if (g) return { name: g.name, size: g.size, isDir: false, area: 'game' };
    if (this.gameDirs.has(r.key)) return { name: r.rel.length ? r.rel[r.rel.length - 1] : r.mount.dir, size: 0, isDir: true, area: 'game' };
    return null;
  }

  exists(path) { return this.stat(path) !== null; }

  /** File size in bytes; throws ENOENT. */
  size(path) {
    const s = this.stat(path);
    if (!s) throw new VfsError('ENOENT', `no such file: ${path}`);
    if (s.isDir) throw new VfsError('EISDIR', `is a folder: ${path}`);
    return s.size;
  }

  /**
   * Directory listing, FindFirstFile style. `pathOrPattern` is either a folder
   * ("C:\ReACT\replay") or a folder plus wildcard ("C:\ReACT\replay\*.RPD").
   * Returns [{ name, size, isDir, area }] sorted case-insensitively, user area
   * first when both areas have a name. "." and ".." are not included.
   */
  list(pathOrPattern, pattern) {
    let dirPath = pathOrPattern;
    if (pattern === undefined) {
      if (/[*?]/.test(pathOrPattern)) ({ dir: dirPath, pattern } = splitPattern(pathOrPattern));
      else pattern = '*';
    }
    const r = this._resolve(dirPath);
    if (!this._isDirKey(r.key)) {
      if (this.stat(dirPath)) throw new VfsError('ENOTDIR', `not a folder: ${dirPath}`);
      throw new VfsError('ENOTDIR', `no such folder: ${dirPath}`);
    }
    const out = new Map();
    const prefix = r.key + '/';
    for (const [k, n] of this.user) {
      if (!k.startsWith(prefix) || k.indexOf('/', prefix.length) >= 0) continue;
      if (matchWildcard(pattern, n.name)) out.set(foldCase(n.name), { name: n.name, size: n.isDir ? 0 : n.length, isDir: n.isDir, area: 'user' });
    }
    const gd = this.gameDirs.get(r.key);
    if (gd) {
      for (const [fk, e] of gd) {
        if (out.has(fk) || !matchWildcard(pattern, e.name)) continue;
        const g = e.isDir ? null : this.game.get(`${r.key}/${fk}`);
        out.set(fk, { name: e.name, size: g ? g.size : 0, isDir: e.isDir, area: 'game' });
      }
    }
    return [...out.values()].sort((a, b) => (foldCase(a.name) < foldCase(b.name) ? -1 : foldCase(a.name) > foldCase(b.name) ? 1 : 0));
  }

  // ------------------------------------------------------------ open / close

  /**
   * Open a file. Flags (CreateFileA dispositions in brackets):
   *   write: request write access
   *   create: create when missing            [OPEN_ALWAYS, CREATE_ALWAYS]
   *   exclusive: fail with EEXIST if present  [CREATE_NEW]
   *   truncate: empty an existing file        [CREATE_ALWAYS, TRUNCATE_EXISTING]
   * Imported files can be opened with write access (some games ask for it
   * out of habit) but every write, truncate or delete on them fails with
   * EACCES; they are never modified. Returns a numeric fd.
   */
  open(path, { write = false, create = false, exclusive = false, truncate = false } = {}) {
    const r = this._resolve(path);
    let node = this.user.get(r.key);
    const game = node ? null : this.game.get(r.key);
    if ((node && node.isDir) || (!node && !game && this.gameDirs.has(r.key))) throw new VfsError('EISDIR', `is a folder: ${path}`);
    if ((node || game) && exclusive) throw new VfsError('EEXIST', `already exists: ${path}`);
    if (game) {
      if (truncate) throw new VfsError('EACCES', `imported files are read-only: ${path}`);
      const fd = this.nextFd++;
      this.fds.set(fd, { kind: 'game', g: game, write: false });
      return fd;
    }
    if (!node) {
      if (!create) throw new VfsError('ENOENT', `no such file: ${path}`);
      const pkey = this._parentKey(r.key);
      if (pkey === null || !this._isDirKey(pkey)) throw new VfsError('ENOTDIR', `folder does not exist for ${path}`);
      this._mirrorDir(pkey, r);
      node = { name: r.rel[r.rel.length - 1], isDir: false, data: new Uint8Array(0), length: 0, mtime: Date.now() };
      this.user.set(r.key, node);
      this.deleted.delete(r.key);
      this._markDirty(r.key);
    } else if (truncate) {
      node.length = 0;
      node.mtime = Date.now();
      this._markDirty(r.key);
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { kind: 'user', node, key: r.key, write });
    return fd;
  }

  close(fd) {
    if (!this.fds.delete(fd)) throw new VfsError('EBADF', `bad fd ${fd}`);
  }

  _fd(fd) {
    const f = this.fds.get(fd);
    if (!f) throw new VfsError('EBADF', `bad fd ${fd}`);
    return f;
  }

  fstat(fd) {
    const f = this._fd(fd);
    return f.kind === 'game' ? { name: f.g.name, size: f.g.size, area: 'game' } : { name: f.node.name, size: f.node.length, area: 'user' };
  }

  // ------------------------------------------------------------ reads

  /**
   * Read up to dst.length bytes at `position` into dst. Returns the count
   * (short at end of file, 0 at or past it). Sync in 'sync' mode; in 'async'
   * mode it works only when the blocks are cached, else throws NeedsAsync.
   */
  readSync(fd, dst, position) {
    const f = this._fd(fd);
    if (f.kind === 'user') return readUser(f.node, dst, position);
    const n = this._readGameSync(f.g, dst, position);
    this._noteGap(f.g, position, n);
    return n;
  }

  /**
   * Async read; works in both modes. Same contract as readSync. { readAhead: false }: fetch
   * only what this read needs, for a caller that is waiting for exactly these bytes and
   * reads nothing after them (the head of a music track, hle_kernel32.c MapViewOfFile): the
   * read-ahead blocks would come in the same response and the caller would wait for all of it.
   */
  async read(fd, dst, position, opts) {
    const f = this._fd(fd);
    if (f.kind === 'user') return readUser(f.node, dst, position);
    const n = this.mode === 'sync' ? this._readGameSync(f.g, dst, position) : await this._readGameAsync(f.g, dst, position, opts);
    this._noteGap(f.g, position, n);
    return n;
  }

  /** Count a read the caller asked for that touches bytes a trimmed copy does not hold. */
  _noteGap(g, position, n) {
    if (!g.map || n <= 0 || g.map.covers(position, position + n)) return;
    this.info.gapReads++;
    if (!g.gapWarned) {
      g.gapWarned = true;
      console.error(`vfs: the game read bytes ${position}-${position + n} of ${g.key}, which the trimmed import did not store (they read as 0). Please report this; importing with trimming off avoids it.`);
    }
    if (this.info.gapReadList.length < 20) this.info.gapReadList.push({ file: g.key, offset: position, length: n });
  }

  /** Convenience: read(path, offset, length) -> Uint8Array (shorter at EOF). */
  async readAt(path, offset, length) {
    const fd = this.open(path);
    try {
      const buf = new Uint8Array(Math.max(0, Math.min(length, this.fstat(fd).size - offset)));
      const n = await this.read(fd, buf, offset);
      return buf.subarray(0, n);
    } finally { this.close(fd); }
  }

  /** Sync twin of readAt (sync mode, or cached data in async mode). */
  readAtSync(path, offset, length) {
    const fd = this.open(path);
    try {
      const buf = new Uint8Array(Math.max(0, Math.min(length, this.fstat(fd).size - offset)));
      const n = this.readSync(fd, buf, offset);
      return buf.subarray(0, n);
    } finally { this.close(fd); }
  }

  /** Load the blocks of a range into the cache (async mode), so later readSync calls hit. */
  async prefetch(path, offset, length) {
    const r = this._resolve(path);
    const g = this.game.get(r.key);
    if (!g || !this.cache) return;
    const span = blockSpan(offset, length, g.size, this.blockSize);
    await this._fillAsync(g, this.cache.missing(g.id, span));
  }

  _readGameSync(g, dst, position) {
    const span = blockSpan(position, dst.length, g.size, this.blockSize);
    if (!span) return 0;
    if (!this.cache || this.cache.shouldBypass(span)) {
      if (this.mode !== 'sync') throw new NeedsAsync();
      if (this.cache) this.cache.stats.bypass++;
      return readVirtualSync(g, dst.subarray(0, span.end - span.start), span.start);
    }
    const missing = this.cache.missing(g.id, span);
    if (missing.length) {
      if (this.mode !== 'sync') throw new NeedsAsync();
      this.cache.stats.misses += missing.length;
      for (const i of missing) {
        const { start, end } = blockBounds(i, g.size, this.blockSize);
        const b = new Uint8Array(end - start);
        readVirtualSync(g, b, start);
        this.cache.put(g.id, i, b);
      }
    } else this.cache.stats.hits++;
    return this.cache.copyOut(g.id, span, dst);
  }

  async _readGameAsync(g, dst, position, opts) {
    const span = blockSpan(position, dst.length, g.size, this.blockSize);
    if (!span) return 0;
    if (!this.cache || this.cache.shouldBypass(span)) {
      if (this.cache) this.cache.stats.bypass++;
      const b = await readVirtualAsync(g, span.start, span.end);
      dst.set(b);
      return b.length;
    }
    const missing = this.cache.missing(g.id, span);
    if (missing.length) await this._fillAsync(g, missing, opts && opts.readAhead === false ? [] : this._readAhead(g, span, missing));
    else this.cache.stats.hits++;
    g.nextBlock = span.last + 1;
    return this.cache.copyOut(g.id, span, dst);
  }

  /**
   * Blocks to fetch after a missed read (readAhead):
   *  - Sequential reads (starting at or just before g.nextBlock) take up to readAheadBlocks.
   *  - A fresh seek that reads a substantial asset (>= 64 KiB, e.g. character sprites/voices
   *    at battle load) takes up to freshAhead bytes immediately so it skips an extra round trip.
   * Stops at the first cached block or past the end of the current trimmed archive segment.
   */
  _readAhead(g, span, missing) {
    const n = this.readAheadBlocks;
    if (!n || missing[missing.length - 1] !== span.last) return [];
    const sequential = g.nextBlock !== undefined && span.first >= g.nextBlock - 1 && span.first <= g.nextBlock;
    const largeAsset = (span.end - span.start) >= (64 << 10);
    if (!sequential && !largeAsset) return [];
    const limit = sequential ? n : Math.min(n, Math.max(1, Math.floor(this.freshAhead / this.blockSize)));
    const lastBlock = Math.floor((g.size - 1) / this.blockSize);
    let segEnd = g.size;
    if (g.map && !g.map.whole) {
      const idx = g.map._find(Math.max(0, span.end - 1));
      if (idx >= 0) segEnd = g.map.v[idx] + g.map.len[idx];
    }
    const extra = [];
    for (let i = span.last + 1; i <= lastBlock && extra.length < limit; i++) {
      if (i * this.blockSize >= segEnd) break;
      if (this.cache.map.has(this.cache._key(g.id, i))) break;
      extra.push(i);
    }
    return extra;
  }

  async _fillAsync(g, missing, extra = []) {
    if (!missing.length) return;
    this.cache.stats.misses += missing.length;
    if (extra.length) this.cache.stats.readAhead = (this.cache.stats.readAhead || 0) + extra.length;
    // Fetch runs of adjacent blocks with one slice each (the read-ahead blocks follow the last
    // missing block, so they join its run).
    const all = extra.length ? missing.concat(extra) : missing;
    let i = 0;
    while (i < all.length) {
      let j = i;
      while (j + 1 < all.length && all[j + 1] === all[j] + 1) j++;
      const start = blockBounds(all[i], g.size, this.blockSize).start;
      const end = blockBounds(all[j], g.size, this.blockSize).end;
      const buf = await readVirtualAsync(g, start, end);
      const put = (k) => {
        const b = blockBounds(all[k], g.size, this.blockSize);
        this.cache.put(g.id, all[k], buf.slice(b.start - start, b.end - start));
      };
      // read-ahead blocks first: the least recently used, so the read's own blocks are never
      // the ones evicted before it copies them out
      for (let k = i; k <= j; k++) if (k >= missing.length) put(k);
      for (let k = i; k <= j; k++) if (k < missing.length) put(k);
      i = j + 1;
    }
  }

  // ------------------------------------------------------------ writes (user area only)

  writeSync(fd, src, position) {
    const f = this._fd(fd);
    if (f.kind === 'game') throw new VfsError('EACCES', `imported files are read-only: ${f.g.name}`);
    if (!f.write) throw new VfsError('EACCES', `fd ${fd} was opened without write access`);
    const n = f.node;
    const end = position + src.length;
    ensureCapacity(n, end);
    if (position > n.length) n.data.fill(0, n.length, position);
    n.data.set(src, position);
    if (end > n.length) n.length = end;
    n.mtime = Date.now();
    this._markDirty(f.key);
    return src.length;
  }

  /** Async alias, for symmetry with read(). */
  async write(fd, src, position) { return this.writeSync(fd, src, position); }

  /** SetEndOfFile. */
  truncate(fd, size) {
    const f = this._fd(fd);
    if (f.kind === 'game') throw new VfsError('EACCES', `imported files are read-only: ${f.g.name}`);
    if (!f.write) throw new VfsError('EACCES', `fd ${fd} was opened without write access`);
    ensureCapacity(f.node, size);
    if (size > f.node.length) f.node.data.fill(0, f.node.length, size);
    f.node.length = size;
    this._markDirty(f.key);
  }

  /** Whole-file convenience for the HLE and the settings page. */
  writeFile(path, bytes) {
    const fd = this.open(path, { write: true, create: true, truncate: true });
    try { this.writeSync(fd, bytes, 0); } finally { this.close(fd); }
  }

  /** DeleteFileA. Only user-area files; imported ones give EACCES. */
  unlink(path) {
    const r = this._resolve(path);
    const node = this.user.get(r.key);
    if (!node) {
      if (this.game.has(r.key)) throw new VfsError('EACCES', `imported files are read-only: ${path}`);
      throw new VfsError('ENOENT', `no such file: ${path}`);
    }
    if (node.isDir) throw new VfsError('EISDIR', `is a folder: ${path}`);
    this.user.delete(r.key);
    this.dirty.delete(r.key);
    this.deleted.set(r.key, this._userParts(r.key, node.name));
    this._scheduleFlush();
  }

  /** MoveFileA within the user area. */
  rename(from, to, { replace = false } = {}) {
    const a = this._resolve(from);
    const b = this._resolve(to);
    const node = this.user.get(a.key);
    if (!node) throw new VfsError(this.game.has(a.key) ? 'EACCES' : 'ENOENT', `cannot move ${from}`);
    if (node.isDir) throw new VfsError('EACCES', 'moving folders is not supported');
    if (this.game.has(b.key)) throw new VfsError('EACCES', `imported files are read-only: ${to}`);
    if (this.user.has(b.key) && !replace) throw new VfsError('EEXIST', `already exists: ${to}`);
    const pkey = this._parentKey(b.key);
    if (pkey === null || !this._isDirKey(pkey)) throw new VfsError('ENOTDIR', `folder does not exist for ${to}`);
    this._mirrorDir(pkey, b);
    const oldParts = this._userParts(a.key, node.name);
    this.user.delete(a.key);
    this.dirty.delete(a.key);
    this.deleted.set(a.key, oldParts);
    node.name = b.rel[b.rel.length - 1];
    this.user.set(b.key, node);
    this.deleted.delete(b.key);
    this._markDirty(b.key);
  }

  /** CreateDirectoryA (the game itself never calls it; the HLE may). */
  mkdir(path) {
    const r = this._resolve(path);
    if (this.stat(path)) throw new VfsError('EEXIST', `already exists: ${path}`);
    const pkey = this._parentKey(r.key);
    if (pkey === null || !this._isDirKey(pkey)) throw new VfsError('ENOTDIR', `parent folder missing: ${path}`);
    this._mkdirUser([r.mount.dir, ...r.rel]);
  }

  _mkdirUser(parts) {
    for (let i = 1; i <= parts.length; i++) {
      const key = foldCase(parts.slice(0, i).join('/'));
      if (!this.user.has(key)) {
        this.user.set(key, { name: parts[i - 1], isDir: true, data: null, length: 0, mtime: Date.now() });
        this.deleted.delete(key);
        this._markDirty(key);
      }
    }
  }

  /** Make sure a folder that exists only in the imported tree also exists in the user area. */
  _mirrorDir(pkey, r) {
    if (this.user.has(pkey)) return;
    // Recover original-case names for the parent chain.
    const parts = [r.mount.dir, ...r.rel.slice(0, -1)];
    this._mkdirUser(parts);
  }

  _userParts(key, name) {
    // Original-case path for a user key: rebuild from the parent nodes.
    const segs = key.split('/');
    const out = [];
    for (let i = 1; i < segs.length; i++) {
      const n = this.user.get(segs.slice(0, i).join('/'));
      out.push(n ? n.name : segs[i - 1]);
    }
    out.push(name);
    return out;
  }

  // ------------------------------------------------------------ persistence

  _markDirty(key) { this.dirty.set(key, ++this._changeSeq); this._scheduleFlush(); }

  _scheduleFlush(delay = this.autoFlushMs) {
    if (this.autoFlushMs === null || this.closed || this._flushTimer) return;
    if (this.dirty.size === 0 && this.deleted.size === 0) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(() => {
        // flush() has reported it; retry later (a lock held by another tab or a full disk
        // may clear).
        this._scheduleFlush(Math.max(2000, this.autoFlushMs * 8));
      });
    }, delay);
  }

  /**
   * Write the user area's changes to OPFS. Safe to call at any time; calls
   * are serialised. Hosts that never return to the event loop (a busy sync
   * Worker) must call this themselves at yield points (frame boundaries).
   */
  flush() {
    // A failed flush rejects its own promise but must not poison later ones,
    // and every change it did not write stays pending for the next call.
    const run = this._flushChain.catch(() => {}).then(() => this._flushNow());
    this._flushChain = run.catch(() => {});
    // Every failure is reported from here, whoever asked for the flush (the write-behind timer,
    // the host when its page is hidden, a settings page), and so is the first success after one.
    run.then(() => {
      if (!this._flushFailing) return;
      this._flushFailing = false;
      this._tell('flush-ok', 'the user area is written to OPFS again');
    }, (e) => {
      this._flushFailing = true;
      this._warn('flush-failed', `flush failed: ${e && e.name}: ${e && e.message}`);
    });
    return run;
  }

  async _flushNow() {
    if (!this.root || (this.dirty.size === 0 && this.deleted.size === 0)) return;
    const userRoot = await getDir(this.root, [USER_DIR], { create: true });
    // Each change is cleared only after it reached OPFS, and only if it was
    // not changed again meanwhile (the user area stays writable during awaits).
    for (const [key, parts] of [...this.deleted]) {
      const dir = await getDir(userRoot, parts.slice(0, -1));
      if (dir) await removeIfExists(dir, parts[parts.length - 1], { recursive: true });
      if (this.deleted.get(key) === parts) this.deleted.delete(key);
    }
    const pending = [...this.dirty].sort((a, b) => a[0].split('/').length - b[0].split('/').length);
    for (const [key, seq] of pending) {
      const node = this.user.get(key);
      if (!node) { if (this.dirty.get(key) === seq) this.dirty.delete(key); continue; }
      const parts = this._userParts(key, node.name);
      if (node.isDir) await getDir(userRoot, parts, { create: true });
      else {
        const dir = await getDir(userRoot, parts.slice(0, -1), { create: true });
        this.info.userWriteMethod = await writeWholeFile(dir, node.name, node.data.slice(0, node.length));
      }
      if (this.dirty.get(key) === seq) this.dirty.delete(key);
    }
  }

  /** Export the user area as a zip (Uint8Array). Paths look like "ReACT/replay/vs00_0.rpd". */
  exportUserZip() {
    const files = [];
    for (const [key, n] of [...this.user].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const path = this._userParts(key, n.name).join('/');
      files.push(n.isDir ? { path: path + '/', data: null, mtime: new Date(n.mtime) } : { path, data: n.data.subarray(0, n.length), mtime: new Date(n.mtime) });
    }
    return writeZip(files);
  }

  /**
   * Import a zip into the user area (async: deflate needs DecompressionStream).
   * Every entry must sit under a mount folder (ReACT/ or MeltyBlood/); the
   * whole zip is rejected otherwise, before anything is written. With
   * replace=true the user area is emptied first. Returns the imported paths.
   */
  async importUserZip(bytes, { replace = false } = {}) {
    const entries = await readZip(bytes);
    const mountDirs = new Map(this.mounts.map((m) => [foldCase(m.dir), m.dir]));
    const bad = entries.filter((e) => !mountDirs.has(foldCase(e.path.split('/')[0])));
    if (bad.length) throw new ZipError(`zip entries outside ${[...mountDirs.values()].join('/, ')}/: ${bad.slice(0, 5).map((e) => e.path).join(', ')}`);
    for (const e of entries) {
      const parts = e.path.replace(/\/$/, '').split('/');
      const key = foldCase(parts.join('/'));
      if (this.game.has(key)) throw new ZipError(`zip would replace an imported file: ${e.path}`);
    }
    if (replace) {
      for (const [key, n] of this.user) this.deleted.set(key, this._userParts(key, n.name));
      this.user.clear();
      this.dirty.clear();
    }
    const done = [];
    for (const e of entries) {
      const parts = e.path.replace(/\/$/, '').split('/');
      parts[0] = mountDirs.get(foldCase(parts[0]));
      if (e.isDir) { this._mkdirUser(parts); continue; }
      this._mkdirUser(parts.slice(0, -1));
      const key = foldCase(parts.join('/'));
      const existing = this.user.get(key);
      if (existing && existing.isDir) throw new ZipError(`zip file collides with a folder: ${e.path}`);
      this.user.set(key, { name: existing ? existing.name : parts[parts.length - 1], isDir: false, data: e.data, length: e.data.length, mtime: Date.now() });
      this.deleted.delete(key);
      this._markDirty(key);
      done.push(parts.join('/'));
    }
    for (const mt of this.mounts) if (foldCase(mt.dir) === 'react') this._mkdirUser([mt.dir, 'replay']);
    await this.flush();
    return done;
  }

  /**
   * Flush and release the sync access handles. The handles are released even
   * when the flush fails; the flush error is then rethrown (the unwritten
   * changes are lost with this object, so callers should report it).
   */
  async unmount() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    try {
      await this.flush();
    } finally {
      this.closed = true;
      for (const g of this.game.values()) if (g.ah) { try { g.ah.close(); } catch {} g.ah = null; }
      this.fds.clear();
      if (this.cache) this.cache.clear();
    }
  }
}

function readUser(node, dst, position) {
  if (position >= node.length) return 0;
  const n = Math.min(dst.length, node.length - position);
  dst.set(node.data.subarray(position, position + n));
  return n;
}

function ensureCapacity(node, size) {
  if (node.data.length >= size) return;
  const cap = Math.max(size, Math.min(node.data.length * 2 || 4096, size + (16 << 20)));
  const d = new Uint8Array(cap);
  d.set(node.data.subarray(0, node.length));
  node.data = d;
}

/**
 * Bytes [at, at + dst.length) of an imported file as the game sees it, read through
 * its sync handle. For a trimmed copy the range is mapped onto the stored bytes (one
 * contiguous stored read: kept ranges are stored in file order); bytes that were not
 * stored read as 0. Returns the count (short only at the end of the file).
 */
function readVirtualSync(g, dst, at) {
  if (!g.map) return syncReadFull(g, dst, at);
  const end = Math.min(at + dst.length, g.size);
  if (end <= at) return 0;
  const { s0, s1, pieces } = g.map.span(at, end);
  if (pieces.length === 1 && pieces[0].v0 === at && pieces[0].v1 === end) return syncReadFull(g, dst.subarray(0, end - at), s0);
  dst.fill(0, 0, end - at);
  if (pieces.length) {
    const tmp = new Uint8Array(s1 - s0);
    syncReadFull(g, tmp, s0);
    for (const p of pieces) dst.set(tmp.subarray(p.s0 - s0, p.s0 - s0 + (p.v1 - p.v0)), p.v0 - at);
  }
  return end - at;
}

/** Async twin of readVirtualSync through the File snapshot: returns the bytes [start, end). */
async function readVirtualAsync(g, start, end) {
  if (!g.map) return new Uint8Array(await g.file.slice(start, end).arrayBuffer());
  end = Math.min(end, g.size);
  if (end <= start) return new Uint8Array(0);
  const { s0, s1, pieces } = g.map.span(start, end);
  if (pieces.length === 1 && pieces[0].v0 === start && pieces[0].v1 === end) return new Uint8Array(await g.file.slice(s0, s1).arrayBuffer());
  const out = new Uint8Array(end - start);
  if (pieces.length) {
    const tmp = new Uint8Array(await g.file.slice(s0, s1).arrayBuffer());
    for (const p of pieces) out.set(tmp.subarray(p.s0 - s0, p.s0 - s0 + (p.v1 - p.v0)), p.v0 - start);
  }
  return out;
}

function syncReadFull(g, dst, at) {
  let done = 0;
  while (done < dst.length) {
    const n = g.ah.read(dst.subarray(done), { at: at + done });
    if (n <= 0) break;
    done += n;
  }
  return done;
}

async function listTreeWithDirs(dir, parts = []) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    const p = [...parts, name];
    if (h.kind === 'directory') { out.push({ parts: p, isDir: true }); out.push(...(await listTreeWithDirs(h, p))); }
    else out.push({ parts: p, isDir: false, handle: h });
  }
  return out;
}

class HttpFile {
  constructor(url, size, { wholeFetch = false } = {}) {
    this.url = url;
    this.size = size;
    this.wholeFetch = wholeFetch;
    this._full = null; // fallback cache only if server ignores Range on a large (> 1 MiB) file
  }
  slice(start, end) {
    const s = Math.max(0, start);
    const e = Math.min(this.size, end);
    return {
      arrayBuffer: async () => {
        if (e <= s) return new ArrayBuffer(0);
        if (this._full) return this._full.slice(s, e);
        const fullRange = s === 0 && e === this.size;
        const r = (this.wholeFetch || fullRange)
          ? await fetch(this.url)
          : await fetch(this.url, { headers: { Range: `bytes=${s}-${e - 1}` } });
        if (r.status === 206) {
          const buf = await r.arrayBuffer();
          if (buf.byteLength !== e - s) {
            throw new Error(`short Range response for ${this.url}: expected ${e - s}, got ${buf.byteLength}`);
          }
          return buf;
        }
        if (r.status === 200) {
          const full = await r.arrayBuffer();
          if (full.byteLength !== this.size) {
            throw new Error(`short response for ${this.url}: expected ${this.size}, got ${full.byteLength}`);
          }
          if (fullRange) return full;
          if (!this.wholeFetch && this.size > (1 << 20)) this._full = full;
          return full.slice(s, e);
        }
        throw new Error(`HTTP ${r.status} reading ${this.url} [${s}-${e - 1}]`);
      },
    };
  }
}

// A stored file in pieces, each a file of its own that is fetched whole. The pieces follow one
// another without gaps and may differ in size (pieces cut at the block boundaries of a trimmed
// archive, tools/make-site.mjs).
class ChunkedHttpFile {
  constructor(parts, size) {
    this.parts = parts;
    this.size = size;
    this.off = new Float64Array(parts.length + 1); // where each piece starts in the stored file
    for (let i = 0; i < parts.length; i++) this.off[i + 1] = this.off[i] + parts[i].size;
    if (this.off[parts.length] !== size) throw new VfsError('EINVAL', `bundle pieces add up to ${this.off[parts.length]} bytes of ${size}`);
  }
  /** Index of the piece that holds stored offset s (0 <= s < size). */
  _find(s) {
    let lo = 0, hi = this.parts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.off[mid] <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  slice(start, end) {
    const s = Math.max(0, start);
    const e = Math.min(this.size, end);
    return {
      arrayBuffer: async () => {
        if (e <= s) return new ArrayBuffer(0);
        const first = this._find(s);
        const reqs = [];
        for (let i = first; i < this.parts.length && this.off[i] < e; i++) {
          const base = this.off[i];
          const from = Math.max(s, base) - base;
          const to = Math.min(e, base + this.parts[i].size) - base;
          if (to > from) reqs.push(this.parts[i].slice(from, to).arrayBuffer());
        }
        if (reqs.length === 1) return reqs[0];
        const bufs = await Promise.all(reqs);
        const out = new Uint8Array(e - s);
        let off = 0;
        for (const b of bufs) {
          out.set(new Uint8Array(b), off);
          off += b.byteLength;
        }
        return out.buffer;
      },
    };
  }
}
