// Block cache for random-access reads of the imported (immutable) files.
//
// Files are split into fixed blocks (default 1 MiB, see README "Block size" for
// the measurements behind it). A read is served from cached blocks; missing
// blocks are fetched by the caller (synchronously or asynchronously; the cache
// itself never does I/O) and inserted, then the read is copied out.
// Reads that would cover more than half the cache bypass it, so one large
// read (the BGM MapViewOfFile window, a whole 372 MB file) cannot flush
// everything else.
//
// Only imported files are cached. They never change while mounted, so no
// invalidation is needed.

export const DEFAULT_BLOCK_SIZE = 1 << 20;
export const DEFAULT_CACHE_BYTES = 64 << 20;

/**
 * Which blocks does [offset, offset+length) touch, clamped to fileSize?
 * Returns { first, last, start, end } with end exclusive, or null when the
 * clamped range is empty (offset at or past EOF, or length 0).
 */
export function blockSpan(offset, length, fileSize, blockSize = DEFAULT_BLOCK_SIZE) {
  if (!(offset >= 0) || !(length >= 0)) throw new RangeError(`bad range ${offset}+${length}`);
  const start = offset;
  const end = Math.min(offset + length, fileSize);
  if (end <= start) return null;
  return { first: Math.floor(start / blockSize), last: Math.floor((end - 1) / blockSize), start, end };
}

/** Byte range [start, end) of block `index` in a file of fileSize. */
export function blockBounds(index, fileSize, blockSize = DEFAULT_BLOCK_SIZE) {
  const start = index * blockSize;
  return { start, end: Math.min(start + blockSize, fileSize) };
}

export class BlockCache {
  constructor({ blockSize = DEFAULT_BLOCK_SIZE, maxBytes = DEFAULT_CACHE_BYTES } = {}) {
    if (blockSize <= 0 || (blockSize & (blockSize - 1)) !== 0) throw new RangeError('blockSize must be a power of two');
    this.blockSize = blockSize;
    this.maxBlocks = Math.max(1, Math.floor(maxBytes / blockSize));
    this.map = new Map(); // "fileId:index" -> Uint8Array, insertion order = LRU order
    this.stats = { hits: 0, misses: 0, bypass: 0, evictions: 0 };
  }

  _key(fileId, index) { return `${fileId}:${index}`; }

  /** True when a read of this size should go straight to the backend. */
  shouldBypass(span) {
    return span !== null && span.last - span.first + 1 > this.maxBlocks / 2;
  }

  /**
   * Block indices of the span that are not cached (in ascending order).
   * The span's cached blocks are also moved to the most-recently-used end, so
   * that inserting the missing ones (at most half the cache, see
   * shouldBypass) cannot evict blocks this same read still needs.
   */
  missing(fileId, span) {
    const out = [];
    if (!span) return out;
    for (let i = span.first; i <= span.last; i++) {
      const k = this._key(fileId, i);
      const b = this.map.get(k);
      if (b) { this.map.delete(k); this.map.set(k, b); } else out.push(i);
    }
    return out;
  }

  get(fileId, index) {
    const k = this._key(fileId, index);
    const b = this.map.get(k);
    if (b) { this.map.delete(k); this.map.set(k, b); } // touch
    return b;
  }

  put(fileId, index, bytes) {
    const k = this._key(fileId, index);
    this.map.delete(k);
    this.map.set(k, bytes);
    while (this.map.size > this.maxBlocks) {
      this.map.delete(this.map.keys().next().value);
      this.stats.evictions++;
    }
  }

  /**
   * Copy span bytes into dst[dstOffset...]. All blocks must be present
   * (call missing() first). Returns bytes copied.
   */
  copyOut(fileId, span, dst, dstOffset = 0) {
    if (!span) return 0;
    const bs = this.blockSize;
    let pos = span.start;
    let out = dstOffset;
    for (let i = span.first; i <= span.last; i++) {
      const b = this.get(fileId, i);
      if (!b) throw new Error(`block ${fileId}:${i} not cached`);
      const from = pos - i * bs;
      const to = Math.min(b.length, span.end - i * bs);
      dst.set(b.subarray(from, to), out);
      out += to - from;
      pos += to - from;
    }
    return out - dstOffset;
  }

  clear() { this.map.clear(); }
  get bytes() { let n = 0; for (const b of this.map.values()) n += b.length; return n; }
}
