// The game page: mounts the imported files, loads the locally built wasm and runs it.
//
// The wasm (recompiler/out/web/mbr-<mode>.mjs + .wasm) is built on this machine from the
// user's own mbr.exe and is never part of the repository; the static server maps it to
// ./build/. This page is only the host: canvas, keyboard, files, and the run report.
//
// Stored settings from the settings page apply where no URL parameter says otherwise
// (lib/settings-store.js), except in unattended runs.
//
// URL parameters:
//   mode=jspi|asyncify   which build to load (default: jspi when the browser has it)
//   build=NAME           load build/NAME.mjs instead (experiment builds)
//   scale=N|fit          canvas size: N x 640x480, or as large as the window allows (default fit)
//   scaling=sharp|pixels|smooth|upscale  how the picture is enlarged (lib/settings-store.js SCALINGS;
//                        default upscale, pixels in unattended runs); smooth=1 is scaling=smooth
//   run=URL              a run configuration (JSON) for unattended runs, see recompiler/tools/webrun.mjs;
//                        it has to be a file of this site (main: it can empty or replace the saves)
//   sound=0|1            sound off or on (default: on when the game runs in real time, which is
//                        always the case here except in unattended runs; MBR_SOUND)
//   mute=1               sound runs, but through a gain of 0 (measurements without speakers)
//   audioLatency=MS      how far the audio device plays behind the game's mix (default 40)
//   slice=0              no time slices for the game's loader threads, and nothing of theirs waits
//                        in the background (MBR_THREAD_SLICE, recompiler/runtime/hle_thread.c): the
//                        loading screen then stands still while a battle loads, as it used to
//   integer=1            scale by whole multiples only; fullscreen=off, escape=browser: see lib/fullscreen.js
//
// A run configuration is { env, files, seed, resetUser, report, collect }:
//   env        MBR_* variables for the runtime (recompiler/README.md)
//   files      { "/in/script.txt": "text" } written to the in-memory file system first
//   seed       [{ path: "C:\\...\\cfg.cfg", url }] fetched and written to the user area
//   resetUser  true: empty the user area first (a fresh "overlay")
//   report     URL prefix; every output file and a summary are POSTed there
//   persist    false: do not write the user area back to OPFS when the run ends
//   keys       [{ frame, code, down }] KeyboardEvents dispatched at those frames (tests the
//              real keyboard path; scripts in env.MBR_INPUT bypass it)
//   pads       [{ frame, pads: [...] }] Gamepad API states to inject; controls: MBR_CONTROLS text
//              (lib/controls-host.js)
//   audio      { autostart, mute, latency }: start the sound without a gesture (only where the
//              browser allows autoplay), muted, with this latency in ms

import { mountGameFs } from './lib/vfs.js';
import { pageSettings, holdGameLock } from './lib/settings-store.js';
import { hasJspi, installJspi, instantiateBuild } from './lib/jspi.js';
import { runPrefetch } from './lib/prefetch.js';
import { createLoadingScreen } from './lib/loading-screen.js';
import { createAudioOutput } from './lib/audio.js';
import { attachControls } from './lib/controls-host.js';
import { createPause } from './lib/pause.js';
import { setupFullscreen, fullscreenAvailable } from './lib/fullscreen.js';
import { attachTouchControls, isPhoneLike } from './lib/touch-controls.js';
import { portStartAppCfg, encodeCfgCfg, firstStartCfgBody, newSeed } from './lib/gamecfg.js';
import { load as loadControls, keysOf, keyLabel, DIK, PAGE_PAUSE, CHANNEL as CONTROLS_CHANNEL, STORAGE_KEY as CONTROLS_KEY } from './lib/controls-model.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const prefs = pageSettings(params); // settings page + URL parameters (settings.html)

// The game folder as the game sees it. The same strings as in the native build, so that
// paths the game keeps in memory are identical in both.
export const GUEST_DIR = 'C:\\Games\\MeltyBloodReACT';
export const BASE_DIR = 'C:\\Games\\MeltyBlood';
const MOUNTS = [{ path: GUEST_DIR, dir: 'ReACT' }, { path: BASE_DIR, dir: 'MeltyBlood' }];

function show(kind, html) {
  const m = $('message');
  m.className = `banner ${kind}`;
  delete m.dataset.about;
  m.innerHTML = html;
  m.hidden = false;
}
function status(text) {
  const el = $('status');
  el.textContent = text;
  const info = $('info'), lbl = $('status-lbl');
  const isFps = /\bfps\b/.test(text);
  const state = isFps ? 'live' : /error/i.test(text) ? 'err' : /^(Stopped|Game closed)/.test(text) ? 'stop' : 'load';
  el.classList.toggle('idle', !isFps);
  if (lbl) lbl.textContent = isFps ? 'Frame rate' : 'Status';
  if (info) info.dataset.state = state;
  const mobFps = $('mob-fps'), mobSt = $('mob-status'), mdSt = $('md-status');
  if (mobFps) mobFps.dataset.state = state;
  if (mobSt) {
    // the unit in an element of its own: the bar leaves it out where its strip is narrow (play.html)
    const m = isFps && /^(\S+)( fps)$/.exec(text);
    if (m) {
      const unit = document.createElement('span');
      unit.className = 'mhud-unit';
      unit.textContent = m[2];
      mobSt.replaceChildren(m[1], unit);
    } else mobSt.textContent = text;
  }
  if (mdSt) mdSt.textContent = text;
  console.log(`[play] ${text}`);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------ saves that are not being kept
// The game's own files (progress, settings, replays) are kept in the browser's private storage
// (OPFS, lib/vfs.js). The game runs without it too, from memory, and until the page said so the
// player found out when everything was gone at the next visit. lib/vfs.js reports it (onWarning):
//   unavailable   no storage at all (a private window, or a page that is neither https nor
//                 localhost): said once, when the page starts;
//   flush-failed  a write failed (no space left, a lock): said at the first failure, and taken
//                 back when a later write works (flush-ok). lib/vfs.js keeps trying by itself.
// The notice goes where the page's messages go and can be dismissed; an error report stays.
const STORAGE_NOTICES = {
  unavailable: 'This window gives the game no storage, so progress, settings and replays last only until the page is closed or reloaded. A normal (not private) window, opened from https or from localhost, keeps them.',
  'flush-failed': 'Your progress could not be written to this browser\u2019s storage. The game keeps trying; if this stays, the device may be out of free space.',
};

function storageNotices() {
  let failing = false; // one notice for a run of failed writes, however many retries
  const hide = () => {
    const m = $('message');
    if (m.dataset.about !== 'storage') return;
    delete m.dataset.about;
    m.hidden = true;
    m.replaceChildren();
  };
  const notice = (text) => {
    const m = $('message');
    if (!m.hidden && m.classList.contains('error')) return; // an error report is not replaced
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'secondary';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { hide(); $('canvas').focus({ preventScroll: true }); });
    m.className = 'banner warn';
    m.dataset.about = 'storage';
    m.replaceChildren(text, ' ', dismiss);
    m.hidden = false;
  };
  return (kind, detail) => {
    if (kind === 'flush-ok') { failing = false; hide(); return; }
    console.warn(`[play] storage: ${detail}`);
    if (kind === 'flush-failed') { if (failing) return; failing = true; }
    if (STORAGE_NOTICES[kind]) notice(STORAGE_NOTICES[kind]);
  };
}

// Ask the browser to keep this site's storage when it makes room: without that the saves are
// "best effort" data, which a browser may clear by itself. Asked once the player has pressed or
// clicked something (Chromium decides by itself; Firefox asks the player), and not again once
// it is granted.
function keepStorage() {
  const sm = navigator.storage;
  if (!sm || typeof sm.persist !== 'function') return;
  const ask = () => {
    window.removeEventListener('pointerdown', ask, true);
    window.removeEventListener('keydown', ask, true);
    // every rejection ends here: an unhandled one would be taken for the game's (main, `thrown`)
    Promise.resolve()
      .then(() => (typeof sm.persisted === 'function' ? sm.persisted() : false))
      .then((kept) => kept || sm.persist())
      .then((kept) => console.log(`[play] persistent storage: ${kept ? 'granted' : 'not granted'}`))
      .catch(() => {});
  };
  window.addEventListener('pointerdown', ask, true);
  window.addEventListener('keydown', ask, true);
}

// ------------------------------------------------------------ the keys in the side strips
// Each player's panel, and the one-line version for narrow windows, show the keys chosen in
// Controls (lib/controls-model.js, kept in localStorage; an action never changed there has the
// game's own key). They are drawn again whenever the Controls page saves a change: it posts on
// CONTROLS_CHANNEL, and the browser reports the storage change to this page.
// [action, label, what the button does (guide.html, from the game's manual)]
const KEY_ROWS = [
  [['UP', '↑'], ['DOWN', '↓'], ['LEFT', '←'], ['RIGHT', '→']],
  [['A', 'A', 'weak'], ['B', 'B', 'mid'], ['C', 'C', 'strong'], ['D', 'D', 'shield']],
  [['AD', 'A+D'], ['AB', 'A+B'], ['ABC', 'A+B+C']],
];
// short keycap text (at most 4 characters, which fit a keycap at the narrowest strip) where
// keyLabel's is longer; the full name is the keycap's tooltip
const SHORT_KEY = { Space: 'Spc', Enter: 'Ent', NumpadEnter: 'NEnt', Backspace: 'BkSp', Escape: 'Esc', PageUp: 'PgUp',
  PageDown: 'PgDn', Insert: 'Ins', Delete: 'Del', ShiftLeft: 'L⇧', ShiftRight: 'R⇧', ControlLeft: 'LCtl',
  ControlRight: 'RCtl', AltLeft: 'LAlt', AltRight: 'RAlt', Backquote: '`', Home: 'Home', End: 'End' };

const SVG_NS = 'http://www.w3.org/2000/svg';
const DIR_DEG = { UP: -90, DOWN: 90, LEFT: 180, RIGHT: 0, ArrowUp: -90, ArrowDown: 90, ArrowLeft: 180, ArrowRight: 0 };
const BTN_COMBO = { AD: ['A', 'D'], AB: ['A', 'B'], ABC: ['A', 'B', 'C'] };

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

function makeButton(letter) {
  const b = document.createElement('span');
  b.className = `mb-btn ${letter.toLowerCase()}`;
  b.textContent = letter;
  return b;
}

function makeActionLabel(id, fallback) {
  const l = document.createElement('span');
  l.className = 'lbl';
  if (Object.hasOwn(DIR_DEG, id)) {
    l.setAttribute('aria-label', id.toLowerCase());
    l.append(makeArrow(DIR_DEG[id]));
  } else if (/^[ABCD]$/.test(id)) {
    l.append(makeButton(id));
  } else if (Object.hasOwn(BTN_COMBO, id)) {
    const g = document.createElement('span');
    g.className = 'mb-combo';
    BTN_COMBO[id].forEach((ch, idx) => {
      if (idx) {
        const p = document.createElement('span');
        p.className = 'mb-plus';
        p.textContent = '+';
        g.append(p);
      }
      g.append(makeButton(ch));
    });
    l.append(g);
  } else {
    l.textContent = fallback;
  }
  return l;
}

function keycap(code) {
  const k = document.createElement('kbd');
  if (!code) { k.textContent = '—'; k.title = 'No key'; k.className = 'none'; return k; }
  if (Object.hasOwn(DIR_DEG, code)) {
    k.title = keyLabel(code);
    k.setAttribute('aria-label', code.replace('Arrow', '') + ' arrow');
    k.append(makeArrow(DIR_DEG[code]));
    return k;
  }
  k.textContent = SHORT_KEY[code] || keyLabel(code).replace(/^Num /, 'Num');
  k.title = keyLabel(code);
  if (k.textContent.length > 2) k.className = 'wide';
  return k;
}

function showKeys() {
  let c;
  try { c = loadControls(); } catch (e) { console.warn('[play] controls', e); return; }
  const keys = (p, id) => keysOf(c, `P${p}.${id}`);
  for (const body of document.querySelectorAll('.keys-body[data-player]')) {
    const p = body.dataset.player;
    body.replaceChildren(...KEY_ROWS.map((row) => {
      const grid = document.createElement('div');
      grid.className = row.length === 3 ? 'keygrid three' : 'keygrid';
      for (const [id, label] of row) grid.append(makeActionLabel(id, label));
      for (const [id] of row) {
        const cell = document.createElement('span');
        cell.className = 'cap';
        const ks = keys(p, id);
        if (!ks.length) cell.append(keycap(null)); else for (const k of ks.slice(0, 2)) cell.append(keycap(k)); // a third key is rare: Controls lists it
        grid.append(cell);
      }
      if (row.some((r) => r[2])) {
        for (const [, , role] of row) {
          const r = document.createElement('span');
          r.className = 'role';
          r.textContent = role || '';
          grid.append(r);
        }
      }
      return grid;
    }));
  }
  // under player 1's keys: what confirms and goes back in the menus (A and B, the game's menu
  // confirm and cancel; lib/cfgcfg.js) and what pauses
  const note = document.querySelector('.keys .note');
  if (note) {
    // rows of keycap and action (play.html lays them out as a two-column grid)
    const rows = [[keys(1, 'A')[0], 'Confirm'], [keys(1, 'B')[0], 'Go back'], [keysOf(c, 'PAUSE')[0], 'Pause']];
    note.replaceChildren();
    for (const [code, what] of rows) {
      if (!code) continue;
      const t = document.createElement('span');
      t.textContent = what;
      if (what === 'Pause') { // Resume while the page holds the game (wireMobileUi pagePause)
        t.id = 'pause-what';
        if (document.body.classList.contains('page-paused')) t.textContent = 'Resume';
      }
      note.append(keycap(code), t);
    }
    if (prefs.mouse) {
      const all = document.createElement('span');
      all.className = 'all';
      all.textContent = 'Mouse: wheel moves, left click A, right click B.';
      note.append(all);
    }
  }
}

function watchKeys() {
  showKeys();
  window.addEventListener('storage', (e) => { if (e.key === CONTROLS_KEY || e.key === null) showKeys(); });
  try {
    const bc = new BroadcastChannel(CONTROLS_CHANNEL);
    bc.addEventListener('message', (e) => { if (e.data && e.data.type === 'config') showKeys(); });
  } catch { /* no BroadcastChannel: the storage event still redraws them */ }
}

// ------------------------------------------------------------ the Basics panel, when it fits
// The left strip holds the title, player 1's keys, Basics and the Information line at its foot
// (play.html). In a short window Basics would push the strip past the bottom and make the page
// scroll, so it is left out there. What counts is the panels' own heights (the strip itself
// always fills the window: Information sits at its foot), measured with Basics shown and hidden
// again in one go, before anything is drawn. Its own height never changes, and what is watched
// is the window and the other panels, so there is no loop.
function fitBasics() {
  const b = document.querySelector('.basics');
  if (!b) return;
  b.classList.remove('off');
  if (document.body.classList.contains('mobile')) return; // touch mode never shows side strips
  const box = b.parentElement;
  const shown = [...box.children].filter((el) => getComputedStyle(el).display !== 'none');
  const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
  const strip = getComputedStyle(box.parentElement);
  const need = shown.reduce((sum, el) => sum + el.offsetHeight, 0) + gap * (shown.length - 1)
    + parseFloat(strip.paddingTop) + parseFloat(strip.paddingBottom);
  b.classList.toggle('off', need > window.innerHeight);
}

function watchBasics() {
  fitBasics();
  window.addEventListener('resize', fitBasics);
  const b = document.querySelector('.basics');
  if (!b || typeof ResizeObserver !== 'function') return;
  let pending = 0;
  const ro = new ResizeObserver(() => {
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; fitBasics(); });
  });
  for (const el of b.parentElement.children) if (el !== b) ro.observe(el);
}

// ------------------------------------------------------------ canvas size
// On touch devices (isPhoneLike: phones & tablets), the touch-control layout fills the viewport.
// Everywhere else, the two strips (title, keys and status on the left; menu and player 2 on the
// right) always stay beside the canvas, squeezing the canvas to fit comfortably between them.
const SIDE_MIN = 190;
function viewportSize() {
  const vv = window.visualViewport;
  return {
    w: Math.round(vv ? vv.width : window.innerWidth),
    h: Math.round(vv ? vv.height : window.innerHeight),
  };
}
function safeInsets() {
  const probe = $('safe-probe');
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}
function layoutCanvas() {
  const canvas = $('canvas');
  const scale = prefs.scale;
  const { w: vw, h: vh } = viewportSize();
  const mobile = isPhoneLike(vw, vh, params);
  document.body.classList.toggle('mobile', mobile);
  if (mobile) {
    const landscape = vw >= vh;
    const safe = safeInsets();
    document.body.classList.toggle('mobile-landscape', landscape);
    document.body.classList.toggle('mobile-portrait', !landscape);
    let w;
    if (landscape) {
      const availH = Math.max(200, vh - Math.round(safe.bottom * 0.75));
      const availW = Math.max(240, vw - safe.left - safe.right);
      w = Math.max(240, Math.floor(Math.min(availW, availH * 4 / 3)));
      const vmin = Math.min(vw, vh);
      const rawGutter = Math.max(0, (vw - w) / 2);
      const padL = Math.max(8, safe.left);
      const padR = Math.max(8, safe.right);
      const gutterL = Math.max(0, Math.floor(rawGutter - padL - 6));
      const gutterR = Math.max(0, Math.floor(rawGutter - padR - 6));
      const dpadPx = Math.min(146, Math.max(120, vmin * 0.34));
      const btnPx = Math.min(58, Math.max(48, vmin * 0.135));
      const clusterPx = Math.max(144, Math.ceil(btnPx * 2 + 24));
      // The pad and the buttons go in the strips beside the picture, scaled to fit them, while
      // that leaves them at least FIT_MIN of their size: a notched phone, whose strips lose the
      // safe area at each end, has them at 0.76 to 0.87 (40-44px buttons). A 16:9 or 18:9
      // phone's strips are too narrow for that (69px each at 667x375, for a 128px pad and a
      // 144px button cluster): scaled to fit, the buttons came out 34px across and still reached
      // over the picture. There they keep their size and lie over the picture's edges instead,
      // more see-through the further in they reach (--tc-dim, on top of the player's Opacity).
      const FIT_MIN = 0.75;
      const fitL = gutterL / dpadPx, fitR = gutterR / clusterPx;
      const over = Math.min(fitL, fitR) < FIT_MIN;
      const overScale = Math.min(1, Math.max(0.88, vh / 360)); // a little smaller on the shortest screens
      const maxL = over ? overScale : fitL;
      const maxR = over ? overScale : fitR;
      // how far the wider of the two reaches into the picture, px
      const reach = over ? Math.max(dpadPx * overScale + padL, clusterPx * overScale + padR) - rawGutter : 0;
      const dim = Math.min(1, Math.max(0.68, 1 - reach / 150));
      // the touch zones are as wide as what they hold, so a touch just beside a button still counts
      const zoneL = Math.max(84, gutterL, over ? Math.ceil(dpadPx * overScale) : 0);
      const zoneR = Math.max(84, gutterR, over ? Math.ceil(clusterPx * overScale) : 0);
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty('--gutter-l', `${zoneL}px`);
      rootStyle.setProperty('--gutter-r', `${zoneR}px`);
      rootStyle.setProperty('--tc-max-l', maxL.toFixed(3));
      rootStyle.setProperty('--tc-max-r', maxR.toFixed(3));
      rootStyle.setProperty('--tc-dim', dim.toFixed(3));
      // the bar's pills stay in the strips: no wider than the strip they are in
      const hudL = Math.max(56, Math.floor(rawGutter - padL - 3)), hudR = Math.max(56, Math.floor(rawGutter - padR - 3));
      rootStyle.setProperty('--hud-max-l', `${hudL}px`);
      rootStyle.setProperty('--hud-max-r', `${hudR}px`);
      document.body.classList.toggle('mobile-hud-narrow', Math.min(hudL, hudR) < 90); // the widest pill is 83px
      document.body.classList.toggle('mobile-tight-gutter', Math.min(gutterL, gutterR) < 146);
    } else {
      document.documentElement.style.removeProperty('--tc-dim');
      document.body.classList.remove('mobile-tight-gutter', 'mobile-hud-narrow');
      const hud = $('mobile-hud');
      const hudH = hud ? hud.offsetHeight : 44;
      const hint = $('mobile-rotate-hint');
      const hintH = hint && !hint.hidden ? hint.offsetHeight : 0;
      const deckMin = Math.min(240, Math.round(vh * 0.34));
      const availH = Math.max(180, vh - hudH - hintH - deckMin);
      w = Math.max(240, Math.floor(Math.min(vw, availH * 4 / 3)));
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${Math.round(w * 3 / 4)}px`;
    canvas.style.imageRendering = prefs.scaling === 'smooth' ? 'auto' : 'pixelated';
    return;
  }
  document.body.classList.remove('mobile-landscape', 'mobile-portrait', 'mobile-tight-gutter', 'mobile-hud-narrow');
  // the window less the stage's padding (8 + 8, 12 + 12)
  const winW = window.innerWidth - 16, winH = window.innerHeight - 24;
  const fit = (availW, availH) => Math.min(availW, availH * 4 / 3);
  const side = Math.max(144, Math.min(SIDE_MIN, Math.floor(winW * 0.24)));
  let w;
  if (scale === 'fit') {
    const msg = $('message'), msgH = msg.hidden ? 0 : msg.offsetHeight + 12;
    w = Math.max(240, Math.floor(fit(Math.max(240, winW - 2 * side), Math.max(180, winH - msgH))));
  } else {
    w = 640 * Math.max(1, Number(scale) || 1);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${Math.round(w * 3 / 4)}px`;
  canvas.style.imageRendering = prefs.scaling === 'smooth' ? 'auto' : 'pixelated';
}

// ------------------------------------------------------------ latency, in the Information line
// Input: a key press is handled while the game waits for the display (host_web.c,
// js_host_frame_wait). The frame boundary after that wait latches it (hle_frame.c: present,
// then hle_input_frame, then the onFrame report, with no turn of the event loop between them),
// and the next frame is the first one drawn from it. So the time from the key event (its
// timeStamp: when the browser received the key) to the next frame's report is the delay from
// the key to its picture leaving the page; the display shows that at its next refresh, which a
// page cannot see. Keyboard only: controllers have no events to time.
// Sound: how far the audio device plays behind the game's mix, so behind the picture: the
// worklet's lag (lib/audio-worklet.js) over the last stats, plus the device's own buffer.
function createLatencyMeter() {
  const waiting = [];   // key times not latched yet
  const latched = [];   // latched at the last frame boundary: drawn by the next frame
  const samples = [];   // the last 8 delays, ms
  const sound = { quanta: 0, lagSum: 0, ms: null };
  return {
    key(e) {
      if (!e.isTrusted || e.repeat || e.metaKey || DIK[e.code] === undefined) return;
      waiting.push(e.timeStamp);
    },
    touch(timeStamp) {
      if (Number.isFinite(timeStamp)) waiting.push(timeStamp);
    },
    frame(presented, t) {
      if (presented) {
        for (const k of latched) {
          if (t - k > 500) continue; // a stall (hidden tab, loading), not a delay
          samples.push(t - k);
          if (samples.length > 8) samples.shift();
        }
      }
      latched.length = 0;
      for (const k of waiting) if (t - k < 500) latched.push(k);
      waiting.length = 0;
    },
    inputMs() { return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null; },
    soundMs(audio) {
      const s = audio && audio.stats, ctx = audio && audio.ctx;
      if (!s || !ctx || audio.state !== 'on') return null;
      if (s.quanta > sound.quanta) {
        // below 0 when the game runs slow and the device has caught up with the mix (it then
        // plays what the runtime mixed ahead): the sound is no later than the device's buffer
        const lag = Math.max(0, (s.lagSum - sound.lagSum) / (s.quanta - sound.quanta));
        sound.ms = (lag + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
      }
      sound.quanta = s.quanta;
      sound.lagSum = s.lagSum;
      return sound.ms;
    },
  };
}

function showLatency(meter, audio) {
  const input = meter.inputMs(), sound = meter.soundMs(audio);
  const inEl = $('lat-input'), sndEl = $('lat-sound');
  const inTxt = input === null ? 'press a key' : `${Math.round(input)} ms`;
  const sndTxt = sound !== null ? `${Math.round(sound)} ms` : audio && audio.state === 'on' ? '…' : 'off';
  inEl.textContent = inTxt;
  inEl.classList.toggle('idle', input === null);
  sndEl.textContent = sndTxt;
  sndEl.classList.toggle('idle', sound === null);
  const mdIn = $('md-lat-input'), mdSnd = $('md-lat-sound');
  if (mdIn) mdIn.textContent = input === null ? '—' : `${Math.round(input)} ms`;
  if (mdSnd) mdSnd.textContent = sndTxt;
}

// ------------------------------------------------------------ the mouse, for the game's menus
// Over the game picture the wheel moves the menu cursor (a tap of ↑ or ↓; ← or → for a sideways
// wheel or swipe) and the buttons press player 1's buttons: left A (confirm), right B (back),
// middle C. They press the keys chosen in Controls (lib/controls-model.js), as KeyboardEvents,
// which the runtime's keyboard handler takes like any others (host_web.c; unattended runs drive
// the game the same way). A click while the picture does not have the focus only gives it the
// focus, so clicking back into the game after using the side panels presses nothing.
const MOUSE_BUTTONS = { 0: 'A', 2: 'B', 1: 'C' };

function attachMouse(canvas) {
  const keyOf = (action) => { try { return keysOf(loadControls(), `P1.${action}`)[0] || null; } catch { return null; } };
  const send = (code, down) => {
    if (code) window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true }));
  };

  // buttons: held as long as the mouse button is (ignore synthetic mouse events from touch taps)
  const held = new Map(); // mouse button -> the key it holds down
  let lastTouchAt = -1e9;
  const markTouch = () => { lastTouchAt = performance.now(); };
  window.addEventListener('touchstart', markTouch, { passive: true, capture: true });
  window.addEventListener('touchend', markTouch, { passive: true, capture: true });
  const isTouchMouse = (e) => (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) || performance.now() - lastTouchAt < 800;
  const release = (button) => {
    const code = held.get(button);
    if (!code) return;
    held.delete(button);
    send(code, false);
  };
  canvas.addEventListener('mousedown', (e) => {
    if (isTouchMouse(e)) return;
    const action = MOUSE_BUTTONS[e.button];
    if (!action) return;
    e.preventDefault(); // no autoscroll on the middle button
    if (document.activeElement !== canvas) { canvas.focus(); return; }
    const code = keyOf(action);
    if (!code || held.has(e.button)) return;
    held.set(e.button, code);
    send(code, true);
  });
  window.addEventListener('mouseup', (e) => { if (!isTouchMouse(e)) release(e.button); });
  window.addEventListener('blur', () => { for (const b of [...held.keys()]) release(b); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // the right button is B

  // the wheel: taps, each held for a few frames and apart from the next, so the game sees every
  // one. A mouse wheel gives one tap per notch; a trackpad one per 60 px of swipe. At most two
  // wait, so a fling does not run the cursor far past what was meant.
  const queue = [];
  const acc = { x: 0, y: 0 };
  let busy = false;
  const pump = () => {
    if (busy || !queue.length) return;
    busy = true;
    const code = keyOf(queue.shift());
    send(code, true);
    setTimeout(() => { send(code, false); setTimeout(() => { busy = false; pump(); }, 60); }, 60);
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (document.activeElement !== canvas) canvas.focus();
    const notch = e.deltaMode !== 0 || (e.wheelDeltaY && e.wheelDeltaY % 120 === 0) || (e.wheelDeltaX && e.wheelDeltaX % 120 === 0);
    for (const [axis, d, back, fwd] of [['y', e.deltaY, 'UP', 'DOWN'], ['x', e.deltaX, 'LEFT', 'RIGHT']]) {
      if (!d) continue;
      const dir = d > 0 ? fwd : back;
      if (notch) { if (queue.length < 2) queue.push(dir); continue; }
      if (Math.sign(d) !== Math.sign(acc[axis])) acc[axis] = 0;
      acc[axis] += d;
      while (Math.abs(acc[axis]) >= 60) {
        acc[axis] -= Math.sign(acc[axis]) * 60;
        if (queue.length < 2) queue.push(dir);
      }
    }
    pump();
  }, { passive: false });
}

// ------------------------------------------------------------ Backspace goes back, Enter confirms
// Backspace presses player 1's B, the game's menu "back" (and B in a fight), and Enter (either
// one) presses player 1's A, its menu "confirm" (and A in a fight), unless Controls has given
// that key to an action of its own: then it is that action's key, as chosen. With Ctrl, Alt or
// Cmd held they are left alone (Alt+Enter is full screen: lib/fullscreen.js).
const EXTRA_KEYS = { Backspace: 'P1.B', Enter: 'P1.A', NumpadEnter: 'P1.A' };

// the key an extra key presses, or null when it presses nothing
function extraKeyPresses(c, code) {
  if (Object.values(c.keys).some((ks) => Array.isArray(ks) && ks.includes(code))) return null;
  const k = keysOf(c, EXTRA_KEYS[code])[0];
  return k && k !== code ? k : null;
}

function attachExtraKeys() {
  const held = new Map(); // extra key -> the key it is holding down
  const send = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true }));
  const release = (code) => { const k = held.get(code); if (k) { held.delete(code); send(k, false); } };
  window.addEventListener('keydown', (e) => {
    if (!Object.hasOwn(EXTRA_KEYS, e.code) || !e.isTrusted || e.ctrlKey || e.altKey || e.metaKey) return;
    let c;
    try { c = loadControls(); } catch { return; }
    const k = extraKeyPresses(c, e.code);
    if (!k) return;
    e.preventDefault();
    if (e.repeat || held.has(e.code)) return;
    held.set(e.code, k);
    send(k, true);
  }, true);
  window.addEventListener('keyup', (e) => { if (e.isTrusted) release(e.code); }, true);
  window.addEventListener('blur', () => { for (const code of [...held.keys()]) release(code); });
}

// ------------------------------------------------------------ Story mode's data, loaded ahead
// Story mode's scenes (backgrounds, event images, its text) come from the original game's
// data02.p (41 MiB). Each new scene otherwise waits for its pieces to arrive from the server
// (4-36 ms a fetch from the local server; the scene-load pauses themselves were measured just as
// long with this on, so most of them are something else). Once the game is running, the whole file is
// read into the block cache (256 MiB) in the background, 2 MiB at a time with a pause between
// pieces. No piece starts while one of the game's own reads waits for the network (isBusy:
// host.readsPending, as lib/prefetch.js does), so those reads have the connection to themselves
// but for at most the one piece already on its way. ?preload=0 leaves it out.
const STORY_DATA = `${BASE_DIR}\\data02.p`;

async function preloadStoryData(fs, isBusy = () => false) {
  if (!fs.cache || !fs.exists(STORY_DATA)) return null;
  const size = fs.size(STORY_DATA), step = 2 << 20, t0 = performance.now();
  let yieldedMs = 0; // time spent standing aside for the game's reads
  for (let at = 0; at < size; at += step) {
    if (isBusy()) {
      const w0 = performance.now();
      while (isBusy()) await new Promise((r) => setTimeout(r, 50));
      yieldedMs += performance.now() - w0;
    }
    await fs.prefetch(STORY_DATA, at, Math.min(step, size - at));
    await new Promise((r) => setTimeout(r, 30));
  }
  return { bytes: size, ms: Math.round(performance.now() - t0), yieldedMs: Math.round(yieldedMs) };
}

// ------------------------------------------------------------ the next screens, loaded ahead
async function loadPrefetchList() {
  const r = await fetch(new URL('./data/prefetch.json', import.meta.url), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`prefetch.json: ${r.status}`);
  return r.json();
}

async function prefetchNextScreens(fs, host, list) {
  if (!fs.cache) return null;
  // entries marked desktop (the start of every stage's music) are left out on a phone
  const phone = document.body.classList.contains('mobile');
  return runPrefetch(fs, list.entries.filter((e) => !(e.desktop && phone)), { mounts: MOUNTS, isBusy: () => host.readsPending > 0 });
}

// ------------------------------------------------------------ music a battle is about to need
// The game maps a music track on its main thread and waits for the start of it (the rest
// arrives behind: recompiler/runtime/hle_kernel32.c), so a track whose first block is not in
// the cache stops the picture for one download. Two of those sit in every battle load: the
// loading jingle, and the stage's music as the battle appears. Both can be seen coming in
// the game's own reads (host.onGameRead, from trackGameReads), so their first block is
// fetched a little ahead, one block each, on phones and with data saver on as well:
//   rules       prefetch.json: when the game reads `after`, fetch `then`
//   stageMusic  prefetch.json and, for stages not in it, what this browser has seen
//               (localStorage): the game reads a stage's data from react/02.p seconds before
//               it maps that stage's music, and a stage always has the same music
const MUSIC_HEAD = 256 << 10; // what the game waits for of a large track (VIEW_HEAD)
const STAGE_FILE = 'react/02.p', MUSIC_FILES = ['react/10.p', 'meltyblood/data00.p'];
const STAGE_MUSIC_KEY = 'mbr.stageMusic.v1';
function musicAhead(fs, host, list) {
  if (!fs.cache) return;
  const rules = list.rules || [], known = { ...(list.stageMusic || {}) };
  try { Object.assign(known, JSON.parse(localStorage.getItem(STAGE_MUSIC_KEY) || '{}')); } catch { /* none kept */ }
  const ahead = (file, offset, length) => {
    const slash = file.indexOf('/');
    const mount = MOUNTS.find((m) => m.dir.toLowerCase() === file.slice(0, slash).toLowerCase());
    const path = mount && `${mount.path}\\${file.slice(slash + 1)}`;
    if (path && fs.exists(path)) { host.musicAhead++; fs.prefetch(path, offset, length).catch(() => {}); }
  };
  let stage = null, stageBase = null, stageAt = -1e9;
  host.musicAhead = 0;
  host.onGameRead = (file, position, n) => {
    for (const r of rules) {
      if (r.after.file === file && r.after.offset === position) for (const [o, l] of r.then.ranges) ahead(r.then.file, o, l);
    }
    const now = performance.now();
    if (file === STAGE_FILE) {
      // a stage's data is read front to back, in pieces on a slow connection: only its first read counts
      const more = stageBase !== null && position >= stageBase && position < stageBase + (32 << 20) && now - stageAt < 60000;
      if (!more) {
        stageBase = position;
        stage = `${file}@${position}`;
        const m = known[stage];
        if (m) ahead(m[0], m[1], MUSIC_HEAD);
      }
      stageAt = now;
    } else if (stage && n === MUSIC_HEAD && MUSIC_FILES.includes(file) && now - stageAt < 120000) {
      // the first large track mapped after a stage's data: that stage's music
      const m = known[stage];
      if (!m || m[0] !== file || m[1] !== position) {
        known[stage] = [file, position];
        try {
          const kept = JSON.parse(localStorage.getItem(STAGE_MUSIC_KEY) || '{}');
          kept[stage] = [file, position];
          localStorage.setItem(STAGE_MUSIC_KEY, JSON.stringify(kept));
        } catch { /* not kept */ }
      }
      stage = null;
    }
  };
}

// ------------------------------------------------------------ the game's own reads
// host.readsPending counts the game's reads that are waiting for the network, so background
// prefetching (lib/prefetch.js) can stand aside while the game itself is waiting. With
// ?traceReads=1 every read of a game archive is also recorded in window.mbrReadTrace as
// [frame, file, offset, length, waited], the input of buildPrefetchList (lib/prefetch.js).
function trackGameReads(fs, host, trace) {
  host.readsPending = 0;
  const log = trace ? (window.mbrReadTrace = []) : null;
  // waited: 1 for a read the game had to wait for (async), 0 for one served from the cache
  const note = (fd, position, n, waited) => {
    const f = fs.fds.get(fd);
    if (log && f && f.kind === 'game' && n > 0) log.push([host.frames, f.g.key, position, n, waited]);
  };
  const read = fs.read.bind(fs), readSync = fs.readSync.bind(fs);
  // host.onGameRead(file, position, length): every read of a game archive as the game asks
  // for it, before it is served (musicAhead)
  const seen = (fd, position, n) => {
    if (!host.onGameRead) return;
    const f = fs.fds.get(fd);
    if (f && f.kind === 'game' && n > 0) host.onGameRead(f.g.key, position, n);
  };
  fs.read = async (fd, dst, position, opts) => {
    seen(fd, position, dst.length);
    host.readsPending++;
    try { const n = await read(fd, dst, position, opts); note(fd, position, n, 1); return n; }
    finally { host.readsPending--; }
  };
  fs.readSync = (fd, dst, position) => {
    const n = readSync(fd, dst, position); // throws when the data has to be fetched: then read() follows
    seen(fd, position, dst.length);
    if (log) note(fd, position, n, 0);
    return n;
  };
}

// ------------------------------------------------------------ a fight's load
// The game's loading screen before a fight (its scene 8: VS, Arcade) is an animation of 278
// frames that fades to black by its 275th, and the game leaves that screen only when its loader
// thread has finished. From a server the loader has 60 MB and more to wait for, and the picture
// stays black for all of it: half a minute at 20 Mbit/s. So when that scene has outlasted its
// animation and the loader is waiting for the network, the page's loading screen
// (lib/loading-screen.js) takes the canvas's place until the fight appears, with what has been
// downloaded since the scene began.
//
// Waiting for the network: the game's reads have been waiting for a quarter of a second without
// a break (host.readsPending, trackGameReads). With everything at hand the scene still runs two
// seconds over (the loader's own work, with 32-bit textures), and that short black is left as it
// is; a load that takes four seconds over for any reason gets the screen as well. The scene is
// the game's own byte at 0x7cae0c (the game's memory is the wasm memory's first part, as for
// GAME_PAUSE_FLAG).
const GAME_SCENE = 0x7cae0c, SCENE_FIGHT_LOAD = 8;
const FIGHT_LOAD_FRAMES = 290;  // the animation's 278 frames and a few
const FIGHT_LOAD_WAITING = 15;  // frames in a row with a read waiting: the network is what it waits for
const FIGHT_LOAD_LATE = 240;    // frames over the animation after which the screen shows whatever the reason
function fightLoading(host, loading) {
  let since = -1, bytes = 0, waiting = 0, up = false; // since: the frame at which the loading scene began
  return (frame) => {
    const h = host.heap;
    if (!h || h.length <= GAME_SCENE) return;
    if (h[GAME_SCENE] !== SCENE_FIGHT_LOAD) {
      if (since >= 0) { since = -1; up = false; loading.away(); }
      return;
    }
    if (since < 0) { since = frame; bytes = loading.count(); waiting = 0; }
    waiting = host.readsPending > 0 ? waiting + 1 : 0;
    const over = frame - since - FIGHT_LOAD_FRAMES;
    if (!up && over >= 0 && (waiting >= FIGHT_LOAD_WAITING || over >= FIGHT_LOAD_LATE)) {
      up = true;
      loading.again('Loading the fight…', bytes);
    }
  };
}

// ------------------------------------------------------------ the end of a game the player quit
// The game quits by itself through ExitProcess (Exit Game on its title menu: WinMain returns 1,
// as in the original) or WM_QUIT. A trap or an abort stops it with another reason (runtime/rt.c,
// hle_core.c), and those keep the error report. The ending screen takes the canvas's place;
// Play again, Enter, Space or player 1's confirm key starts the game again.
const GAME_QUIT = /^(ExitProcess\(\d+\)|WM_QUIT)$/;

function showEnding() {
  const again = $('play-again');
  document.body.classList.add('ended');
  $('canvas').style.visibility = 'hidden'; // keeps its size, which the ending screen takes
  $('ending').hidden = false;
  status('Game closed');
  const restart = () => location.reload();
  again.addEventListener('click', restart);
  let keys = ['Enter', 'NumpadEnter', 'Space'];
  try { keys = keys.concat(keysOf(loadControls(), 'P1.A')); } catch { /* the keys above only */ }
  window.addEventListener('keydown', (e) => {
    if (e.repeat || !keys.includes(e.code) || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    restart();
  });
  again.focus({ preventScroll: true });
}

// ------------------------------------------------------------ host object for the runtime
function makeHost(fs, cfg) {
  const host = {
    fs,
    stats: { readsSync: 0, readsAsync: 0, readWaitMs: 0, bytesRead: 0, readErrors: 0 },
    listing: [],
    stop: null,
    frames: 0,
    frameTimes: cfg.collect ? [] : null, // [frame, presented, ms] triples, flat
    canvasShots: {},
    recent: [],
    onFrame(frame, presented, t) {
      host.frames = frame;
      if (host.frameTimes) host.frameTimes.push(frame, presented, t);
      if (host.latency) host.latency.frame(presented, t);
      const r = host.recent;
      r.push(t);
      if (r.length > 120) r.shift();
      if (frame % 30 === 0 && r.length > 1) {
        const fps = (r.length - 1) * 1000 / (r[r.length - 1] - r[0]);
        status(`${fps.toFixed(1)} fps`);
        if (host.latency) showLatency(host.latency, host.audio);
        if (host.onProgress) host.onProgress(frame, fps);
      }
    },
    onCanvas(frame, canvas) { host.canvasShots[frame] = canvas.toDataURL('image/png'); },
    onStop(why, ok, calls, traps, unimplemented) { host.stop = { why, ok, calls, traps, unimplemented }; },
  };
  return host;
}

// Memory actually used: 64 KiB pages of the wasm memory that hold anything but zeros,
// below and above the guest/host boundary. Untouched pages cost nothing on a 64-bit OS.
function touchedPages(buffer, boundary) {
  const words = new Uint32Array(buffer, 0, buffer.byteLength >>> 2);
  const pageWords = 16384;
  let guest = 0, host = 0, highest = 0;
  for (let p = 0; p * pageWords < words.length; p++) {
    const end = Math.min(words.length, (p + 1) * pageWords);
    let used = false;
    for (let i = p * pageWords; i < end; i++) if (words[i] !== 0) { used = true; break; }
    if (!used) continue;
    if (p * 65536 < boundary) { guest++; highest = p; } else host++;
  }
  return { guestMiB: guest / 16, hostMiB: host / 16, highestGuestAddress: (highest + 1) * 65536, totalMiB: buffer.byteLength / 1048576 };
}

function glRenderer() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no WebGL2';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return r;
  } catch (e) { return `error: ${e.message}`; }
}

// ------------------------------------------------------------ sound: the prompt, gesture unlock, and mute toggle
function soundUi(a) {
  const b = $('sound');
  const muted = a.isMuted ? a.isMuted() : !!a.summary().mute;
  const active = a.state === 'on' && !muted;
  const clsState = a.state === 'on' && muted ? 'muted' : a.state;
  b.hidden = false;
  b.disabled = a.state !== 'waiting' && a.state !== 'on';
  b.className = `sound ${clsState}`;
  b.setAttribute('aria-pressed', String(active));
  b.title = a.state === 'on' ? (muted ? 'Click to unmute sound' : 'Click to mute sound') : '';
  b.textContent = {
    waiting: 'Sound is off: click or press a key',
    starting: 'Starting sound…',
    on: 'Sound on',
    muted: 'Sound muted',
    failed: `No sound: ${a.error}`,
  }[clsState] || 'Sound off';
  const mb = $('mob-sound');
  if (mb) {
    mb.hidden = false;
    mb.disabled = a.state !== 'waiting' && a.state !== 'on';
    mb.className = `mhud-btn ${clsState}`;
    mb.setAttribute('aria-pressed', String(active));
    mb.textContent = {
      waiting: 'Sound: Tap',
      starting: 'Sound…',
      on: 'Sound on',
      muted: 'Muted',
      failed: 'No sound',
    }[clsState] || 'Sound';
  }
  const md = $('md-sound');
  if (md) {
    md.hidden = false;
    md.disabled = a.state !== 'waiting' && a.state !== 'on';
    md.classList.toggle('muted', clsState === 'muted');
    md.setAttribute('aria-pressed', String(active));
    md.textContent = {
      waiting: 'Tap to enable sound',
      starting: 'Starting sound…',
      on: 'Sound on (tap to mute)',
      muted: 'Sound muted (tap to unmute)',
      failed: `No sound: ${a.error}`,
    }[clsState] || 'Sound off';
  }
}

function wireSound(audio, autostart) {
  let startedAt = -1e9;
  const unlock = () => {
    if (audio.state === 'waiting') {
      startedAt = performance.now();
      audio.start();
    } else if (audio.ensureRunning) {
      audio.ensureRunning();
    }
  };
  const onButton = () => {
    if (audio.state === 'waiting') {
      startedAt = performance.now();
      audio.start();
    } else if (audio.state === 'on' && performance.now() - startedAt > 350) {
      audio.toggleMute();
    } else if (audio.ensureRunning) {
      audio.ensureRunning();
    }
  };
  $('sound').addEventListener('click', onButton);
  const mb = $('mob-sound');
  if (mb) mb.addEventListener('click', onButton);
  const md = $('md-sound');
  if (md) md.addEventListener('click', onButton);
  // any gesture on the page starts it (touchend included for iOS Safari)
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('touchend', unlock, { capture: true, passive: true });
  window.addEventListener('keydown', unlock, true);
  if (autostart) {
    const tryStart = setInterval(() => { if (audio.state === 'waiting') { clearInterval(tryStart); unlock(); } }, 50);
  }
}

// Keep the phone screen awake during Story scenes and replays (requires HTTPS)
function setupWakeLock() {
  if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return () => {};
  let lock = null;
  let active = true;
  const acquire = async () => {
    if (!active || document.visibilityState !== 'visible' || lock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch { /* ignored: non-HTTPS, low battery, or needs gesture */ }
  };
  const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
  const onGesture = () => { acquire(); };
  const release = () => {
    active = false;
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('pagehide', release);
    if (lock) { lock.release().catch(() => {}); lock = null; }
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  window.addEventListener('pagehide', release);
  acquire();
  return release;
}

// Whether the game has paused itself: its own flag (0x952238 in the game's memory, which is the
// wasm memory's first part), 1 while its Pause Menu (Arcade, Story) or the Practice Menu
// (Training) is open and 0 otherwise. null where it cannot be read (the game not started yet).
const GAME_PAUSE_FLAG = 0x952238;
function gamePauseState(host) {
  const h = host.heap;
  if (!h || h.length <= GAME_PAUSE_FLAG) return null;
  return h[GAME_PAUSE_FLAG] === 1;
}

const PAUSE_CHECK_MS = 250; // after a press of Pause: the game's own flag was set within 50 ms at 60 fps (the phone's button holds the key 75 ms)

// The Pause key (Esc unless Controls says otherwise) pauses wherever the phone's Pause button
// does. The game takes the key itself (lib/controls-model.js pageRuntimeText) and answers it in
// an Arcade fight and in Training only; in a VS fight and in the menus nothing happened. So, as
// for that button (wireMobileUi): where the game has not paused itself a quarter of a second
// after the press, the page holds the game (lib/pause.js), and the next press lets it go on.
// That second press does not reach the game. With a page open over the game (Settings, Controls,
// the Menu) the key is theirs.
function wireKeyboardPause({ pagePause, pageHeld, gamePaused }) {
  let check = 0;
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    let c;
    try { c = loadControls(); } catch { return; }
    // the keys the game has as Pause: those of Controls, and Esc as well while no action has it
    const escToo = e.code === PAGE_PAUSE && !Object.values(c.keys).some((ks) => Array.isArray(ks) && ks.includes(PAGE_PAUSE));
    if (!keysOf(c, 'PAUSE').includes(e.code) && !escToo) return;
    if (document.querySelector('dialog[open]') || document.body.classList.contains('ended')) return;
    clearTimeout(check);
    if (pageHeld()) {
      e.stopImmediatePropagation();
      e.preventDefault();
      pagePause(false);
      return;
    }
    if (gamePaused() !== false) return; // the game's own menu is open (this press closes it), or no flag to read yet
    check = setTimeout(() => {
      if (gamePaused() === false && !document.querySelector('dialog[open]')) pagePause(true);
    }, PAUSE_CHECK_MS);
  }, true);
}

// Wire the phone HUD pills, rotate hint, and Menu drawer
function wireMobileUi({ touch, pages, fullscreen, pause, gamePaused = () => null }) {
  // The Pause button presses the game's Pause key (lib/touch-controls.js triggerPause). The game
  // answers it in some places only: measured, its Pause Menu opens in an Arcade fight and the
  // Practice Menu in Training, and nothing happens in a VS COM fight or in the menus, where the
  // button seemed dead. Where the game has not paused itself a quarter of a second after the press (its own
  // flag, gamePaused), the page pauses instead, as it does while the Menu is open (lib/pause.js),
  // and the button is Resume until it is pressed again. A press while the game's own menu is
  // open closes that menu, and the page's pause never follows it.
  // While the page holds the game this way the picture stays in view, and a canvas that changes
  // size (the phone turned, the browser's bar going) is cleared with no frame coming to fill it:
  // one frame is let through then (pause.step), so the picture is drawn at its new size.
  const pauseBtn = $('mob-pause');
  let pageHolds = false, pauseCheck = 0, statusWas = '', deskWas = '', note = null;
  const pagePause = (on) => {
    if (!pause || !pauseBtn || on === pageHolds) return;
    pageHolds = on;
    pauseBtn.textContent = on ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', on ? 'Resume game' : 'Pause game');
    pauseBtn.classList.toggle('waiting', on);
    // The desktop layout has no button for it (the Pause key does this there, wireKeyboardPause):
    // its status line, the row under player 1's keys and a note over the picture say so.
    document.body.classList.toggle('page-paused', on);
    const what = $('pause-what');
    if (what) what.textContent = on ? 'Resume' : 'Pause';
    const st = $('mob-status'), pill = $('mob-fps'), desk = $('status'), lbl = $('status-lbl');
    if (on) {
      touch.releaseAll();
      pause.hold();
      // no frame, so no frame rate: say that the game waits (the next frame rate replaces it)
      if (st) { statusWas = st.textContent; st.textContent = 'Paused'; }
      if (pill) pill.dataset.state = 'stop';
      if (desk) { deskWas = desk.textContent; desk.textContent = 'Paused'; if (lbl) lbl.textContent = 'Status'; }
      if (!document.body.classList.contains('mobile')) {
        let key = null;
        try { key = keysOf(loadControls(), 'PAUSE')[0] || null; } catch { key = null; }
        note = document.createElement('p');
        note.setAttribute('role', 'status');
        note.textContent = key ? `Paused · ${keyLabel(key)} resumes` : 'Paused';
        note.style.cssText = 'align-self:center;justify-self:center;z-index:5;margin:0;padding:.45em 1.3em;border-radius:999px;'
          + 'background:rgb(0 0 0 / .72);box-shadow:0 0 0 1px rgb(255 255 255 / .28);color:#fff;font:italic 1.3rem/1.3 var(--mb-serif, serif);pointer-events:none;';
        $('screen').append(note);
      }
    } else {
      if (st && st.textContent === 'Paused') st.textContent = statusWas;
      if (pill) pill.dataset.state = 'live';
      if (desk && desk.textContent === 'Paused') { desk.textContent = deskWas; if (lbl && /\bfps\b/.test(deskWas)) lbl.textContent = 'Frame rate'; }
      if (note) { note.remove(); note = null; }
      pause.release();
    }
  };
  if (pauseBtn && pause && typeof ResizeObserver === 'function') {
    let redraw = 0;
    new ResizeObserver(() => {
      if (!pageHolds) return;
      clearTimeout(redraw);
      redraw = setTimeout(() => { if (pageHolds) pause.step(); }, 120); // once the new size has settled
    }).observe($('canvas'));
  }
  if (pauseBtn) {
    pauseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      clearTimeout(pauseCheck);
      if (pageHolds) { pagePause(false); return; }
      const was = gamePaused();
      touch.triggerPause(e.timeStamp);
      if (was !== false) return; // the game's own menu is open (this press closes it), or no flag to read
      pauseCheck = setTimeout(() => {
        if (gamePaused() === false && !document.querySelector('dialog[open]')) pagePause(true);
      }, PAUSE_CHECK_MS);
    });
  }

  const drawer = $('mobile-drawer');
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // The game waits while the drawer is open (lib/pause.js): it covers most of a phone's screen,
  // and the game's own Pause works in some modes only. A page opened from the drawer takes its
  // own hold before the drawer's is released (its close event comes later), so the game stays
  // paused from one to the other.
  let drawerHolds = false;
  const holdGame = (on) => {
    if (!pause || on === drawerHolds) return;
    drawerHolds = on;
    if (on) pause.hold(); else pause.release();
  };
  const openDrawer = () => {
    if (!drawer || drawer.open) return;
    drawer.classList.remove('closing');
    touch.releaseAll();
    window.dispatchEvent(new Event('blur'));
    syncFullscreenBtn();
    holdGame(true);
    // the frame rate shown is the last one measured: say that the game waits instead
    const st = $('md-status');
    if (st && pause && /\bfps\b/.test(st.textContent)) st.textContent = 'Paused';
    drawer.showModal();
  };
  if (drawer) drawer.addEventListener('close', () => holdGame(false));
  const closeDrawer = (instant = false) => {
    if (!drawer || !drawer.open) return;
    if (instant || reduceMotion()) { drawer.classList.remove('closing'); drawer.close(); return; }
    if (drawer.classList.contains('closing')) return;
    drawer.classList.add('closing');
    setTimeout(() => {
      drawer.classList.remove('closing');
      if (drawer.open) drawer.close();
    }, 185);
  };

  const menuBtn = $('mob-menu-btn');
  if (menuBtn) menuBtn.addEventListener('click', openDrawer);
  const closeBtn = $('mob-drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeDrawer(false));
  if (drawer) {
    drawer.addEventListener('cancel', (e) => { e.preventDefault(); closeDrawer(false); });
    drawer.addEventListener('click', (e) => {
      // Tap on backdrop outside .md-scroll closes the drawer
      if (e.target === drawer) closeDrawer(false);
    });
  }

  const wirePageBtn = (id, openFn) => {
    const el = $(id);
    if (el) el.addEventListener('click', () => { closeDrawer(true); openFn(); });
  };
  wirePageBtn('md-guide', pages.openGuide);
  wirePageBtn('md-settings', pages.openSettings);
  wirePageBtn('md-controls', pages.open);
  wirePageBtn('md-music', pages.openMusic);

  const fsBtn = $('md-fullscreen');
  const iosHint = $('md-ios-hint');
  const isStandalone = window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  const isInFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  let autoLandscapeFs = false;
  let userDeclinedFs = false;
  let wasLandscape = false;
  const allowAutoFs = params.get('fullscreen') !== 'off';

  const syncFullscreenBtn = () => {
    const avail = fullscreenAvailable($('stage'));
    if (fsBtn) {
      fsBtn.hidden = !avail;
      fsBtn.textContent = isInFullscreen() ? 'Leave full screen' : 'Full screen';
    }
    if (iosHint) iosHint.hidden = avail || isStandalone || !isIos;
  };
  const tryEnterLandscapeFs = (e) => {
    if (!allowAutoFs || userDeclinedFs || !document.body.classList.contains('mobile-landscape')) return;
    if (!fullscreenAvailable($('stage')) || isInFullscreen()) return;
    if ((drawer && drawer.open) || document.querySelector('dialog.page-overlay[open]')) return;
    if (e && e.target && e.target.closest && e.target.closest('#mob-menu-btn, #mobile-drawer')) return;
    autoLandscapeFs = true;
    fullscreen.enter();
  };
  const syncLandscapeFs = () => {
    const landscape = document.body.classList.contains('mobile-landscape');
    if (landscape && !wasLandscape) {
      wasLandscape = true;
      userDeclinedFs = false;
      window.scrollTo(0, 1);
      if (navigator.userActivation && navigator.userActivation.isActive) tryEnterLandscapeFs(null);
    } else if (!landscape && wasLandscape) {
      wasLandscape = false;
      userDeclinedFs = false;
      if (autoLandscapeFs && isInFullscreen()) fullscreen.exit();
      autoLandscapeFs = false;
    }
  };
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      if (isInFullscreen()) { userDeclinedFs = true; autoLandscapeFs = false; }
      else { userDeclinedFs = false; }
      closeDrawer(true);
      fullscreen.toggle();
    });
  }
  const onFsChange = () => {
    if (!isInFullscreen() && wasLandscape && autoLandscapeFs) {
      userDeclinedFs = true;
      autoLandscapeFs = false;
    }
    syncFullscreenBtn();
    // Refit gutters & canvas for the new fullscreen viewport dimensions
    requestAnimationFrame(() => fullscreen.layout());
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  // Browsers require a user gesture for requestFullscreen: auto-enter on the first touch in landscape
  window.addEventListener('pointerdown', tryEnterLandscapeFs, { capture: true, passive: true });
  window.addEventListener('touchend', tryEnterLandscapeFs, { capture: true, passive: true });
  window.addEventListener('resize', syncLandscapeFs);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', syncLandscapeFs);
  window.addEventListener('orientationchange', () => setTimeout(syncLandscapeFs, 80));
  syncFullscreenBtn();
  syncLandscapeFs();

  // Touch preferences controls inside the Menu drawer
  const modeBtns = drawer ? [...drawer.querySelectorAll('[data-tc-mode]')] : [];
  const macroBtns = drawer ? [...drawer.querySelectorAll('[data-tc-macros]')] : [];
  const visBtns = drawer ? [...drawer.querySelectorAll('[data-tc-vis]')] : [];
  const scaleEl = $('md-tc-scale');
  const opacityEl = $('md-tc-opacity');
  const hapRow = $('md-tc-haptics-row');
  const hapEl = $('md-tc-haptics');
  const padNote = $('md-pad-note');

  for (const b of modeBtns) b.addEventListener('click', () => touch.setPrefs({ mode: b.dataset.tcMode }));
  for (const b of macroBtns) b.addEventListener('click', () => touch.setPrefs({ macros: b.dataset.tcMacros }));
  for (const b of visBtns) b.addEventListener('click', () => touch.setPrefs({ visibility: b.dataset.tcVis }));
  if (scaleEl) scaleEl.addEventListener('input', () => touch.setPrefs({ scale: Number(scaleEl.value) }));
  if (opacityEl) opacityEl.addEventListener('input', () => touch.setPrefs({ opacity: Number(opacityEl.value) }));
  if (hapEl) hapEl.addEventListener('change', () => touch.setPrefs({ haptics: hapEl.checked }));
  if (hapRow && !touch.canVibrate) hapRow.hidden = true;

  touch.onChange((p, { hasGamepad }) => {
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.tcMode === p.mode));
    for (const b of macroBtns) b.setAttribute('aria-pressed', String(b.dataset.tcMacros === p.macros));
    for (const b of visBtns) b.setAttribute('aria-pressed', String(b.dataset.tcVis === p.visibility));
    if (scaleEl) scaleEl.value = String(p.scale);
    if (opacityEl) opacityEl.value = String(p.opacity);
    if (hapEl) hapEl.checked = !!p.haptics;
    if (padNote) padNote.hidden = !(hasGamepad && p.visibility === 'auto');
  });

  // No selection starts in the phone layout's stage (play.html says the same in CSS: this is for
  // a browser that lets a long press through all the same). The desktop layout is left alone.
  $('stage').addEventListener('selectstart', (e) => {
    if (document.body.classList.contains('mobile')) e.preventDefault();
  });

  // A first visit's hint: what A and B do in the menus, shown by the picture for a few seconds
  // once the game runs (the first frame rate), then not again in this browser. The Menu says the
  // same at any time. Not with a controller in use, nor in the desktop layout.
  const tip = $('mobile-tip');
  const TIP_KEY = 'mbr.touchTipSeen', TIP_MS = 14000;
  const tipSeen = (() => { try { return localStorage.getItem(TIP_KEY) === '1'; } catch { return false; } })();
  if (tip && !tipSeen) {
    const fpsPill = $('mob-fps');
    const waitForGame = setInterval(() => {
      const state = fpsPill ? fpsPill.dataset.state : 'live';
      if (state === 'load') return;
      clearInterval(waitForGame);
      const cl = document.body.classList;
      if (state !== 'live' || !cl.contains('mobile') || cl.contains('tc-overlay-hidden') || cl.contains('ended')) return;
      tip.hidden = false;
      setTimeout(() => {
        tip.classList.add('out');
        setTimeout(() => { tip.hidden = true; }, 450);
        try { localStorage.setItem(TIP_KEY, '1'); } catch { /* shown again next time */ }
      }, TIP_MS);
    }, 400);
  }

  // Portrait rotate hint (dismissible per session)
  const hint = $('mobile-rotate-hint');
  const dismissBtn = $('mob-rotate-dismiss');
  const HINT_KEY = 'mbr.rotateHintDismissed';
  const dismissed = (() => { try { return sessionStorage.getItem(HINT_KEY) === '1'; } catch { return false; } })();
  if (hint && !dismissed) hint.hidden = false;
  if (dismissBtn && hint) {
    dismissBtn.addEventListener('click', () => {
      hint.hidden = true;
      try { sessionStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
      fullscreen.layout();
    });
  }
  return { pagePause, pageHeld: () => pageHolds };
}

// ------------------------------------------------------------ user-area helpers for unattended runs
function emptyUserArea(fs) {
  const walk = (dir) => {
    for (const e of fs.list(dir)) {
      if (e.area !== 'user') continue;
      const p = `${dir}\\${e.name}`;
      if (e.isDir) walk(p); else fs.unlink(p);
    }
  };
  for (const m of MOUNTS) walk(m.path);
}

async function post(url, body, type) {
  const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': type || 'application/octet-stream' } });
  if (!r.ok) throw new Error(`POST ${url}: ${r.status}`);
}

function readTree(FS, dir, out = []) {
  let names;
  try { names = FS.readdir(dir); } catch { return out; }
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    const p = `${dir}/${n}`;
    const st = FS.stat(p);
    if (FS.isDir(st.mode)) readTree(FS, p, out); else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------ main
async function main() {
  // in the canvas's place until the title screen's data has arrived (not in unattended runs)
  const loading = createLoadingScreen({ skip: !!params.get('run') });
  watchKeys();
  layoutCanvas();
  watchBasics();
  window.addEventListener('resize', layoutCanvas);
  const fullscreen = setupFullscreen({ stage: $('stage'), canvas: $('canvas'), button: $('fullscreen'), relayout: layoutCanvas, params, auto: !params.get('run'), scaling: prefs.scaling });
  window.mbrFullscreen = fullscreen;
  const relayoutMobile = () => fullscreen.layout();
  if (window.visualViewport) window.visualViewport.addEventListener('resize', relayoutMobile);
  window.addEventListener('orientationchange', () => setTimeout(relayoutMobile, 60));
  // A message can appear above the canvas: fit again whenever it changes size, or the body (at
  // least the window's height) does, which also catches a resize seen mid-way. The side strips
  // need no watching: the canvas size does not depend on them (layoutCanvas).
  // The new layout waits for the next frame: changing sizes inside the observer's callback can
  // make the browser report a "ResizeObserver loop".
  if (typeof ResizeObserver === 'function') {
    let pending = 0;
    const refit = new ResizeObserver(() => {
      if (!pending) pending = requestAnimationFrame(() => { pending = 0; fullscreen.layout(); });
    });
    refit.observe($('message'));
    refit.observe(document.body);
  }
  const t0 = performance.now();
  const timing = {};

  let cfg = { env: {}, files: {}, seed: [], collect: false };
  if (params.get('run')) {
    // Only a configuration from this site, over http(s): one can empty or replace the player's
    // saves (resetUser, seed), so a link must not be able to bring its own (another site, data:,
    // blob:, or this site redirecting to one of those).
    const sameSite = (u) => /^https?:$/.test(u.protocol) && u.origin === location.origin;
    let runUrl = null;
    try { runUrl = new URL(params.get('run'), location.href); } catch { runUrl = null; }
    if (!runUrl || !sameSite(runUrl)) {
      show('error', `Run configuration ${esc(params.get('run'))} was not loaded: it has to be a file of this site.`);
      return;
    }
    const r = await fetch(runUrl, { cache: 'no-store' });
    if (!r.ok) { show('error', `Run configuration ${esc(params.get('run'))} could not be loaded (${r.status}).`); return; }
    if (!sameSite(new URL(r.url))) {
      show('error', `Run configuration ${esc(params.get('run'))} was not loaded: it has to be a file of this site.`);
      return;
    }
    cfg = { env: {}, files: {}, seed: [], collect: true, ...(await r.json()) };
  }
  const fail = async (msg, extra = {}) => {
    show('error', msg);
    if (cfg.report) await post(`${cfg.report}/__done`, JSON.stringify({ failed: true, message: msg.replace(/<[^>]+>/g, ''), userAgent: navigator.userAgent, ...extra }), 'application/json').catch(() => {});
  };

  // 1. start mounting files and fetching the wasm build in parallel (both modes: the .wasm is
  // handed to the build's instantiateWasm hook below, so Emscripten never fetches it itself)
  const mode = params.get('mode') || cfg.mode || (hasJspi ? 'jspi' : 'asyncify');
  const buildName = params.get('build') || cfg.build || `mbr-${mode}`;
  if (mode === 'jspi' && !hasJspi) { await fail('This browser has no WebAssembly stack switching (JSPI). Load the page with <code>?mode=asyncify</code>.'); return; }
  const buildUrl = new URL(`./build/${buildName}.mjs`, import.meta.url).href;
  const wasmUrl = new URL(`./build/${buildName}.wasm`, import.meta.url).href;
  const tb = performance.now();
  const buildPromise = import(buildUrl);
  const wasmPromise = fetch(wasmUrl, { credentials: 'same-origin' });
  buildPromise.catch(() => {}); // handled when awaited below; avoid unhandledrejection if mount fails first
  wasmPromise.catch(() => {});

  status('Loading game bundle…');
  let fs;
  try {
    // A 256 MiB block cache keeps what a match loaded for the next load of the same characters
    // and stage (64 MiB was evicted 65 times in one VS COM match).
    //
    // Blocks of 256 KiB, the size the site's pieces are cut for (tools/make-site.mjs; a bundle
    // split otherwise sets its own, lib/vfs.js _mount), with little read-ahead: 1 MiB when the
    // game reads on from where it was, one block after a fresh seek. A read of a few KB then
    // brings in 256 KiB and not megabytes. Measured over HTTP in Chrome, a first visit, nothing
    // loaded ahead: 31 MB before the title screen for the 24 MB the game reads there (76 MB
    // with 1 MiB pieces and 4-8 MiB of read-ahead, the site as it was), and 108 MB through the
    // start of a first fight (over 145 MB). The larger read-ahead bought no time: with 120 ms a
    // request and unlimited speed a fight loaded in 9.4 s with these values and 11.1 s with the
    // old ones (pieces of a read are fetched together either way), and no slower either with
    // each connection held to 30 Mbit/s. The longest stalls in the menus were no longer.
    fs = await mountGameFs({ mode: 'async', mounts: MOUNTS, cwd: GUEST_DIR, blockSize: 256 << 10, cacheBytes: 256 << 20,
      readAhead: (Number(params.get('readAhead')) || 1024) << 10, freshAhead: (Number(params.get('freshAhead')) || 256) << 10, // ?readAhead=, ?freshAhead=: KiB, for measuring
      // saves that are not being kept: said on the page, except in unattended runs
      onWarning: params.get('run') ? (kind, detail) => console.warn(`[play] storage: ${kind}: ${detail}`) : storageNotices(),
      ...(cfg.vfs || {}) });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      await fail(`The bundled game files could not be loaded.<br><small>${esc(e.message)}</small><br>Make sure <code>data/bundle-manifest.json</code> and <code>data/</code> are served alongside this page.`);
    } else if (e && e.code === 'EBUSY') {
      await fail('The game files are in use by another tab of this site. Close it and reload.');
    } else {
      await fail(`The browser's private storage could not be opened: ${esc(e && e.message || e)}`);
    }
    return;
  }
  timing.mountMs = performance.now() - t0;

  // 2. read mbr.exe in parallel with the .mjs / .wasm downloads already in flight
  if (cfg.resetUser) emptyUserArea(fs);
  for (const s of cfg.seed || []) {
    const r = await fetch(s.url, { cache: 'no-store' });
    if (!r.ok) { await fail(`Seed file ${esc(s.url)} could not be fetched (${r.status}).`); return; }
    fs.writeFile(s.path, new Uint8Array(await r.arrayBuffer()));
  }
  const exePromise = fs.readAt(`${GUEST_DIR}\\mbr.exe`, 0, fs.size(`${GUEST_DIR}\\mbr.exe`));
  exePromise.catch(() => {});

  status(`Loading the game build (${buildName})…`);
  let createMbr;
  try {
    ({ default: createMbr } = await buildPromise);
  } catch (e) {
    await fail(`The game build <code>build/${esc(buildName)}.mjs</code> was not found.<br>It is compiled on your machine from your own <code>mbr.exe</code> and is not part of this site:<br><code>make -C recompiler gen &amp;&amp; make -C recompiler wasm${mode === 'asyncify' ? ' WASM_MODE=asyncify' : ''}</code><br>then serve with <code>node web/tools/serve.mjs</code>, which maps <code>recompiler/out/web/</code> to <code>build/</code>.<br><small>${esc(e && e.message || e)}</small>`);
    return;
  }

  // 3. run configuration
  const exe = await exePromise;
  const unattended = !!params.get('run');
  // A first start in this browser: 32-bit colour and textures (lib/gamecfg.js PORT_START), with
  // the cfg.cfg of a first start, without which the game would reset app.cfg to its own 16-bit
  // defaults. Files that exist, imported or saved, are the player's and stay as they are.
  if (!unattended && !fs.exists(`${GUEST_DIR}\\app.cfg`) && !fs.exists(`${GUEST_DIR}\\cfg.cfg`)) {
    fs.writeFile(`${GUEST_DIR}\\app.cfg`, portStartAppCfg());
    fs.writeFile(`${GUEST_DIR}\\cfg.cfg`, encodeCfgCfg(firstStartCfgBody(), newSeed()));
  }
  const env = {
    MBR_EXE: '/mbr.exe', MBR_GUEST_DIR: GUEST_DIR, MBR_OVERLAY: '/overlay',
    MBR_LOG: unattended ? '/out/hle.log' : '/dev/null', MBR_OUT: '/out/frames',
    ...(unattended ? {} : { MBR_FRAMES_LOG: '0' }),
    ...(!unattended && document.body.classList.contains('mobile') ? { MBR_SOUND_AHEAD: '700' } : {}),
    // unpacked pictures kept for the next time the game unpacks them (recompiler/runtime/hle_fast.c):
    // 64 MB by default, less on a phone
    ...(!unattended && document.body.classList.contains('mobile') ? { MBR_UNPACK_CACHE_MB: '24' } : {}),
    ...prefs.env,
    ...cfg.env,
  };
  if (params.get('pace')) env.MBR_PACE = params.get('pace');
  if (params.get('slice') === '0') env.MBR_THREAD_SLICE = '0'; // the battle loader in one piece per step, as before
  if (params.get('sound')) env.MBR_SOUND = params.get('sound') === '0' ? '0' : '1';

  const host = makeHost(fs, cfg);
  // Saves are written a quarter of a second behind (lib/vfs.js autoFlushMs). Write what is
  // waiting at once when the page is hidden or left: a phone's browser may never run that timer
  // again. Only what the game changed is written. Not on the way to a restart from Settings
  // (lib/controls-host.js), which is a plain reload so that nothing of the game's goes over the
  // files just saved there.
  if (cfg.persist !== false) {
    const writeNow = () => { if (!host.restarting) fs.flush().catch(() => {}); }; // lib/vfs.js reports a failure
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeNow(); });
    window.addEventListener('pagehide', writeNow);
  }
  if (!unattended && fs.persistent) keepStorage();
  trackGameReads(fs, host, params.get('traceReads') === '1');
  // the title screen's data is read at the game's first two frames: the loading screen goes once
  // those are drawn and nothing waits for the network
  loading.track(() => ({ frames: host.frames, pending: host.readsPending || 0 }));
  if (!unattended) {
    host.latency = createLatencyMeter();
    window.addEventListener('keydown', (e) => host.latency.key(e), true);
  }
  host.pause = createPause(() => host.audio, () => { host.recent.length = 0; }); // the music page pauses the game while it is open; on a phone every page and the menu drawer do
  const pages = attachControls(host, { fs, guestDir: GUEST_DIR, unattended, runCfg: cfg }); // keys, controllers, the Controls panel
  let releaseWakeLock = () => {};
  if (!unattended) {
    if (prefs.mouse) attachMouse($('canvas')); // optional wheel and clicks for the menus (off by default)
    attachExtraKeys(); // Backspace for "back", Enter for "confirm"
    const touch = attachTouchControls({ onPress: (ts) => host.latency && host.latency.touch(ts) });
    const gamePaused = () => gamePauseState(host);
    const { pagePause, pageHeld } = wireMobileUi({ touch, pages, fullscreen, pause: host.pause, gamePaused });
    wireKeyboardPause({ pagePause, pageHeld, gamePaused });
    releaseWakeLock = setupWakeLock();
    fullscreen.layout();
  }
  // Settings, the Guide and Music open over the game from here on, as Controls does (before this
  // the links simply leave the page, which loses nothing); a modified click still opens a page
  const popupLinks = [['a[href$="settings.html"]', pages.openSettings], ['a[href$="guide.html"]', pages.openGuide],
    ['a[href$="music.html"]', pages.openMusic]];
  for (const [selector, open] of unattended ? [] : popupLinks) {
    for (const link of document.querySelectorAll(`.side ${selector}`)) {
      link.addEventListener('click', (e) => {
        if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        open();
      });
    }
  }
  host.onDisplayMode = fullscreen.gameMode; // the game's own full-screen setting (runtime/host_display.c)
  const audioCfg = cfg.audio || {};
  const audio = createAudioOutput({
    workletUrl: new URL('./lib/audio-worklet.js', import.meta.url).href,
    latency: Number(params.get('audioLatency') || audioCfg.latency || prefs.audioLatency) / 1000,
    mute: params.get('mute') === '1' || !!audioCfg.mute,
    volume: prefs.volume,
    onState: soundUi,
  });
  host.audio = audio;
  wireSound(audio, !!audioCfg.autostart);
  const stderr = [];
  let exitCode = null;
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  if (cfg.report) {
    let last = 0;
    host.onProgress = (frame, fps) => {
      const now = performance.now();
      if (now - last < 2000) return;
      last = now;
      post(`${cfg.report}/__progress`, JSON.stringify({ frame, fps }), 'application/json').catch(() => {});
    };
  }

  // How a run ends. exit() in the runtime calls onExit and throws an ExitStatus through
  // the wasm frames; with other stacks suspended (guest threads) only the throw may arrive,
  // and it surfaces wherever the game was last resumed from: callMain, a fiber's promise,
  // an event callback or a promise job. A wasm trap (out-of-bounds access, unreachable,
  // stack overflow) arrives the same ways. All of them end up in `thrown`.
  const finishRun = (code) => { if (exitCode === null) { exitCode = code; resolveExit(); } };
  const thrown = (e) => {
    if (e && e.name === 'ExitStatus') { finishRun(e.status); return; }
    stderr.push(`fatal: ${e && e.name ? `${e.name}: ${e.message}\n` : ''}${e && e.stack || e}`);
    console.error(stderr[stderr.length - 1]);
    finishRun(136);
  };
  // The runtime also reports its own stop (hle_stop, after flushing its files) just before
  // exit(). Emscripten 7 with Asyncify swallows the ExitStatus when other stacks are still
  // suspended and does not call onExit, so that report is what ends the run there.
  const recordStop = host.onStop;
  host.onStop = (why, ok, ...rest) => { recordStop(why, ok, ...rest); setTimeout(() => finishRun(ok ? 0 : 2), 0); };
  window.addEventListener('error', (e) => {
    // The browser reports a ResizeObserver whose callback changed sizes as an error event with
    // no error object: it is the page's layout, not the game, and must not end the run.
    if (!e.error && /ResizeObserver loop/.test(e.message || '')) return;
    thrown(e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => thrown(e.reason));

  status('Starting…');
  holdGameLock(); // the settings page warns while the game runs (it writes its settings back)
  let Module;
  try {
    const arg = {
      canvas: $('canvas'),
      mbr: host,
      locateFile: (p) => new URL(`./build/${p}`, import.meta.url).href,
      print: (line) => { stderr.push(line); },
      printErr: (line) => { stderr.push(line); console.log(line); },
      preRun: [(M) => {
        Object.assign(M.ENV, env);
        M.FS.writeFile('/mbr.exe', exe);
        M.FS.mkdirTree('/out/frames');
        for (const [path, text] of Object.entries(cfg.files || {})) {
          M.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
          M.FS.writeFile(path, text);
        }
      }],
      onExit: (code) => finishRun(code),
      onAbort: (what) => { stderr.push(`abort: ${what}`); finishRun(134); },
      mbrFiberFailed: thrown, // a guest thread other than the main one ended the run or trapped
    };
    if (mode === 'jspi') {
      await new Promise((resolve, reject) => {
        arg.onInstantiateError = reject;
        installJspi(arg, wasmPromise);
        createMbr(arg).then((M) => { Module = M; resolve(); }, reject);
      });
    } else {
      // Asyncify: Emscripten's loader takes the same hook and still wraps the exports itself
      // (receiveInstance -> Asyncify.instrumentWasmExports); without it the .wasm download
      // would only start here, after the mount and the mbr.exe read.
      await new Promise((resolve, reject) => {
        arg.instantiateWasm = (imports, receiveInstance) => {
          instantiateBuild(wasmPromise, imports).then((r) => receiveInstance(r.instance, r.module)).catch(reject);
          return {}; // asynchronous: receiveInstance is called later
        };
        createMbr(arg).then((M) => { Module = M; resolve(); }, reject);
      });
    }
  } catch (e) {
    await fail(`The game build could not be started: ${esc(e && e.message || e)}`);
    return;
  }
  timing.buildLoadMs = performance.now() - tb;
  const tStart = performance.now();
  timing.toStartMs = tStart - t0;
  let firstFrame = null;
  let storyPreload = null; // preloadStoryData's result: { bytes, ms } or { error }
  let prefetched = null; // prefetchNextScreens's result: { bytes, ms, skipped } or { error }
  const onFrame = host.onFrame;
  const keys = (cfg.keys || []).slice().sort((a, b) => a.frame - b.frame);
  const watchFightLoad = fightLoading(host, loading);
  host.onFrame = (frame, presented, t) => {
    watchFightLoad(frame);
    if (firstFrame === null) {
      firstFrame = t;
      $('canvas').focus();
      // two seconds in (the Warning screen), when the start-up reads are done.
      // Skip eager 41 MiB Story preload on phones unless ?preload=1 is explicitly set.
      const phone = document.body.classList.contains('mobile');
      const shouldPreload = params.get('preload') === '1' || (params.get('preload') !== '0' && !phone);
      // First the screens every player goes through next (lib/prefetch.js; ?prefetch=0 leaves it
      // out, ?prefetch=1 turns it on in unattended runs), then Story mode's data. The music a
      // battle is about to need (musicAhead) is fetched with data saver on too, a block at a
      // time when the game shows it is coming; ?prefetch=rules is that alone.
      const saveData = navigator.connection && navigator.connection.saveData;
      const pf = params.get('prefetch');
      const shouldPrefetch = pf === '1' || (pf === null && !unattended && !saveData);
      const shouldLookAhead = pf === '1' || pf === 'rules' || (pf === null && !unattended);
      setTimeout(async () => {
        let list = null;
        if (shouldPrefetch || shouldLookAhead) {
          try { list = await loadPrefetchList(); } catch (e) { prefetched = { error: String(e && e.message || e) }; }
        }
        if (list && shouldLookAhead) musicAhead(fs, host, list);
        if (list && shouldPrefetch) {
          try { prefetched = await prefetchNextScreens(fs, host, list); } catch (e) { prefetched = { error: String(e && e.message || e) }; }
          window.mbrPrefetched = prefetched; // for checking from the console
        }
        if (shouldPreload && (!unattended || params.get('preload') === '1')) { // ?preload=1: unattended runs too
          preloadStoryData(fs, () => host.readsPending > 0).then((r) => { storyPreload = r; }, (e) => { storyPreload = { error: String(e && e.message || e) }; });
        }
      }, 2000);
    }
    while (keys.length && keys[0].frame <= frame) {
      const k = keys.shift();
      window.dispatchEvent(new KeyboardEvent(k.down ? 'keydown' : 'keyup', { code: k.code, bubbles: true, cancelable: true }));
    }
    onFrame(frame, presented, t);
  };
  try {
    const r = Module._mbr_main(); // a promise in the JSPI build; in the Asyncify build it returns at the first suspension
    if (r && typeof r.then === 'function') r.catch(thrown);
  } catch (e) {
    thrown(e);
  }
  await exited;
  loading.away(); // a fight's loading screen, should the game end under it
  releaseWakeLock();
  if (host.removeKeyboard) host.removeKeyboard();

  // 4. the run is over
  const tEnd = performance.now();
  if (cfg.persist !== false) await fs.flush().catch((e) => stderr.push(`user-area flush failed: ${e.message}`));
  const summary = {
    build: buildName, mode, userAgent: navigator.userAgent, renderer: glRenderer(),
    exitCode, stop: host.stop, frames: host.frames,
    // performance.now() counts from the navigation start: *SinceNavigation includes loading the page itself
    timing: { ...timing, firstFrameMs: firstFrame === null ? null : firstFrame - t0, firstFrameSinceNavigationMs: firstFrame, pageScriptStartMs: t0, runMs: tEnd - tStart },
    reads: { ...host.stats, cache: fs.cache ? { ...fs.cache.stats } : null,
      trimmed: fs.info.trimmed, storedBytes: fs.info.storedBytes, gapReads: fs.info.gapReads, gapReadList: fs.info.gapReadList },
    fibers: Module.mbrFibers ? Module.mbrFibers.switches : 0,
    crossOriginIsolated: self.crossOriginIsolated === true,
    devicePixelRatio: window.devicePixelRatio,
    visibility: document.visibilityState,
    memory: cfg.collect && host.heap ? touchedPages(host.heap.buffer, 0x30000000) : null,
    audio: audio.summary(),
    display: fullscreen.gameState, // the game's display mode as last reported by the runtime (lib/fullscreen.js)
    storyPreload, // Story mode's data read ahead into the cache (preloadStoryData)
    prefetched, // the next screens' data read ahead (lib/prefetch.js)
    musicAhead: host.musicAhead || 0, // music blocks fetched as the game showed they were coming
    readTrace: window.mbrReadTrace, // ?traceReads=1 only
  };
  const ok = exitCode === 0;
  const quit = !!host.stop && GAME_QUIT.test(host.stop.why);
  if (!unattended && (ok || quit)) showEnding();
  else {
    status(ok ? `Stopped: ${host.stop ? host.stop.why : 'exit'}` : 'Stopped with an error');
    if (!ok) show('error', `The game stopped: ${esc(host.stop ? host.stop.why : `exit code ${exitCode}`)}<pre>${esc(stderr.slice(-25).join('\n'))}</pre>`);
  }
  window.mbrRun = { summary, stderr, host, Module };

  if (cfg.report) {
    try {
      for (const p of readTree(Module.FS, '/out')) await post(`${cfg.report}${p}`, Module.FS.readFile(p));
      for (const [frame, dataUrl] of Object.entries(host.canvasShots)) {
        const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        await post(`${cfg.report}/out/frames/canvas_${String(frame).padStart(6, '0')}.png`, bytes);
      }
      await post(`${cfg.report}/out/stderr.txt`, stderr.join('\n') + '\n', 'text/plain');
      if (host.frameTimes) await post(`${cfg.report}/out/frametimes.json`, JSON.stringify(host.frameTimes), 'application/json');
      await post(`${cfg.report}/__done`, JSON.stringify(summary), 'application/json');
      status(`${$('status').textContent} (results sent)`);
    } catch (e) {
      show('error', `Sending the results failed: ${esc(e.message)}`);
    }
  }
}

main().catch((e) => { show('error', `Unexpected error: ${esc(e && e.stack || e)}`); });
