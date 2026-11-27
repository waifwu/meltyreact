// The host side of the controls: what the game cannot configure itself (recompiler/
// PROGRESS-gamepads.md). Shared by the controls page (lib/controls-page.js) and the game page
// (lib/controls-host.js).
//
// Stored in localStorage under STORAGE_KEY as JSON:
//   { version: 1,
//     keys: { 'P1.A': ['KeyQ'], 'PAUSE': ['KeyP'], ... }   absent action: the game's own key;
//                                                         [] : no key at all
//     pads: { 1: { mode: 'auto'|'none'|'id', id }, 2: ... }  which controller is which player
//     deadzone: 0.4, stick: true,                           left stick as the d-pad
//     dirs: { 1: { up: ['b12'], ... } } }                   extra direction sources (non-standard pads)
// The runtime reads it as text (toRuntimeText, the MBR_CONTROLS format of hle_input.c).
//
// The controller *buttons* are not here: which button is A, B, ... is the game's own setting
// in cfg.cfg (lib/cfgcfg.js), as in the original launcher.

export const STORAGE_KEY = 'mbr-controls-v1';
export const CHANNEL = 'mbr-controls';

/** KeyboardEvent.code -> DirectInput scancode, the table in runtime/host_web.c. */
export const DIK = Object.freeze({
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B, Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18,
  KeyP: 0x19, BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C, ControlLeft: 0x1D,
  KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A, Backslash: 0x2B,
  KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, AltLeft: 0x38, Space: 0x39,
  F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D,
  Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x9C, ControlRight: 0x9D, AltRight: 0xB8, Home: 0xC7, ArrowUp: 0xC8, PageUp: 0xC9,
  ArrowLeft: 0xCB, ArrowRight: 0xCD, End: 0xCF, ArrowDown: 0xD0, PageDown: 0xD1, Insert: 0xD2, Delete: 0xD3,
});

/** Keys the browser keeps (runtime/host_web.c lets them through): never bindable. */
export const RESERVED = new Set(['F5', 'F11', 'F12', 'MetaLeft', 'MetaRight']);
/** Keys the game reads for itself outside the player keys (PROGRESS-gamepads.md). */
export const GAME_OTHER_KEYS = Object.freeze({
  ControlLeft: 'Ctrl (read by the game)', ControlRight: 'Ctrl (read by the game)', KeyP: 'P (read by the game)', KeyQ: 'Q (read by the game with Shift)',
  ShiftLeft: 'Shift (read by the game)', ShiftRight: 'Shift (read by the game)', F12: 'F12', Escape: 'Esc (the game window)',
});

export const ACTIONS = Object.freeze([
  { id: 'UP', label: 'Up' }, { id: 'DOWN', label: 'Down' }, { id: 'LEFT', label: 'Left' }, { id: 'RIGHT', label: 'Right' },
  { id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'C', label: 'C' }, { id: 'D', label: 'D' },
  { id: 'AD', label: 'A+D' }, { id: 'AB', label: 'A+B' }, { id: 'ABC', label: 'A+B+C' },
]);
/** The game's own keys (table 0x47c27c), by KeyboardEvent.code. */
export const GAME_KEYS = Object.freeze({
  1: { UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', A: 'KeyN', B: 'KeyM', C: 'Comma', D: 'Period', AD: 'KeyJ', AB: 'KeyK', ABC: 'KeyL' },
  2: { UP: 'KeyT', DOWN: 'KeyG', LEFT: 'KeyF', RIGHT: 'KeyH', A: 'KeyZ', B: 'KeyX', C: 'KeyC', D: 'KeyV', AD: 'KeyA', AB: 'KeyS', ABC: 'KeyD' },
  PAUSE: 'F5',
});

/**
 * Esc on the game page. The game reads Esc in one place, its main loop (0x446206), and quits at
 * once on it, mid-fight included: in a browser tab that throws the session away (the page then
 * reports the game's ExitProcess(1)). The game's own Pause key, F5, stays with the browser. So
 * on the game page Esc is Pause's default key, and when no action has it, it pauses whatever
 * Pause is bound to (pageRuntimeText). The text for the native build is unchanged: natively
 * Esc still quits, as in the original.
 */
export const PAGE_PAUSE = 'Escape';

/**
 * Browser-port default key overrides over GAME_KEYS:
 * - Player 1 moves with WASD instead of the arrow keys.
 * - Player 2's macros (originally A, S, D) move to 1, 2, 3 so they do not collide with WASD.
 * - Esc is Pause (PAGE_PAUSE) on the game page.
 */
export const PAGE_DEFAULT_KEYS = Object.freeze({
  'P1.UP': 'KeyW',
  'P1.DOWN': 'KeyS',
  'P1.LEFT': 'KeyA',
  'P1.RIGHT': 'KeyD',
  'P2.AD': 'Digit1',
  'P2.AB': 'Digit2',
  'P2.ABC': 'Digit3',
  PAUSE: PAGE_PAUSE,
});

export function defaultKeyOf(action) {
  if (Object.prototype.hasOwnProperty.call(PAGE_DEFAULT_KEYS, action)) return PAGE_DEFAULT_KEYS[action];
  const [p, a] = action.split('.');
  return GAME_KEYS[p.slice(1)][a];
}

export function defaults() {
  return { version: 1, keys: {}, pads: { 1: { mode: 'auto' }, 2: { mode: 'auto' } }, deadzone: 0.4, stick: true, dirs: {} };
}

export function load(storage = globalThis.localStorage) {
  let c = null;
  try { c = JSON.parse(storage.getItem(STORAGE_KEY) || 'null'); } catch { c = null; }
  const d = defaults();
  if (!c || c.version !== 1) return d;
  return {
    ...d, ...c,
    keys: { ...(c.keys || {}) },
    pads: { 1: { ...d.pads[1], ...(c.pads && c.pads[1]) }, 2: { ...d.pads[2], ...(c.pads && c.pads[2]) } },
    dirs: { ...(c.dirs || {}) },
  };
}

export function save(c, storage = globalThis.localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(c));
}

/** The keys bound to an action ('P1.A', 'PAUSE'): the user's list, or the default key. */
export function keysOf(c, action) {
  if (Object.prototype.hasOwnProperty.call(c.keys, action)) return c.keys[action];
  return [defaultKeyOf(action)];
}

export function allActions() {
  const out = [];
  for (const p of [1, 2]) for (const a of ACTIONS) out.push({ action: `P${p}.${a.id}`, player: p, label: a.label });
  out.push({ action: 'PAUSE', player: 0, label: 'Pause' });
  return out;
}

/**
 * Problems with a configuration: [{ level: 'error'|'warn', text, actions: [...] }].
 * A key on two actions only fires one of them; an action without a key cannot be used.
 */
export function conflicts(c) {
  const out = [];
  const byKey = new Map();
  for (const { action } of allActions()) {
    const ks = keysOf(c, action);
    if (!ks.length) out.push({ level: 'warn', text: `${action} has no key`, actions: [action] });
    for (const k of ks) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(action);
    }
  }
  for (const [k, acts] of byKey) {
    if (acts.length > 1) out.push({ level: 'error', text: `${keyLabel(k)} is bound to ${acts.join(' and ')}: only one of them will work`, actions: acts });
    if (RESERVED.has(k)) out.push({ level: 'error', text: `${keyLabel(k)} is kept by the browser and never reaches the game`, actions: acts });
  }
  if (c.pads[1].mode === 'id' && c.pads[2].mode === 'id' && c.pads[1].id && c.pads[1].id === c.pads[2].id) {
    out.push({ level: 'warn', text: 'Both players are set to the same controller: the second one of that kind goes to player 2', actions: [] });
  }
  return out;
}

export function keyLabel(code) {
  if (!code) return '—';
  const m = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  const names = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt', Escape: 'Esc' };
  if (names[code]) return names[code];
  return code.replace(/^Numpad/, 'Num ');
}

/** The runtime's text format (hle_input.c config_parse). */
export function toRuntimeText(c) {
  const lines = ['# MELTY BLOOD ReACT port: controls (web/lib/controls-model.js)'];
  for (const { action } of allActions()) {
    const hasOwn = Object.prototype.hasOwnProperty.call(c.keys, action);
    if (action === 'PAUSE') {
      if (!hasOwn) continue;
    } else if (!hasOwn && !Object.prototype.hasOwnProperty.call(PAGE_DEFAULT_KEYS, action)) {
      continue;
    }
    const raw = hasOwn ? c.keys[action] : [PAGE_DEFAULT_KEYS[action]];
    const ks = raw.filter((k) => DIK[k] !== undefined && !RESERVED.has(k));
    if (!ks.length) lines.push(`key ${action} none`);
    for (const k of ks) lines.push(`key ${action} 0x${DIK[k].toString(16).padStart(2, '0')}   # ${k}`);
  }
  for (const p of [1, 2]) {
    const pc = c.pads[p] || { mode: 'auto' };
    lines.push(pc.mode === 'id' && pc.id ? `pad ${p} id ${pc.id}` : `pad ${p} ${pc.mode === 'none' ? 'none' : 'auto'}`);
    const dirs = c.dirs[p] || {};
    for (const d of ['up', 'down', 'left', 'right']) for (const s of (dirs[d] || []).slice(0, 2)) lines.push(`dir ${p} ${d} ${s}`);
  }
  lines.push(`deadzone ${Number(c.deadzone ?? 0.4).toFixed(2)}`);
  lines.push(`stick ${c.stick === false ? 'off' : 'on'}`);
  return lines.join('\n') + '\n';
}

/** The text for the runtime on the game page: toRuntimeText, and Esc on Pause unless an action has Esc (PAGE_PAUSE). */
export function pageRuntimeText(c) {
  const text = toRuntimeText(c);
  const taken = Object.values(c.keys).some((ks) => Array.isArray(ks) && ks.includes(PAGE_PAUSE));
  if (taken) return text;
  return `${text}key PAUSE 0x${DIK[PAGE_PAUSE].toString(16).padStart(2, '0')}   # ${PAGE_PAUSE}: pauses on the game page (the game's own Esc quits it)\n`;
}
