// Background prefetching of what the game will read next (data/prefetch.json).
//
// The game stops while one of its reads waits for the network (lib/vfs.js async mode), so
// data for the screens every player goes through after start-up (title, main menu and its
// music, character select, the opening movie) is fetched into the block cache ahead of time.
// One piece at a time, and never while the game itself is waiting for a read or the tab is
// hidden, so it cannot hold up the game's own loads.
//
// The list comes from a recorded run: play.html?traceReads=1 fills window.mbrReadTrace with
// [frame, file, offset, length]; buildPrefetchList() turns a frame range of it into entries.

const STEP = 1 << 20; // per fetch: four of the cache's 256 KiB blocks (play.js), fetched together

/** Entries { file, ranges: [[offset, length], ...] } from a read trace, in first-read order. */
export function buildPrefetchList(trace, fromFrame, toFrame, gap = 64 << 10) {
  const files = new Map();
  for (const [frame, file, offset, length] of trace) {
    if (frame < fromFrame || frame >= toFrame) continue;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push([offset, offset + length]);
  }
  const entries = [];
  for (const [file, rs] of files) {
    rs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of rs) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + gap) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    entries.push({ file, ranges: merged.map(([a, b]) => [a, b - a]) });
  }
  return entries;
}

/**
 * Fetch the list's ranges into fs's block cache.
 *   mounts   [{ path, dir }]: a list file "react/00.p" is read as `${path}\00.p` of the mount
 *            whose dir is ReACT (case-insensitive)
 *   isBusy   () => true while the game waits for a read of its own
 *   budget   stop after this many bytes asked for
 * Returns { bytes, ms, skipped }.
 */
export async function runPrefetch(fs, entries, { mounts, isBusy = () => false, budget = 64 << 20, pauseMs = 20 } = {}) {
  const t0 = performance.now();
  const idle = async () => {
    while (isBusy() || document.visibilityState === 'hidden') await sleep(50);
  };
  let bytes = 0, skipped = 0;
  for (const { file, ranges } of entries) {
    const slash = file.indexOf('/');
    const mount = mounts.find((m) => m.dir.toLowerCase() === file.slice(0, slash).toLowerCase());
    const path = mount && `${mount.path}\\${file.slice(slash + 1)}`;
    if (!path || !fs.exists(path)) { skipped++; continue; }
    const size = fs.size(path);
    for (let [offset, length] of ranges) {
      if (offset < 0) offset = Math.max(0, size + offset);
      const end = Math.min(size, offset + length);
      for (let at = offset; at < end; at += STEP) {
        if (bytes >= budget) return { bytes, ms: Math.round(performance.now() - t0), skipped, stopped: 'budget' };
        await idle();
        const n = Math.min(STEP, end - at);
        await fs.prefetch(path, at, n);
        bytes += n;
        await sleep(pauseMs);
      }
    }
  }
  return { bytes, ms: Math.round(performance.now() - t0), skipped };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
