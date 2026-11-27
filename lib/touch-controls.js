// Fighting-game multi-touch controls for phones and touch devices.
//
// Input path (zero WASM rebuild): each Player 1 / Pause action has a key of its own (touchKeys),
// one that neither the game nor the player's keyboard bindings use, and a touch dispatches
// KeyboardEvents for it on window, which runtime/host_web.c writes straight into WASM linear
// memory (HEAPU8[keys + k]). The game page binds those keys to the actions in the controls text
// it hands the runtime (touchRuntimeText, lib/controls-host.js). So the touch buttons do not
// depend on the keyboard bindings: they used to press each action's first keyboard key, and an
// action whose key had been cleared in Controls left its touch button dead.
//
// Ergonomics:
//   - Left thumb: single PointerEvent capture surface supporting continuous sliding across
//     all 8 directions (quarter-circles, half-circles, back-to-block) in either Fixed
//     Arcade D-Pad mode or Floating Virtual Stick mode.
//   - Right thumb: multi-touch hit-tested arcade cluster using Melty Blood's color-coded
//     .mb-btn jewel palette (A/B/C/D) plus optional macro strip (A+B Dash, A+D, A+B+C),
//     allowing both thumb slides (A -> B -> C) and multi-finger chords.
//   - Physical Bluetooth controllers (Gamepad API) automatically hide the touch overlay
//     in 'auto' visibility mode while remaining manually toggleable from the Menu drawer.

import { STORAGE_KEY as CONTROLS_KEY, load as loadControls, DIK, RESERVED, GAME_KEYS, PAGE_DEFAULT_KEYS, GAME_OTHER_KEYS, PAGE_PAUSE } from './controls-model.js';

// ---- The touch buttons' own keys
export const TOUCH_ACTIONS = Object.freeze(['P1.UP', 'P1.DOWN', 'P1.LEFT', 'P1.RIGHT', 'P1.A', 'P1.B', 'P1.C', 'P1.D', 'P1.AD', 'P1.AB', 'P1.ABC', 'PAUSE']);
// keys a phone has no use for come first; any other key of the runtime's table follows
const TOUCH_KEY_ORDER = ['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete',
  'Numpad7', 'Numpad8', 'Numpad9', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad0',
  'F6', 'F7', 'F8', 'F9', 'F10', 'F1', 'F2', 'F3', 'F4'];
// never a touch key: the game's own keys or port defaults for either player, what the game or the
// page reads for itself (Enter and Backspace: play.js attachExtraKeys), and what the browser keeps
const TOUCH_KEY_NEVER = new Set([...RESERVED, ...Object.keys(GAME_OTHER_KEYS), PAGE_PAUSE, GAME_KEYS.PAUSE,
  ...Object.values(GAME_KEYS[1]), ...Object.values(GAME_KEYS[2]), ...Object.values(PAGE_DEFAULT_KEYS),
  'Enter', 'NumpadEnter', 'Backspace', 'Space', 'Tab', 'AltLeft', 'AltRight']);

/**
 * The key of each touch action, { 'P1.A': 'Home', ... }: the first keys of TOUCH_KEY_ORDER that
 * no keyboard binding in the configuration `c` uses. The same configuration gives the same keys,
 * which is how the touch buttons (here) and the runtime's bindings (touchRuntimeText) agree.
 */
export function touchKeys(c) {
  const taken = new Set(TOUCH_KEY_NEVER);
  for (const ks of Object.values((c && c.keys) || {})) if (Array.isArray(ks)) for (const k of ks) taken.add(k);
  const free = [...new Set([...TOUCH_KEY_ORDER, ...Object.keys(DIK)])].filter((k) => DIK[k] !== undefined && !taken.has(k));
  const out = {};
  TOUCH_ACTIONS.forEach((action, i) => { if (free[i]) out[action] = free[i]; });
  return out;
}

/**
 * Lines for the runtime's controls text (hle_input.c config_parse; added to pageRuntimeText by
 * lib/controls-host.js) that bind the touch keys to their actions. An action's first binding
 * takes the game's own key away from it, so an action the player never changed gets that key
 * back in a line of its own, unless the player gave that key to another action.
 */
export function touchRuntimeText(c) {
  const hex = (code) => `0x${DIK[code].toString(16).padStart(2, '0')}`;
  const userKeys = new Set(Object.values(c.keys).flatMap((ks) => (Array.isArray(ks) ? ks : [])));
  const lines = ['# touch buttons: keys of their own (web-bundle/lib/touch-controls.js)'];
  for (const [action, code] of Object.entries(touchKeys(c))) {
    if (action !== 'PAUSE' && !Object.prototype.hasOwnProperty.call(c.keys, action)
      && !Object.prototype.hasOwnProperty.call(PAGE_DEFAULT_KEYS, action)) {
      const [p, a] = action.split('.');
      const own = GAME_KEYS[p.slice(1)][a];
      if (!userKeys.has(own)) lines.push(`key ${action} ${hex(own)}   # ${own}: the game's key, kept`);
    }
    lines.push(`key ${action} ${hex(code)}   # ${code}: touch`);
  }
  return lines.join('\n') + '\n';
}

export const TOUCH_STORAGE_KEY = 'mbr.touch.v1';

export const TOUCH_DEFAULTS = Object.freeze({
  mode: 'dpad',       // 'dpad' (fixed sliding 8-way pad) | 'stick' (floating stick)
  macros: 'all',      // 'all' (A+B, A+D, A+B+C) | 'dash' (A+B only) | 'none'
  scale: 1,           // 0.85 .. 1.25
  opacity: 0.9,       // 0.45 .. 1.0
  haptics: true,      // light vibration pulse where supported (Android)
  visibility: 'auto', // 'auto' | 'on' | 'off'
});

const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

export function loadTouchPrefs(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(TOUCH_STORAGE_KEY) || 'null'); } catch { raw = null; }
  const d = TOUCH_DEFAULTS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    mode: raw.mode === 'stick' ? 'stick' : 'dpad',
    macros: ['all', 'dash', 'none'].includes(raw.macros) ? raw.macros : d.macros,
    scale: clamp(Number(raw.scale), 0.85, 1.25, d.scale),
    opacity: clamp(Number(raw.opacity), 0.45, 1, d.opacity),
    haptics: typeof raw.haptics === 'boolean' ? raw.haptics : d.haptics,
    visibility: ['auto', 'on', 'off'].includes(raw.visibility) ? raw.visibility : d.visibility,
  };
}

export function saveTouchPrefs(p, storage = globalThis.localStorage) {
  try { storage.setItem(TOUCH_STORAGE_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

/**
 * Cross-browser touch-device layout detection (phones and tablets, any size; does NOT use
 * Chrome-only navigator.deviceMemory). Unattended runs (?run=) always stay on desktop layout.
 */
export function isPhoneLike(vw = window.innerWidth, vh = window.innerHeight, params = new URLSearchParams(location.search)) {
  if (params.get('run')) return false;
  if (params.get('touch') === '1') return true;
  if (params.get('touch') === '0') return false;
  const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const coarse = mm('(pointer: coarse)');
  const noHover = mm('(hover: none)');
  const hasTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  return coarse || (noHover && hasTouch);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function makeArrow(deg) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', 'mb-arr');
  s.setAttribute('aria-hidden', 'true');
  if (deg) s.style.setProperty('--r', `${deg}deg`);
  const u = document.createElementNS(SVG_NS, 'use');
  u.setAttribute('href', '#mb-arr');
  s.append(u);
  return s;
}

// 8 sectors from Math.round(atan2(dy, dx) / (PI/4)), normalized to 0..7
// 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
const SECTOR_DIRS = [
  ['RIGHT'],
  ['DOWN', 'RIGHT'],
  ['DOWN'],
  ['DOWN', 'LEFT'],
  ['LEFT'],
  ['UP', 'LEFT'],
  ['UP'],
  ['UP', 'RIGHT'],
];

const DIR_ACTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/**
 * Mount the multi-touch fighting-game controller into `#touch-layer` (created if absent)
 * and wire it to the game's key bridge and Menu drawer preferences.
 */
export function attachTouchControls({ onPress = null } = {}) {
  let prefs = loadTouchPrefs();
  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const pulse = (ms = 8) => {
    if (prefs.haptics && canVibrate) {
      try { navigator.vibrate(ms); } catch { /* ignore */ }
    }
  };

  // ---- Key dispatch bridge (reference-counted per KeyboardEvent.code)
  const codeRefs = new Map();       // code -> ref count
  const sourceCodes = new Map();    // sourceId (e.g. 'dir:UP', 'ptr:3') -> code
  // the action's touch key; worked out again only when the stored controls change
  let keysFor = null, keysRaw;
  const resolveCode = (action) => {
    try {
      const raw = globalThis.localStorage.getItem(CONTROLS_KEY);
      if (!keysFor || raw !== keysRaw) { keysFor = touchKeys(loadControls()); keysRaw = raw; }
    } catch { if (!keysFor) keysFor = touchKeys(null); }
    return keysFor[action] || null;
  };
  const sendKey = (code, down) => {
    if (!code) return;
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true }));
  };
  const setSource = (sourceId, action, timeStamp) => {
    const prevCode = sourceCodes.get(sourceId) || null;
    const nextCode = action ? resolveCode(action) : null;
    if (prevCode === nextCode) return false;
    if (prevCode) {
      sourceCodes.delete(sourceId);
      const n = (codeRefs.get(prevCode) || 1) - 1;
      if (n <= 0) { codeRefs.delete(prevCode); sendKey(prevCode, false); }
      else codeRefs.set(prevCode, n);
    }
    if (nextCode) {
      sourceCodes.set(sourceId, nextCode);
      const prev = codeRefs.get(nextCode) || 0;
      codeRefs.set(nextCode, prev + 1);
      if (prev === 0) {
        sendKey(nextCode, true);
        if (onPress && Number.isFinite(timeStamp)) onPress(timeStamp);
      }
    }
    return true;
  };

  // ---- DOM structure inside #touch-layer
  let root = document.getElementById('touch-layer');
  if (!root) {
    root = document.createElement('div');
    root.id = 'touch-layer';
    root.setAttribute('aria-label', 'Touch controls');
    document.body.append(root);
  }
  root.replaceChildren();

  // Left thumb zone: fixed 8-way sliding D-pad + floating stick visuals
  const leftZone = document.createElement('div');
  leftZone.className = 'tc-zone tc-left';

  const dpad = document.createElement('div');
  dpad.className = 'tc-dpad';
  dpad.setAttribute('role', 'group');
  dpad.setAttribute('aria-label', 'Directional pad');
  const dpadRing = document.createElement('div');
  dpadRing.className = 'tc-dpad-ring';
  const dirEls = {};
  for (const [id, deg] of [['UP', -90], ['DOWN', 90], ['LEFT', 180], ['RIGHT', 0]]) {
    const arm = document.createElement('span');
    arm.className = `tc-dir tc-dir-${id.toLowerCase()}`;
    arm.append(makeArrow(deg));
    dirEls[id] = arm;
    dpadRing.append(arm);
  }
  for (const cls of ['nw', 'ne', 'sw', 'se']) {
    const pip = document.createElement('span');
    pip.className = `tc-diag tc-diag-${cls}`;
    dpadRing.append(pip);
  }
  const dpadNub = document.createElement('span');
  dpadNub.className = 'tc-dpad-nub';
  dpadRing.append(dpadNub);
  dpad.append(dpadRing);

  const stickBase = document.createElement('div');
  stickBase.className = 'tc-stick-base';
  const stickKnob = document.createElement('div');
  stickKnob.className = 'tc-stick-knob';
  stickBase.append(stickKnob);

  leftZone.append(dpad, stickBase);

  // Right thumb zone: macro strip + staggered 2x2 Melty Blood jewel arc
  const rightZone = document.createElement('div');
  rightZone.className = 'tc-zone tc-right';

  const cluster = document.createElement('div');
  cluster.className = 'tc-cluster';

  const macroRow = document.createElement('div');
  macroRow.className = 'tc-macros';
  const macroDefs = [
    { action: 'P1.AB', cls: 'ab', letters: ['A', 'B'], sub: 'Dash', group: 'dash' },
    { action: 'P1.AD', cls: 'ad', letters: ['A', 'D'], sub: '', group: 'extra' },
    { action: 'P1.ABC', cls: 'abc', letters: ['A', 'B', 'C'], sub: '', group: 'extra' },
  ];
  const padButtons = []; // { el, action, kind }
  for (const m of macroDefs) {
    const btn = document.createElement('div');
    btn.className = `tc-macro tc-macro-${m.cls}`;
    btn.dataset.action = m.action;
    btn.dataset.group = m.group;
    btn.setAttribute('role', 'button');
    const textLabel = m.letters.join('+');
    btn.setAttribute('aria-label', m.sub ? `${textLabel} ${m.sub}` : textLabel);
    const combo = document.createElement('span');
    combo.className = 'mb-combo';
    combo.setAttribute('aria-hidden', 'true');
    m.letters.forEach((ch, idx) => {
      if (idx) {
        const plus = document.createElement('span');
        plus.className = 'mb-plus';
        plus.textContent = '+';
        combo.append(plus);
      }
      const b = document.createElement('span');
      b.className = `mb-btn ${ch.toLowerCase()}`;
      b.textContent = ch;
      combo.append(b);
    });
    btn.append(combo);
    if (m.sub) {
      const sub = document.createElement('span');
      sub.className = 'tc-macro-sub';
      sub.textContent = m.sub;
      btn.append(sub);
    }
    macroRow.append(btn);
    padButtons.push({ el: btn, action: m.action, kind: 'macro' });
  }

  const face = document.createElement('div');
  face.className = 'tc-face';
  const faceDefs = [
    { action: 'P1.B', key: 'b', letter: 'B', role: 'mid' },
    { action: 'P1.C', key: 'c', letter: 'C', role: 'strong' },
    { action: 'P1.A', key: 'a', letter: 'A', role: 'weak' },
    { action: 'P1.D', key: 'd', letter: 'D', role: 'shield' },
  ];
  for (const f of faceDefs) {
    const btn = document.createElement('div');
    btn.className = `tc-btn tc-btn-${f.key} mb-btn ${f.key}`;
    btn.dataset.action = f.action;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', `${f.letter} (${f.role})`);
    const span = document.createElement('span');
    span.className = 'tc-btn-letter';
    span.textContent = f.letter;
    btn.append(span);
    face.append(btn);
    padButtons.push({ el: btn, action: f.action, kind: 'face' });
  }

  cluster.append(face, macroRow);
  rightZone.append(cluster);
  root.append(leftZone, rightZone);

  // ---- Left thumb continuous 8-way tracking
  let leftPtr = null;
  let stickOrigin = null; // { x, y, radius }
  let activeSector = -1;

  const setDirs = (dirs, timeStamp) => {
    for (const d of DIR_ACTIONS) {
      const on = dirs.includes(d);
      setSource(`dir:${d}`, on ? `P1.${d}` : null, timeStamp);
      dirEls[d].classList.toggle('active', on);
    }
    const diag = dirs.length === 2 ? (
      (dirs.includes('UP') ? 'n' : 's') + (dirs.includes('LEFT') ? 'w' : 'e')
    ) : '';
    for (const el of dpadRing.querySelectorAll('.tc-diag')) {
      el.classList.toggle('active', !!diag && el.classList.contains(`tc-diag-${diag}`));
    }
  };

  const resetLeftVisuals = () => {
    dpadNub.style.transform = '';
    dpadRing.classList.remove('held');
    stickBase.classList.remove('active');
    stickKnob.style.transform = '';
  };

  const updateLeftPointer = (e) => {
    let cx, cy, radius;
    if (prefs.mode === 'stick' && stickOrigin) {
      ({ x: cx, y: cy, radius } = stickOrigin);
    } else {
      const r = dpadRing.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      radius = Math.max(40, Math.min(r.width, r.height) / 2);
    }
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    const dead = radius * (prefs.mode === 'stick' ? 0.2 : 0.22);
    const maxTravel = radius * (prefs.mode === 'stick' ? 0.62 : 0.66);
    const clamped = dist > 0 ? Math.min(dist, maxTravel) / dist : 0;
    const vx = dx * clamped;
    const vy = dy * clamped;

    if (prefs.mode === 'stick') {
      stickKnob.style.transform = `translate3d(${vx.toFixed(1)}px, ${vy.toFixed(1)}px, 0)`;
    } else {
      dpadNub.style.transform = `translate3d(${vx.toFixed(1)}px, ${vy.toFixed(1)}px, 0)`;
    }

    if (dist < dead) {
      if (activeSector !== -1) { activeSector = -1; setDirs([], e.timeStamp); }
      return;
    }
    const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    if (sector !== activeSector) {
      activeSector = sector;
      setDirs(SECTOR_DIRS[sector], e.timeStamp);
      pulse(6);
    }
  };

  const clearLeft = () => {
    leftPtr = null;
    stickOrigin = null;
    activeSector = -1;
    setDirs([], NaN);
    resetLeftVisuals();
  };

  leftZone.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (leftPtr !== null) return;
    e.preventDefault();
    leftPtr = e.pointerId;
    try { leftZone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (prefs.mode === 'stick') {
      const zr = leftZone.getBoundingClientRect();
      const radius = Math.max(46, Math.min(68, Math.min(zr.width, zr.height) * 0.36));
      const pad = radius + 6;
      const x = Math.min(zr.right - pad, Math.max(zr.left + pad, e.clientX));
      const y = Math.min(zr.bottom - pad, Math.max(zr.top + pad, e.clientY));
      stickOrigin = { x, y, radius };
      stickBase.style.left = `${x - zr.left}px`;
      stickBase.style.top = `${y - zr.top}px`;
      stickBase.classList.add('active');
    } else {
      dpadRing.classList.add('held');
    }
    updateLeftPointer(e);
  });
  leftZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== leftPtr) return;
    e.preventDefault();
    updateLeftPointer(e);
  });
  const endLeft = (e) => {
    if (e.pointerId !== leftPtr) return;
    e.preventDefault();
    clearLeft();
  };
  leftZone.addEventListener('pointerup', endLeft);
  leftZone.addEventListener('pointercancel', endLeft);
  leftZone.addEventListener('lostpointercapture', endLeft);

  // ---- Right thumb multi-touch hit-testing (supports rolls A->B->C and simultaneous chords)
  const rightPtrs = new Map(); // pointerId -> padButton entry | null

  const syncButtonVisuals = () => {
    const activeEls = new Set(rightPtrs.values());
    for (const b of padButtons) b.el.classList.toggle('active', activeEls.has(b));
  };

  const hitTestRight = (clientX, clientY) => {
    let best = null;
    let bestScore = Infinity;
    for (const b of padButtons) {
      if (b.el.offsetParent === null) continue; // hidden macro
      const r = b.el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (b.kind === 'face') {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const rad = Math.max(r.width, r.height) / 2 + 8;
        const d = Math.hypot(clientX - cx, clientY - cy);
        if (d <= rad && d < bestScore) { bestScore = d; best = b; }
      } else {
        const pad = 6;
        if (clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad) {
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const d = Math.hypot(clientX - cx, clientY - cy);
          if (d < bestScore) { bestScore = d; best = b; }
        }
      }
    }
    return best;
  };

  const updateRightPointer = (e, isDown) => {
    const prev = rightPtrs.get(e.pointerId) || null;
    const hit = hitTestRight(e.clientX, e.clientY);
    if (prev === hit) return;
    if (hit) rightPtrs.set(e.pointerId, hit);
    else rightPtrs.delete(e.pointerId);
    const changed = setSource(`ptr:${e.pointerId}`, hit ? hit.action : null, e.timeStamp);
    if (hit && (isDown || changed)) pulse(8);
    syncButtonVisuals();
  };

  const endRight = (e) => {
    if (!rightPtrs.has(e.pointerId) && !sourceCodes.has(`ptr:${e.pointerId}`)) return;
    rightPtrs.delete(e.pointerId);
    setSource(`ptr:${e.pointerId}`, null, e.timeStamp);
    syncButtonVisuals();
  };

  rightZone.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hit = hitTestRight(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    try { rightZone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    updateRightPointer(e, true);
  });
  rightZone.addEventListener('pointermove', (e) => {
    if (!rightPtrs.has(e.pointerId) && !e.buttons) return;
    e.preventDefault();
    updateRightPointer(e, false);
  });
  rightZone.addEventListener('pointerup', (e) => { e.preventDefault(); endRight(e); });
  rightZone.addEventListener('pointercancel', (e) => { e.preventDefault(); endRight(e); });
  rightZone.addEventListener('lostpointercapture', endRight);

  // Prevent accidental context menus or selection inside touch zones
  for (const z of [leftZone, rightZone]) {
    z.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- Bluetooth / physical Gamepad auto-hide
  let hasGamepad = false;
  const checkGamepads = () => {
    let connected = false;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) if (p && p.connected) { connected = true; break; }
    } catch { connected = false; }
    if (connected !== hasGamepad) {
      hasGamepad = connected;
      applyVisualPrefs();
    }
  };
  window.addEventListener('gamepadconnected', checkGamepads);
  window.addEventListener('gamepaddisconnected', checkGamepads);
  // the first check runs below, once applyVisualPrefs and releaseAll exist: with a controller
  // the page can already see, calling it here threw and stopped the game page before it started

  // ---- Apply preferences to DOM / CSS variables
  const listeners = new Set();
  const applyVisualPrefs = () => {
    root.dataset.mode = prefs.mode;
    root.dataset.macros = prefs.macros;
    root.style.setProperty('--tc-scale', String(prefs.scale));
    root.style.setProperty('--tc-opacity', String(prefs.opacity));
    const autoHidden = prefs.visibility === 'auto' && hasGamepad;
    const hidden = prefs.visibility === 'off' || autoHidden;
    root.classList.toggle('tc-hidden', hidden);
    document.body.classList.toggle('tc-overlay-hidden', hidden);
    if (hidden) releaseAll();
    for (const fn of listeners) fn(prefs, { hasGamepad, hidden });
  };

  const releaseAll = () => {
    clearLeft();
    for (const pid of [...rightPtrs.keys()]) {
      rightPtrs.delete(pid);
      setSource(`ptr:${pid}`, null, NaN);
    }
    // Flush any remaining held keys (e.g., Pause pulse)
    for (const id of [...sourceCodes.keys()]) setSource(id, null, NaN);
    syncButtonVisuals();
  };

  // Pause pulse helper: guarantees at least 70 ms (~4 frames) so the game always latches Pause
  let pauseTimer = 0;
  const triggerPause = (timeStamp) => {
    clearTimeout(pauseTimer);
    pulse(10);
    setSource('hud:pause', 'PAUSE', timeStamp);
    pauseTimer = setTimeout(() => {
      pauseTimer = 0;
      setSource('hud:pause', null, NaN);
    }, 75);
  };

  // Release everything whenever focus leaves, tab hides, or an overlay opens
  window.addEventListener('blur', releaseAll);
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') releaseAll(); });

  checkGamepads(); // a controller already visible: the overlay starts hidden ('auto')
  applyVisualPrefs();

  return {
    getPrefs: () => ({ ...prefs }),
    setPrefs(patch) {
      prefs = { ...prefs, ...patch };
      saveTouchPrefs(prefs);
      applyVisualPrefs();
    },
    onChange(fn) {
      listeners.add(fn);
      fn(prefs, { hasGamepad, hidden: root.classList.contains('tc-hidden') });
      return () => listeners.delete(fn);
    },
    hasGamepad: () => hasGamepad,
    canVibrate,
    triggerPause,
    releaseAll,
    root,
  };
}
