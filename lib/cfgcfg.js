// cfg.cfg: the game's encrypted configuration and save file, decoded and encoded exactly as
// mbr.exe does it (load FUN_004381c0, save FUN_00438420), plus accessors for the controller
// button configuration that the original edited in its launcher (dialog 105, proc 0x444520).
//
// Layout (406,100 bytes):
//   0x00000  0x4f50 bytes   config block, loaded to guest 0x9e2fc0
//   0x04f50  4 x int32      checksums c0..c3 of the plaintext (see sums())
//   0x04f60  int32          seed
//   0x04f64  0x5e2f0 bytes  save block, loaded to guest 0x9e7f10 (unlocks, records, ...)
// Both blocks form one 0x63240-byte plaintext P at 0x9e2fc0. Each byte is XORed with the low
// byte of the game's rand() (MSVC LCG: s = s*0x343fd + 0x269ec3; (s >> 16) & 0x7fff) after
// srand(seed). A file whose sums do not match makes the game reset everything to defaults,
// save, and exit, so encode() always recomputes them.
//
// Controller configuration inside P (guest address - 0x9e2fc0):
//   0x9e2fd0 + 10*p + f   slot of function f for player p (p 0..3); a joystick button b drives
//                         slot b (b 0..9), keyboard key f of the player drives slot [f], so
//                         keyboard keys never change. Functions: 0 A, 1 B, 2 C, 3 D, 4 A+D,
//                         5 A+B, 6 A+B+C, 7 and 8 unused, 9 PAUSE. Defaults: identity.
//   0x9e2ff8 + 2*p + i    menu confirm (i 0) and cancel (i 1) slots: copies of functions A and B,
//                         written by the launcher's OK button (0x4447ff).
//   0xa46174 byte p       bits 0..2: "Do not use" for the macros A+D, A+B, A+B+C (set = off).

export const FILE_SIZE = 0x4f50 + 20 + 0x5e2f0;
export const PLAIN_SIZE = 0x63240;
export const GUEST_BASE = 0x9e2fc0;
const CFG_OFF = 0x9e2fd0 - GUEST_BASE;
const MENU_OFF = 0x9e2ff8 - GUEST_BASE;
const MACRO_OFF = 0xa46174 - GUEST_BASE;

/** Game functions a controller button can be assigned to, in the launcher dialog's order. */
export const FUNCTIONS = Object.freeze([
  { f: 0, name: 'A' }, { f: 1, name: 'B' }, { f: 2, name: 'C' }, { f: 3, name: 'D' },
  { f: 9, name: 'PAUSE' }, { f: 4, name: 'A+D' }, { f: 5, name: 'A+B' }, { f: 6, name: 'A+B+C' },
]);
/** Joystick buttons the game can see: the 10-entry table at 0x47c29c. */
export const GAME_BUTTONS = 10;

function keystream(seed, n) {
  const k = new Uint8Array(n);
  let s = seed | 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 0x343fd) + 0x269ec3) | 0;
    k[i] = (s >> 16) & 0xff; // & 0x7fff, then only the low byte is used
  }
  return k;
}

/** The four sums the game stores, over the plaintext (32-bit wrap-around). */
export function sums(plain) {
  let total = 0, alt = 0;
  for (let i = 0; i < plain.length; i++) {
    const b = plain[i];
    total = (total + b) | 0;
    alt = (i & 1 ? alt - b : alt + b) | 0;
  }
  return [(-total) | 0, total, alt, alt];
}

export class CfgError extends Error {}

/** Decode a cfg.cfg file: { plain (Uint8Array, PLAIN_SIZE), seed, stored, ok }. */
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length !== FILE_SIZE) throw new CfgError(`cfg.cfg is ${bytes.length} bytes, expected ${FILE_SIZE}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stored = [0, 1, 2, 3].map((i) => dv.getInt32(0x4f50 + 4 * i, true));
  const seed = dv.getInt32(0x4f60, true);
  const plain = new Uint8Array(PLAIN_SIZE);
  plain.set(bytes.subarray(0, 0x4f50), 0);
  plain.set(bytes.subarray(0x4f64), 0x4f50);
  const k = keystream(seed, PLAIN_SIZE);
  for (let i = 0; i < PLAIN_SIZE; i++) plain[i] ^= k[i];
  const s = sums(plain);
  return { plain, seed, stored, ok: s.every((v, i) => v === stored[i]) };
}

/** Encode a plaintext with a seed (keep the file's own seed to change as little as possible). */
export function encode(plain, seed) {
  if (plain.length !== PLAIN_SIZE) throw new CfgError('plaintext has the wrong size');
  const out = new Uint8Array(FILE_SIZE);
  const k = keystream(seed, PLAIN_SIZE);
  const enc = new Uint8Array(PLAIN_SIZE);
  for (let i = 0; i < PLAIN_SIZE; i++) enc[i] = plain[i] ^ k[i];
  out.set(enc.subarray(0, 0x4f50), 0);
  out.set(enc.subarray(0x4f50), 0x4f64);
  const dv = new DataView(out.buffer);
  sums(plain).forEach((v, i) => dv.setInt32(0x4f50 + 4 * i, v, true));
  dv.setInt32(0x4f60, seed | 0, true);
  return out;
}

/** The controller configuration of player p (0..3): { slots[10], menu[2], macrosOff[3] }. */
export function getPadConfig(plain, p) {
  const slots = Array.from(plain.subarray(CFG_OFF + 10 * p, CFG_OFF + 10 * p + 10));
  const menu = [plain[MENU_OFF + 2 * p], plain[MENU_OFF + 2 * p + 1]];
  const bits = plain[MACRO_OFF + p];
  return { slots, menu, macrosOff: [0, 1, 2].map((i) => !!(bits & (1 << i))) };
}

/**
 * Assign joystick button `button` to function f of player p, the way the launcher does
 * (FUN 0x444320): every other function that held that button moves to the lowest free slot,
 * so the 10 entries stay distinct (a duplicate would make one keyboard key fire two
 * functions). Returns the functions that moved.
 */
export function assignButton(plain, p, f, button) {
  const base = CFG_OFF + 10 * p;
  plain[base + f] = button;
  const used = new Uint8Array(32);
  used[button] = 1;
  const moved = [];
  for (let g = 0; g < 10; g++) {
    if (g === f) continue;
    if (used[plain[base + g]]) {
      let s = 0;
      while (s < 32 && plain.subarray(base, base + 10).includes(s)) s++;
      if (s < 32) { plain[base + g] = s; moved.push(g); }
    }
    used[plain[base + g]] = 1;
  }
  syncMenu(plain, p);
  return moved;
}

/** Copy A and B into the menu confirm/cancel pair, as the launcher's OK button does. */
export function syncMenu(plain, p) {
  plain[MENU_OFF + 2 * p] = plain[CFG_OFF + 10 * p];
  plain[MENU_OFF + 2 * p + 1] = plain[CFG_OFF + 10 * p + 1];
}

/** The launcher's "Controller defaults": identity for every player (FUN_004443b0(-1)). */
export function resetPadConfig(plain, p) {
  for (let f = 0; f < 10; f++) plain[CFG_OFF + 10 * p + f] = f;
  syncMenu(plain, p);
}

export function setMacroOff(plain, p, i, off) {
  const b = plain[MACRO_OFF + p];
  plain[MACRO_OFF + p] = off ? b | (1 << i) : b & ~(1 << i);
}

/** The 10 + 2 bytes the running game holds for player p, for a live update. */
export function livePadBytes(plain, p) {
  return {
    slots: Array.from(plain.subarray(CFG_OFF + 10 * p, CFG_OFF + 10 * p + 10)),
    menu: [plain[MENU_OFF + 2 * p], plain[MENU_OFF + 2 * p + 1]],
    macros: plain[MACRO_OFF + p],
  };
}
