// Small OPFS helpers shared by the import worker, the page and the file-access
// module. Everything lives under one OPFS directory (default "mbr"):
//
//   mbr/
//     import-state.json        completion records; the only proof a file is imported
//     game/ReACT/...            imported files (written only by the import worker)
//     game/MeltyBlood/...
//     user/ReACT/...            files the game writes (cfg, replay/*.rpd, saves)
//     user/MeltyBlood/...
//
// A different root name isolates tests from a real import.

import { GAME_DIR, USER_DIR, STATE_FILE } from './manifest.js';

export const DEFAULT_ROOT = 'mbr';
export const STATE_VERSION = 1;

export const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

export function opfsAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

export async function getRoot(rootName = DEFAULT_ROOT, { create = true } = {}) {
  const top = await navigator.storage.getDirectory();
  return top.getDirectoryHandle(rootName, { create });
}

/** Walk/create nested directories. Returns the handle or null when missing and !create. */
export async function getDir(base, parts, { create = false } = {}) {
  let d = base;
  for (const p of parts) {
    try { d = await d.getDirectoryHandle(p, { create }); }
    catch (e) { if (!create && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw e; }
  }
  return d;
}

export async function getFileIfExists(dir, name) {
  try { return await dir.getFileHandle(name); }
  catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null; throw e; }
}

/** Recursively list files: [{ parts:[dirs...], name, handle, size }]. */
export async function listTree(dir, parts = []) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') out.push(...(await listTree(h, [...parts, name])));
    else {
      const file = await h.getFile();
      out.push({ parts, name, handle: h, size: file.size });
    }
  }
  return out;
}

/** Read the completion records. An unreadable or corrupt state file counts as empty. */
export async function readState(root) {
  const empty = { version: STATE_VERSION, files: {} };
  const h = await getFileIfExists(root, STATE_FILE);
  if (!h) return empty;
  try {
    const s = JSON.parse(await (await h.getFile()).text());
    if (!s || s.version !== STATE_VERSION || typeof s.files !== 'object' || s.files === null) return empty;
    return s;
  } catch { return empty; }
}

/**
 * Write a whole small file. In a Worker this uses a synchronous access handle;
 * on the main thread createWritable() where the browser has it, otherwise a
 * helper Worker (lib/opfs-write-worker.js) does the sync-handle write.
 */
export async function writeWholeFile(dir, name, bytes) {
  // Safari 27 bug (probed 2026-11-22, tests/browser/probe-writable.html):
  // FileSystemWritableFileStream.write(view) writes the view's whole
  // ArrayBuffer, ignoring byteOffset and byteLength. Always pass an exact buffer.
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
  const h = await dir.getFileHandle(name, { create: true });
  if (inWorker && typeof h.createSyncAccessHandle === 'function') {
    const ah = await h.createSyncAccessHandle();
    try {
      ah.truncate(0);
      const n = ah.write(bytes, { at: 0 });
      if (n !== bytes.byteLength) throw new Error(`short write to ${name}: ${n} of ${bytes.byteLength}`);
      ah.flush();
    } finally { ah.close(); }
    return 'sync-handle';
  }
  if (typeof h.createWritable === 'function') {
    const w = await h.createWritable();
    try { await w.write(bytes); await w.close(); }
    catch (e) { try { await w.abort(); } catch {} throw e; }
    return 'writable';
  }
  await helperWrite(h, bytes);
  return 'helper-worker';
}

let helper = null;
let helperSeq = 0;
const helperWaiters = new Map();
function helperWrite(handle, bytes) {
  if (!helper) {
    helper = new Worker(new URL('./opfs-write-worker.js', import.meta.url), { type: 'module' });
    helper.onmessage = (ev) => {
      const w = helperWaiters.get(ev.data.id);
      helperWaiters.delete(ev.data.id);
      if (!w) return;
      if (ev.data.error) w.reject(Object.assign(new Error(ev.data.error.message), { name: ev.data.error.name }));
      else w.resolve();
    };
  }
  const id = ++helperSeq;
  return new Promise((resolve, reject) => {
    helperWaiters.set(id, { resolve, reject });
    const copy = bytes.slice();
    helper.postMessage({ id, handle, bytes: copy }, [copy.buffer]);
  });
}

/**
 * Open a synchronous access handle for reading only. Where the browser has
 * the `mode` option (Chrome 121+) this is a shared lock, so a running game,
 * the import page's re-hash and a second tab can all read at once; elsewhere
 * the option is ignored and the handle is exclusive.
 */
export async function openSyncRead(fileHandle) {
  try { return await fileHandle.createSyncAccessHandle({ mode: 'read-only' }); }
  catch (e) { if (e.name === 'TypeError') return fileHandle.createSyncAccessHandle(); throw e; }
}

export async function writeState(root, state) {
  return writeWholeFile(root, STATE_FILE, new TextEncoder().encode(JSON.stringify(state, null, 1)));
}

export async function removeIfExists(dir, name, opts = {}) {
  try { await dir.removeEntry(name, opts); return true; }
  catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
}

export const gameDir = (root, create = false) => getDir(root, [GAME_DIR], { create });
export const userDir = (root, create = false) => getDir(root, [USER_DIR], { create });

/** Friendly text for storage exceptions (quota, locks, missing support). */
export function describeStorageError(e) {
  const name = e && e.name;
  if (name === 'QuotaExceededError') {
    return 'The browser ran out of storage quota for this site. Free disk space or allow more storage, then import again (finished files are kept).';
  }
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') {
    return 'The file is locked by another tab or worker (an open game or a second import page). Close it and try again.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The browser refused storage access (private browsing, or site data blocked). Use a normal window and allow site data.';
  }
  return (e && e.message) || String(e);
}
