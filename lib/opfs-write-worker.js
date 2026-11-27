// Helper for browsers whose main thread has no FileSystemFileHandle.createWritable():
// the page sends { id, handle, bytes } and this worker writes the whole file
// through a synchronous access handle.
self.onmessage = async (ev) => {
  const { id, handle, bytes } = ev.data;
  let ah = null;
  try {
    ah = await handle.createSyncAccessHandle();
    ah.truncate(0);
    const n = ah.write(bytes, { at: 0 });
    if (n !== bytes.byteLength) throw new Error(`short write: ${n} of ${bytes.byteLength}`);
    ah.flush();
    self.postMessage({ id });
  } catch (e) {
    self.postMessage({ id, error: { name: e.name, message: e.message } });
  } finally {
    if (ah) try { ah.close(); } catch {}
  }
};
