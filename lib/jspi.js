// JavaScript Promise Integration for the game build, done by hand.
//
// The wasm is an ordinary synchronous module. A few of its imports are asynchronous
// (wait for the next frame, an OPFS read, switch to another guest thread): in the C
// source they are written with MBR_ASYNC_JS (recompiler/runtime/host_async.h), which makes
// each one call Module.mbrSuspend(async () => { ... }) and return the promise.
//
// installJspi() hooks Emscripten's instantiation and
//   - wraps those imports in WebAssembly.Suspending, so a call suspends the wasm stack
//     until the promise settles and then returns its value;
//   - wraps the entry points in WebAssembly.promising, so each call of one runs on its own
//     suspendable stack and returns a promise: `mbr_main` (the game) and `mbr_fiber_entry`
//     (one call per guest thread, see hle_thread.c).
// The imports are recognised by the marker call in their source text, not by name, so it
// does not matter how the Emscripten version names or minifies imports.
//
// Works in browsers and in Node (pass `wasm` as bytes there).

export const hasJspi = typeof WebAssembly === 'object'
  && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';

const PROMISING_EXPORTS = ['mbr_main', 'mbr_fiber_entry'];

/**
 * Instantiate the build from `wasm`: a URL, a Response / Promise<Response> from an early fetch,
 * or its bytes. Compiles while it downloads; if that fails (a server that does not send the .wasm
 * as application/wasm, for one) it fetches the bytes again and instantiates those, as
 * Emscripten's own loader does. Used by both build modes (JSPI here, Asyncify in play.js).
 */
export async function instantiateBuild(wasm, imports) {
  const isUrl = typeof wasm === 'string' || wasm instanceof URL;
  const isResponse = wasm && (typeof wasm.then === 'function' || (typeof Response !== 'undefined' && wasm instanceof Response));
  if (!isUrl && !isResponse) return WebAssembly.instantiate(wasm, imports);
  const response = isUrl ? await fetch(wasm, { credentials: 'same-origin' }) : await wasm;
  const url = response.url || (isUrl ? String(wasm) : 'wasm');
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  try {
    return await WebAssembly.instantiateStreaming(response, imports);
  } catch (streamError) {
    // not a failure of the download or of compiling as it streams: the same bytes would fail the same way
    if (!response.url || streamError instanceof RangeError) throw streamError;
    const again = await fetch(response.url, { credentials: 'same-origin' });
    if (!again.ok) throw streamError;
    return WebAssembly.instantiate(await again.arrayBuffer(), imports);
  }
}

/**
 * Prepare an Emscripten module argument for JSPI.
 *   moduleArg  the object passed to the generated factory
 *   wasm       URL of the .wasm (browser), a Response / Promise<Response> from an early fetch,
 *              or its bytes (ArrayBuffer / typed array)
 * Returns moduleArg.
 */
export function installJspi(moduleArg, wasm) {
  if (!hasJspi) throw new Error('this JavaScript engine has no WebAssembly.Suspending / WebAssembly.promising (JSPI)');
  moduleArg.mbrSuspend = (start) => start();
  moduleArg.instantiateWasm = (imports, receiveInstance) => {
    let wrapped = 0;
    for (const ns of Object.values(imports)) {
      for (const [name, fn] of Object.entries(ns)) {
        if (typeof fn === 'function' && Function.prototype.toString.call(fn).includes('mbrSuspend(')) {
          ns[name] = new WebAssembly.Suspending(fn);
          wrapped++;
        }
      }
    }
    (async () => {
      const result = await instantiateBuild(wasm, imports);
      // instance.exports is frozen: hand Emscripten a copy with the entry points replaced
      const exports = { ...result.instance.exports };
      for (const name of PROMISING_EXPORTS) {
        if (typeof exports[name] !== 'function') throw new Error(`the build has no export "${name}" (export names must not be minified)`);
        exports[name] = WebAssembly.promising(exports[name]);
      }
      if (!wrapped) throw new Error('no suspending import found in the build (was it built in asyncify mode?)');
      receiveInstance({ exports }, result.module);
    })().catch((e) => {
      if (moduleArg.onInstantiateError) moduleArg.onInstantiateError(e); else throw e;
    });
    return {}; // asynchronous: receiveInstance is called later
  };
  return moduleArg;
}
