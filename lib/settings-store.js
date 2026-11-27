// Settings that belong to this browser port, not to the game: canvas size and scaling,
// sound on or off, master volume, audio latency, the launcher's game speed, which the game
// does not keep from one start to the next (reset to 60 at every start), and a copy of the
// launcher's full-screen choice (app.cfg holds it too; see lib/gamecfg.js). They live
// in localStorage, apart from the game's own files, and the game page applies them when it
// starts. URL parameters of the game page win over them; unattended runs (?run=) ignore them.

import { readZip, ZipError } from './zip.js';
import { APP_CFG_SIZE, CFG_SIZE, parseAppCfg, decodeCfgCfg } from './gamecfg.js';

export const STORAGE_KEY = 'mbr.settings.v1';
export const ZIP_SETTINGS_NAME = 'mbr-settings.json';
export const GAME_LOCK = 'mbr-game-running';

export const HOST_DEFAULTS = Object.freeze({
  scale: 'fit',      // 'fit' or '1'..'4' (x 640x480)
  scaling: 'upscale', // SCALINGS: how the 640x480 picture is enlarged
  sound: true,       // MBR_SOUND
  volume: 1,         // master gain 0..1, on top of the game's own BGM / effects volumes
  audioLatency: 40,  // ms the audio device plays behind the game's mix
  gameSpeed: 60,     // the launcher's "Game speed (1-1000)" (frames per second)
  screenMode: 'windowed', // the launcher's video mode as chosen here; a copy of app.cfg's value,
                          // from before the HLE had exclusive mode (pageSettings().fullscreen)
  mouse: false,      // optional mouse support in menus (wheel + clicks); off by default
});

// First-visit default on touch devices (coarse-pointer touch screens): 60 ms audio latency, which
// absorbs mobile frame jitter and Bluetooth output. Scaling keeps the desktop default. Any
// choice saved in Settings overrides this.
function isPhoneDefault() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const noHover = window.matchMedia('(hover: none)').matches;
  const hasTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  return coarse || (noHover && hasTouch);
}

function defaultHostSettings() {
  if (!isPhoneDefault()) return HOST_DEFAULTS;
  return { ...HOST_DEFAULTS, audioLatency: 60 };
}

const SCALES = ['fit', '1', '2', '3', '4'];
/**
 * 'sharp'  sharp bilinear: every game pixel an even block, only block edges mixed. The canvas
 *          then has a drawing buffer in device pixels and the runtime scales into it
 *          (MBR_SMOOTH=2, runtime/gfx_gl.c gfx_present; lib/fullscreen.js sizes the buffer).
 * 'pixels' nearest neighbour by CSS: at a size that is not a whole multiple, some game pixels
 *          are one screen pixel wider than others (uneven 1-pixel strokes in text).
 * 'smooth' bilinear by CSS (the settings' old "smooth": true).
 * 'upscale' sharpened Catmull-Rom by the runtime on a device-pixel buffer, as 'sharp'
 *          (MBR_SMOOTH=3): smooth curves and diagonals, crisp edges; the settings page recommends it.
 */
export const SCALINGS = ['sharp', 'pixels', 'smooth', 'upscale'];
const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

export function normalizeHostSettings(s = {}, defaults = HOST_DEFAULTS) {
  const d = defaults;
  return {
    scale: SCALES.includes(String(s.scale)) ? String(s.scale) : d.scale,
    scaling: SCALINGS.includes(s.scaling) ? s.scaling : s.smooth === true ? 'smooth' : d.scaling,
    sound: typeof s.sound === 'boolean' ? s.sound : d.sound,
    volume: clamp(Number(s.volume), 0, 1, d.volume),
    audioLatency: Math.round(clamp(Number(s.audioLatency), 10, 500, d.audioLatency)),
    gameSpeed: Math.round(clamp(Number(s.gameSpeed), 1, 1000, d.gameSpeed)),
    screenMode: s.screenMode === 'fullscreen' ? 'fullscreen' : 'windowed',
    mouse: typeof s.mouse === 'boolean' ? s.mouse : d.mouse,
  };
}

export function loadHostSettings(storage = globalThis.localStorage) {
  const d = defaultHostSettings();
  try {
    const t = storage && storage.getItem(STORAGE_KEY);
    return normalizeHostSettings(t ? JSON.parse(t) : {}, d);
  } catch {
    return normalizeHostSettings({}, d);
  }
}

export function saveHostSettings(s, storage = globalThis.localStorage) {
  const n = normalizeHostSettings(s);
  storage.setItem(STORAGE_KEY, JSON.stringify(n));
  return n;
}

/**
 * What the game page uses: stored settings, with its own URL parameters first.
 * env holds the MBR_* variables the settings add (MBR_SMOOTH=3 for the default scaling, upscale).
 * Unattended runs keep sharp pixels on a 640x480 buffer unless the URL asks otherwise: their
 * canvas captures are compared with native frames.
 */
export function pageSettings(params, stored = loadHostSettings()) {
  const unattended = !!params.get('run'); // unattended runs: exactly as before the settings page
  const s = unattended ? { ...HOST_DEFAULTS } : normalizeHostSettings(stored);
  const env = {};
  if (!unattended && !params.get('sound') && !s.sound) env.MBR_SOUND = '0';
  if (!unattended && s.gameSpeed !== HOST_DEFAULTS.gameSpeed) env.MBR_GAME_SPEED = String(s.gameSpeed);
  const scaling = SCALINGS.includes(params.get('scaling')) ? params.get('scaling')
    : params.has('smooth') ? (params.get('smooth') === '1' ? 'smooth' : 'pixels')
    : unattended ? 'pixels' : s.scaling;
  if (scaling === 'sharp') env.MBR_SMOOTH = '2';
  if (scaling === 'upscale') env.MBR_SMOOTH = '3';
  return {
    scale: params.get('scale') || s.scale,
    scaling,
    volume: s.volume,
    audioLatency: Number(params.get('audioLatency')) || s.audioLatency,
    // The player chose full screen in the launcher settings. The game runs its own full-screen
    // mode from app.cfg; lib/fullscreen.js learns of it from the runtime, not from this value.
    fullscreen: s.screenMode === 'fullscreen',
    mouse: params.has('mouse') ? params.get('mouse') === '1' : !unattended && s.mouse,
    env,
  };
}

/** The game page holds this lock while the game runs; the settings page asks for it. */
export function holdGameLock() {
  if (!globalThis.navigator || !navigator.locks) return;
  navigator.locks.request(GAME_LOCK, { mode: 'shared' }, () => new Promise(() => {})).catch(() => {});
}

export async function gameIsRunning() {
  if (!globalThis.navigator || !navigator.locks || !navigator.locks.query) return null; // unknown
  const q = await navigator.locks.query();
  return [...(q.held || []), ...(q.pending || [])].some((l) => l.name === GAME_LOCK);
}

// ------------------------------------------------------------ settings zip
// ReACT/app.cfg and ReACT/cfg.cfg (the same paths as the import page's user-area zip) plus
// mbr-settings.json with the page settings above.

export function settingsZipFiles(files, host) {
  const out = [];
  for (const name of ['app.cfg', 'cfg.cfg']) if (files[name]) out.push({ path: `ReACT/${name}`, data: files[name] });
  out.push({ path: ZIP_SETTINGS_NAME, data: new TextEncoder().encode(JSON.stringify(normalizeHostSettings(host), null, 2) + '\n') });
  return out;
}

/** Read a settings zip; every file is checked before anything is used. */
export async function parseSettingsZip(bytes) {
  const entries = await readZip(bytes, { maxTotal: 4 << 20 });
  const files = {};
  let host = null;
  for (const e of entries) {
    if (e.isDir) continue;
    const name = e.path.toLowerCase();
    if (name === 'react/app.cfg') {
      if (e.data.length !== APP_CFG_SIZE) throw new ZipError(`ReACT/app.cfg is ${e.data.length} bytes, not ${APP_CFG_SIZE}`);
      parseAppCfg(e.data);
      files['app.cfg'] = e.data;
    } else if (name === 'react/cfg.cfg') {
      if (e.data.length !== CFG_SIZE) throw new ZipError(`ReACT/cfg.cfg is ${e.data.length} bytes, not ${CFG_SIZE}`);
      if (!decodeCfgCfg(e.data).ok) throw new ZipError('ReACT/cfg.cfg fails the game\'s own checksum');
      files['cfg.cfg'] = e.data;
    } else if (name === ZIP_SETTINGS_NAME) {
      try { host = normalizeHostSettings(JSON.parse(new TextDecoder().decode(e.data))); } catch { throw new ZipError(`${ZIP_SETTINGS_NAME} is not valid JSON`); }
    }
  }
  if (!files['app.cfg'] && !files['cfg.cfg'] && !host) throw new ZipError('the zip holds no settings (ReACT/app.cfg, ReACT/cfg.cfg or mbr-settings.json)');
  return { files, host };
}
