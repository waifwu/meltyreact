// The game's own configuration files, read and written exactly as mbr.exe does.
// Layouts and every value below were checked against files the original launcher wrote
// under Wine (recompiler/PROGRESS-settings.md, "File formats").
//
// app.cfg (44 bytes): the eleven dwords at guest 0xa47148..0xa47173, little-endian, plain.
//   +0x00 screen mode    1 full screen, 0 windowed         (launcher radios 1001/1002)
//   +0x04 colour depth   16 or 32                          (launcher radios 1003/1004)
//   +0x08 common graphics          16-bit 0x10000000, 32-bit 0x20000000  (dialog 106)
//   +0x0c battle background 1      16-bit 0x50000000, 32-bit 0x20000000
//   +0x10 battle background 2      16-bit 0x10000000, 32-bit 0x20000000
//   +0x14 (unused, kept as read)
//   +0x18 battle character         16-bit 0x50000000, 32-bit 0x20000000
//   +0x1c battle character effect  16-bit 0x10000000, 32-bit 0x20000000
//   +0x20 battle character effect 2 16-bit 0x10000000, 32-bit 0x20000000
//   +0x24 (only the first-start defaults set it: 0x10000000; kept as read)
//   +0x28 bit 0: "Problem evasion check"
//
// cfg.cfg (406,100 bytes): guest 0x9e2fc0..0xa461ff (0x63240 bytes: options, key map,
// unlocks, records) XORed byte by byte with the low byte of MSVC rand()
// (s = s * 0x343fd + 0x269ec3; (s >> 16) & 0xff) seeded with a stored seed. The file is
// body[0, 0x4f50), five dwords (c0 = -sum, c1 = +sum, c2 = c3 = sum of even-indexed bytes
// minus sum of odd-indexed bytes, all over the plain body, then the seed), body[0x4f50, end).
// The game draws a new seed (a rand() value) at every save, so the same settings give
// different bytes each time; written again with the seed it was read with, a body gives
// the same file byte for byte.
//
// With no app.cfg, or with app.cfg but no cfg.cfg, the game starts from its defaults
// (FUN_004386a0) for both files and overwrites cfg.cfg at its next save: never delete
// app.cfg to reset settings, and write a cfg.cfg along with a first app.cfg.

import { decode, encode, sums, PLAIN_SIZE, FILE_SIZE, GUEST_BASE } from './cfgcfg.js'; // shared with the controls page

export const APP_CFG_SIZE = 44;
export const CFG_BODY = PLAIN_SIZE;
export const CFG_SIZE = FILE_SIZE;
export const CFG_BASE = GUEST_BASE; // guest address of body[0]

export const TEX_32 = 0x20000000;
// The six texture groups of "Detailed configuration": app.cfg offset, the value the
// dialog stores for 16-bit, its radio IDs (16, 32), and its label in the dialog.
export const TEXTURE_GROUPS = Object.freeze([
  { key: 'common', offset: 0x08, v16: 0x10000000, ids: [1040, 1041], label: 'Common graphics' },
  { key: 'bg1', offset: 0x0c, v16: 0x50000000, ids: [1043, 1044], label: 'Battle background 1' },
  { key: 'bg2', offset: 0x10, v16: 0x10000000, ids: [1051, 1052], label: 'Battle background 2' },
  { key: 'character', offset: 0x18, v16: 0x50000000, ids: [1045, 1046], label: 'Battle character' },
  { key: 'effect', offset: 0x1c, v16: 0x10000000, ids: [1047, 1048], label: 'Battle character effect' },
  { key: 'effect2', offset: 0x20, v16: 0x10000000, ids: [1049, 1050], label: 'Battle character effect 2' },
]);

// app.cfg as the game writes it on its first start (FUN_004386a0; the HLE, like the Phase 0
// probe, then answers the launcher with windowed). Checked byte for byte against Wine.
export const FIRST_START_APP_CFG = Object.freeze([
  0, 16, 0x10000000, 0x20000000, 0x20000000, 0, 0x50000000, 0x10000000, 0x10000000, 0x10000000, 0,
]);
// What "Default" in "Detailed configuration" sets (it does not touch +0x24).
export const DIALOG_DEFAULT_TEXTURES = Object.freeze({ common: 32, bg1: 16, bg2: 32, character: 16, effect: 32, effect2: 32 });
// The browser port's first start: the game's, with 32-bit colour and 32-bit textures in all
// six groups. The original starts at 16 bits for the video memory of 2004; here 16-bit only
// costs colour levels (the HLE expands every texture to RGBA8, runtime/hle_ddraw.c) and adds
// dithering in the game's full-screen mode. The game page writes it, with a first-start
// cfg.cfg, when neither file exists (unattended runs excepted: their frames are compared with
// the original's first start); the settings page shows it then and Reset writes it.
export const PORT_START = Object.freeze({
  colorDepth: 32,
  textures: Object.freeze({ common: 32, bg1: 32, bg2: 32, character: 32, effect: 32, effect2: 32 }),
});
/** app.cfg of the port's first start (PORT_START; windowed). */
export function portStartAppCfg() { return buildAppCfg(PORT_START); }
export const GAME_SPEED_DEFAULT = 60;

const u32 = (v) => v >>> 0;

/** Parse app.cfg. Unknown values are kept (`raw`) and written back unchanged. */
export function parseAppCfg(bytes) {
  if (!bytes || bytes.length < APP_CFG_SIZE) throw new Error(`app.cfg must be ${APP_CFG_SIZE} bytes (got ${bytes ? bytes.length : 0})`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, APP_CFG_SIZE);
  const raw = Array.from({ length: 11 }, (_, i) => dv.getUint32(i * 4, true));
  const textures = {};
  for (const g of TEXTURE_GROUPS) {
    const v = raw[g.offset / 4];
    textures[g.key] = v === TEX_32 ? 32 : v === g.v16 ? 16 : null; // null: a value the dialog never writes
  }
  return {
    raw,
    // the launcher reads "full screen" as any non-zero value
    screenMode: raw[0] !== 0 ? 'fullscreen' : 'windowed',
    colorDepth: raw[1] === 32 ? 32 : raw[1] === 16 ? 16 : null,
    textures,
    evasion: (raw[10] & 1) === 1,
  };
}

/** Build app.cfg from settings, starting from `base` (raw dwords) so other bits survive. */
export function buildAppCfg(s, base = FIRST_START_APP_CFG) {
  const raw = base.slice();
  if (s.screenMode) raw[0] = s.screenMode === 'fullscreen' ? 1 : 0;
  if (s.colorDepth === 16 || s.colorDepth === 32) raw[1] = s.colorDepth;
  for (const g of TEXTURE_GROUPS) {
    const d = s.textures && s.textures[g.key];
    if (d === 16) raw[g.offset / 4] = g.v16;
    else if (d === 32) raw[g.offset / 4] = TEX_32;
  }
  if (typeof s.evasion === 'boolean') raw[10] = s.evasion ? u32(raw[10] | 1) : u32(raw[10] & ~1);
  const out = new Uint8Array(APP_CFG_SIZE);
  const dv = new DataView(out.buffer);
  raw.forEach((v, i) => dv.setUint32(i * 4, u32(v), true));
  return out;
}

// ------------------------------------------------------------ cfg.cfg
// The codec is lib/cfgcfg.js (written for the controls page, same algorithm); these wrappers
// give unsigned values.

/** The four checksums the game stores, over a plain body. */
export function cfgChecksums(plain) { return sums(plain).map((v) => v >>> 0); }

/** Decrypt cfg.cfg. Returns { plain (Uint8Array, 0x63240 bytes), seed, stored, ok }. */
export function decodeCfgCfg(bytes) {
  const d = decode(bytes);
  return { plain: d.plain, seed: d.seed >>> 0, stored: [...d.stored.map((v) => v >>> 0), d.seed >>> 0], ok: d.ok };
}

/** Encrypt a plain body into cfg.cfg with this seed (the game uses a 15-bit rand() value). */
export function encodeCfgCfg(plain, seed) { return encode(plain, seed); }

const at = (a) => a - CFG_BASE;

/** The plain body the game saves on its first start (FUN_004386a0, then the launcher). */
export function firstStartCfgBody() {
  const p = new Uint8Array(CFG_BODY);
  const dv = new DataView(p.buffer);
  const d = (a, v) => dv.setUint32(at(a), v, true);
  p[at(0x9e31ec)] = 1;
  p[at(0x9e31ed)] = 0x10;
  d(0xa46188, 2); d(0x9e2fc0, 2); d(0x9e2fc4, 2); d(0xa46178, 2); d(0xa46184, 2);
  d(0x9e3264, GAME_SPEED_DEFAULT);
  for (let a = 0x9e327c; a < 0x9e46cc; a += 0x34) d(a, 0x57e04);
  // key map: FUN_004443b0(-1) and the launcher's normalisation give 0..9 per controller
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 10; k++) p[at(0x9e2fd0) + c * 10 + k] = k;
    p[at(0x9e2ff8) + c * 2] = 0; p[at(0x9e2ff8) + c * 2 + 1] = 1;
  }
  // set by the launcher's WM_INITDIALOG: the display offers 32-bit textures
  p[at(0x9e2fc8)] = 1;
  return p;
}

// The in-game Options menu (FUN_004566a0): shown read-only, changed in the game itself.
export const GAME_OPTIONS = Object.freeze([
  { key: 'difficulty', addr: 0x9e2fc0, label: 'Difficulty', values: ['1 (weak)', '2', '3', '4', '5 (strong)'], def: 2 },
  { key: 'damage', addr: 0xa46188, label: 'Damage', values: ['1 (weak)', '2', '3', '4', '5 (strong)'], def: 2 },
  { key: 'rounds', addr: 0x9e2fc4, label: 'Rounds', values: { 1: '1', 2: '2', 3: '3' }, def: 2 },
  { key: 'bgRendering', addr: 0xa4614c, label: 'BG rendering', values: ['Normal', 'Simple'], def: 0 },
  { key: 'retries', addr: 0xa46178, label: 'Retries (novel part)', values: { 0: '0', 2: '2', 4: '4' }, def: 2 },
  { key: 'messageSpeed', addr: 0xa4617c, label: 'Message speed (novel part)', values: ['Normal', 'Fast', 'Instant'], def: 0 },
  { key: 'bgm', addr: 0xa46184, label: 'BGM volume', volume: true, def: 2 },
  { key: 'se', addr: 0xa46180, label: 'Sound effects volume', volume: true, def: 0 },
]);

/** Read the in-game options and the launcher-related fields from a plain body. */
export function readCfgFields(plain) {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.length);
  const options = {};
  for (const o of GAME_OPTIONS) {
    const v = dv.getInt32(at(o.addr), true);
    // volumes are attenuation steps: 0 loudest, 15 silent (2.5 dB per step)
    const text = o.volume ? (v >= 15 ? 'off' : `${15 - v} of 15`) : (o.values[v] !== undefined ? o.values[v] : `(${v})`);
    options[o.key] = { value: v, text, isDefault: v === o.def };
  }
  return {
    options,
    textures32Supported: plain[at(0x9e2fc8)] === 1,
    gameSpeedLastSaved: dv.getInt32(at(0x9e3264), true),
    controllerInputOffInLauncher: dv.getUint32(at(0xa4618c), true) !== 0,
  };
}

/** A new seed for a file the page creates (the game's own seeds are rand() values). */
export function newSeed() {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] & 0x7fff;
}
