// Windows path handling for the virtual C:\ drive. Pure functions.
//
// The game uses Win32 paths: relative (`.\cfg.cfg`, `replay\*.RPD`, `00.p`),
// absolute with a drive (`C:\MeltyBlood\data00.p`, from the emulated registry
// or `_Path.dat`), either slash, any letter case. These are mapped onto
// mounts: each mount ties a virtual directory (`C:\ReACT`) to a folder name
// that exists both under OPFS game/ (read-only imported files) and user/
// (files the game writes).

/** Default mounts. The base-game path belongs to the HLE (registry / _Path.dat), so it is configurable. */
export const DEFAULT_MOUNTS = Object.freeze([
  Object.freeze({ path: 'C:\\ReACT', dir: 'ReACT' }),
  Object.freeze({ path: 'C:\\MeltyBlood', dir: 'MeltyBlood' }),
]);
export const DEFAULT_CWD = 'C:\\ReACT';

export class PathError extends Error {
  constructor(code, msg) { super(msg); this.name = 'PathError'; this.code = code; }
}

/**
 * Split and normalise a Windows path to { drive, parts } with `.` and `..`
 * resolved against `cwd`. Windows rules applied:
 *  - `/` and `\` are both separators; repeated separators collapse;
 *  - trailing dots and spaces are stripped from each component (`foo.` == `foo`);
 *  - `..` above the drive root stays at the root;
 *  - a path starting with one separator is relative to the drive of cwd.
 * Device, UNC and `\\?\` paths, and the reserved characters <>:"|?* inside
 * components (outside the drive), are rejected with PathError('EINVAL').
 * Wildcards are allowed only when `allowWildcards` is set (FindFirstFile).
 */
export function normalizeWinPath(path, cwd = DEFAULT_CWD, { allowWildcards = false } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new PathError('EINVAL', 'empty path');
  if (path.includes('\0')) throw new PathError('EINVAL', 'NUL in path');
  let p = path.replace(/\//g, '\\');
  if (p.startsWith('\\\\')) throw new PathError('EINVAL', `UNC or device path not supported: ${path}`);
  let drive;
  let parts;
  const m = /^([A-Za-z]):(.*)$/.exec(p);
  if (m) {
    drive = m[1].toUpperCase();
    const rest = m[2];
    if (rest.startsWith('\\')) parts = [];
    else {
      // "C:foo" is relative to the drive's current directory; only cwd's drive has one here.
      const c = normalizeWinPath(cwd, 'C:\\');
      parts = c.drive === drive ? [...c.parts] : [];
    }
    p = rest;
  } else {
    const c = normalizeWinPath(cwd, 'C:\\');
    drive = c.drive;
    parts = p.startsWith('\\') ? [] : [...c.parts];
  }
  for (let comp of p.split('\\')) {
    if (comp === '' || comp === '.') continue;
    if (comp === '..') { parts.pop(); continue; }
    comp = comp.replace(/[. ]+$/, '');
    if (comp === '') continue; // "..." and similar collapse to nothing on Windows
    const bad = allowWildcards ? /[<>:"|]/ : /[<>:"|?*]/;
    if (bad.test(comp)) throw new PathError('EINVAL', `invalid character in path component "${comp}"`);
    parts.push(comp);
  }
  return { drive, parts };
}

/** Case-insensitive key for a name or path. Windows folds case with simple uppercase mapping; lower case is equivalent for ASCII and Shift-JIS-decoded names. */
export const foldCase = (s) => s.toLowerCase();

/**
 * Resolve a Windows path to a mount.
 * Returns { mount, rel: [components], key } or null when the path is outside
 * every mount (the caller reports ERROR_PATH_NOT_FOUND). `key` is the
 * case-folded "dir/a/b" string used for lookups; the mount root itself has
 * rel = [].
 */
export function resolveWinPath(path, { mounts = DEFAULT_MOUNTS, cwd = DEFAULT_CWD, allowWildcards = false } = {}) {
  const { drive, parts } = normalizeWinPath(path, cwd, { allowWildcards });
  let best = null;
  for (const mt of mounts) {
    const mp = normalizeWinPath(mt.path, 'C:\\');
    if (mp.drive !== drive || mp.parts.length > parts.length) continue;
    let ok = true;
    for (let i = 0; i < mp.parts.length; i++) {
      if (foldCase(mp.parts[i]) !== foldCase(parts[i])) { ok = false; break; }
    }
    if (ok && (!best || mp.parts.length > best.depth)) best = { mount: mt, depth: mp.parts.length };
  }
  if (!best) return null;
  const rel = parts.slice(best.depth);
  return { mount: best.mount, rel, key: foldCase([best.mount.dir, ...rel].join('/')) };
}

/**
 * FindFirstFile-style wildcard match, case-insensitive.
 * `*` matches any run (including empty), `?` one character. Windows quirks
 * kept: `*.*` and `*` match every name, including names without a dot;
 * a pattern ending in `.` (e.g. `*.`) matches names without an extension.
 */
export function matchWildcard(pattern, name) {
  const p = foldCase(pattern);
  const n = foldCase(name);
  if (p === '*' || p === '*.*') return true;
  if (p.endsWith('.') && !p.endsWith('*.')) return matchWildcard(p.slice(0, -1), n);
  if (p.endsWith('*.')) return !n.includes('.') && matchWildcard(p.slice(0, -1), n);
  // iterative glob with backtracking on the last star
  let pi = 0, ni = 0, star = -1, mark = 0;
  while (ni < n.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === n[ni])) { pi++; ni++; }
    else if (pi < p.length && p[pi] === '*') { star = pi++; mark = ni; }
    else if (star >= 0) { pi = star + 1; ni = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  // "*.rpd"-style trailing ".*" also matches a name with no extension on Windows
  if (pi < p.length && p.slice(pi) === '.*') return true;
  return pi === p.length;
}

/**
 * Split a FindFirstFile argument ("C:\ReACT\replay\*.RPD") into the directory
 * path and the pattern ("*.RPD"). A path without wildcards lists that one name.
 */
export function splitPattern(path) {
  const p = path.replace(/\//g, '\\');
  const i = p.lastIndexOf('\\');
  if (i < 0) {
    const m = /^([A-Za-z]:)(.*)$/.exec(p);
    if (m) return { dir: m[1], pattern: m[2] || '*' };
    return { dir: '.', pattern: p || '*' };
  }
  return { dir: p.slice(0, i) || '\\', pattern: p.slice(i + 1) || '*' };
}
