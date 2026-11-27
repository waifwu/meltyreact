// Settings page: the original launcher's choices (app.cfg, read and written in the user
// area exactly as the game does, lib/gamecfg.js) and the browser port's own settings
// (localStorage, lib/settings-store.js). The game reads app.cfg at its next start.
//
// Test hook: window.mbSettings exposes what the buttons do:
//   await mbSettings.load()          re-read the files; resolves with the form state
//   mbSettings.state                 the form state { screenMode, colorDepth, textures, evasion, host }
//   mbSettings.set(partial)          change the form (same shape as state)
//   await mbSettings.save()          write app.cfg (and a first-start cfg.cfg if none exists)
//   await mbSettings.reset()         defaults, written at once (no confirmation)
//   await mbSettings.exportZip()     Uint8Array of the settings zip
//   await mbSettings.importZip(u8)   import a settings zip
//   await mbSettings.files()         { 'app.cfg': Uint8Array|null, 'cfg.cfg': ... } as stored now

import { mountGameFs } from './lib/vfs.js';
import { describeStorageError } from './lib/opfs.js';
import { writeZip } from './lib/zip.js';
import { isPhoneLike } from './lib/touch-controls.js';
import {
  TEXTURE_GROUPS, FIRST_START_APP_CFG, DIALOG_DEFAULT_TEXTURES, GAME_OPTIONS,
  parseAppCfg, buildAppCfg, portStartAppCfg, decodeCfgCfg, encodeCfgCfg, firstStartCfgBody, readCfgFields, newSeed,
} from './lib/gamecfg.js';
import {
  HOST_DEFAULTS, loadHostSettings, saveHostSettings, normalizeHostSettings, gameIsRunning,
  settingsZipFiles, parseSettingsZip,
} from './lib/settings-store.js';

const $ = (id) => document.getElementById(id);
const APP = 'C:\\ReACT\\app.cfg';
const CFG = 'C:\\ReACT\\cfg.cfg';

// Over the game (?embedded=1): the game page shows this page in a popup over the running game
// (lib/controls-host.js openPage). The game reads these settings only when it starts, and a
// running game writes its own copies back, so whatever is saved here ends with a restart of
// the game; Close and Esc leave without saving. Messages to the game page: close, controls
// (show the controls page instead), restart.
// on a phone the page leaves out what only a desktop has (settings.html, game.css)
if (isPhoneLike()) document.documentElement.classList.add('phone');
const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
const toGame = (action) => window.parent.postMessage({ type: 'mbr-page', action }, location.origin);

function setupEmbedded() {
  document.body.classList.add('embedded', 'has-bar');
  $('nav').hidden = true; // the game page is the parent: never load it in here
  $('embedded-note').hidden = false;
  const bar = document.createElement('div');
  bar.className = 'popup-bar';
  const state = document.createElement('p');
  state.className = 'grow';
  state.id = 'bar-state';
  const close = document.createElement('button');
  close.type = 'button';
  close.id = 'close';
  close.className = 'secondary';
  close.textContent = 'Close';
  close.addEventListener('click', () => toGame('close'));
  const save = $('save');
  save.textContent = 'Save and restart';
  save.title = 'Save, then start the game again with these settings (the match in progress ends)';
  save.setAttribute('form', 'form'); // it leaves the form for the bar
  bar.append(state, $('revert'), close, save);
  document.body.append(bar);
  $('controls-link').addEventListener('click', (e) => { e.preventDefault(); toGame('controls'); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !document.querySelector('dialog[open]')) { e.preventDefault(); toGame('close'); }
  });
}

function restartGame(text) {
  setMessage(`${text} Restarting the game…`, 'ok');
  toGame('restart');
}

let loaded = null; // { appRaw, appArea, cfgArea, cfgInfo, host }

function setMessage(text, kind = '') {
  const m = $('message');
  m.hidden = !text;
  m.textContent = text || '';
  m.className = `banner ${kind}`;
}

async function withUserFs(fn) {
  const fs = await mountGameFs({ requireComplete: false, autoFlushMs: null, cacheBytes: 0 });
  try { return await fn(fs); } finally { await fs.unmount(); }
}

async function readFile(fs, path) {
  const st = fs.stat(path);
  if (!st || st.isDir) return null;
  return { area: st.area, data: await fs.readAt(path, 0, st.size) };
}

// ------------------------------------------------------------ form <-> state

function buildTextureRows() {
  const tb = $('tex').querySelector('tbody');
  tb.textContent = '';
  for (const g of TEXTURE_GROUPS) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = g.label;
    tr.append(th);
    for (const depth of [16, 32]) {
      const td = document.createElement('td');
      td.className = 'c';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `tex-${g.key}`;
      input.value = String(depth);
      input.setAttribute('aria-label', `${g.label}: ${depth}-bit`);
      td.append(input);
      tr.append(td);
    }
    tb.append(tr);
  }
}

const radio = (name) => { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? r.value : null; };
const setRadio = (name, value) => { for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === String(value); };

function readForm() {
  const textures = {};
  for (const g of TEXTURE_GROUPS) { const v = radio(`tex-${g.key}`); textures[g.key] = v ? Number(v) : null; }
  return {
    screenMode: radio('screenMode'),
    colorDepth: radio('colorDepth') ? Number(radio('colorDepth')) : null,
    textures,
    evasion: $('evasion').checked,
    host: normalizeHostSettings({
      scale: $('scale').value, scaling: $('scaling').value, sound: $('sound').checked,
      volume: Number($('volume').value) / 100, audioLatency: Number($('audioLatency').value), gameSpeed: Number($('gameSpeed').value),
      screenMode: radio('screenMode'), mouse: $('mouse').checked,
    }),
  };
}

function writeForm(s) {
  if (s.screenMode !== undefined) setRadio('screenMode', s.screenMode);
  if (s.colorDepth !== undefined) setRadio('colorDepth', s.colorDepth);
  if (s.textures) for (const g of TEXTURE_GROUPS) if (s.textures[g.key] !== undefined) setRadio(`tex-${g.key}`, s.textures[g.key]);
  if (s.evasion !== undefined) $('evasion').checked = !!s.evasion;
  if (s.host) {
    const h = { ...readForm().host, ...s.host };
    $('scale').value = h.scale;
    $('scaling').value = h.scaling;
    $('sound').checked = h.sound;
    $('volume').value = String(Math.round(h.volume * 100));
    $('volume-out').textContent = `${Math.round(h.volume * 100)} %`;
    $('audioLatency').value = String(h.audioLatency);
    $('gameSpeed').value = String(h.gameSpeed);
    $('mouse').checked = !!h.mouse;
  }
  updateDirty();
}

function sameState(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function updateDirty() {
  if (!loaded) return;
  const dirty = !sameState(readForm(), loaded.state);
  $('save').disabled = !dirty;
  $('revert').disabled = !dirty;
  if ($('bar-state')) $('bar-state').textContent = dirty ? 'Unsaved changes' : 'No changes';
  $('volume-out').textContent = `${$('volume').value} %`;
}

// ------------------------------------------------------------ loading

const AREA_TEXT = { user: 'saved in this browser', game: 'from the imported game folder' };

async function load() {
  const r = await withUserFs(async (fs) => ({ app: await readFile(fs, APP), cfg: await readFile(fs, CFG) }));
  const host = loadHostSettings();
  let app = null, appNote;
  if (r.app) {
    try { app = parseAppCfg(r.app.data); appNote = `app.cfg ${AREA_TEXT[r.app.area] || ''}.`; }
    catch (e) { appNote = `app.cfg is damaged (${e.message}); the game will start from its defaults.`; }
  } else {
    appNote = 'No app.cfg yet: the game has not been started in this browser. These are the values the game page starts it with (32-bit colour and textures); saving writes them.';
  }
  const shown = app || parseAppCfg(portStartAppCfg());
  $('src-app').textContent = appNote;
  if (app && app.screenMode === 'fullscreen') $('src-app').textContent += ' It asks for full screen.';

  let cfgInfo = null;
  const dl = $('game-options');
  dl.textContent = '';
  if (r.cfg) {
    try {
      const d = decodeCfgCfg(r.cfg.data);
      cfgInfo = { ...readCfgFields(d.plain), ok: d.ok, seed: d.seed };
      $('src-cfg').textContent = `cfg.cfg ${AREA_TEXT[r.cfg.area] || ''}${d.ok ? '' : ', but its checksum does not match: the game will replace it with defaults'}.`;
    } catch (e) {
      $('src-cfg').textContent = `cfg.cfg is damaged (${e.message}); the game will start from its defaults.`;
    }
  } else {
    $('src-cfg').textContent = 'No cfg.cfg yet: the game uses its defaults, shown here.';
    cfgInfo = { ...readCfgFields(firstStartCfgBody()), ok: true };
  }
  if (cfgInfo) {
    for (const o of GAME_OPTIONS) {
      const v = cfgInfo.options[o.key];
      const dt = document.createElement('dt'); dt.textContent = o.label;
      const dd = document.createElement('dd'); dd.textContent = `${v.text}${v.isDefault ? ' (default)' : ''}`;
      dl.append(dt, dd);
    }
    $('controller-note').textContent = cfgInfo.controllerInputOffInLauncher
      ? 'cfg.cfg has the launcher\'s controller input switched off (the original toggles it by holding Shift as the game starts); it only matters in the original\'s launcher.'
      : '';
  }
  // Full screen survives in the page settings: the game saves "windowed" after each start.
  const screenMode = host.screenMode === 'fullscreen' ? 'fullscreen' : shown.screenMode;
  const state = {
    screenMode, colorDepth: shown.colorDepth, textures: shown.textures, evasion: shown.evasion, host: { ...host, screenMode },
  };
  loaded = { appRaw: app ? app.raw : null, appArea: r.app && r.app.area, cfgArea: r.cfg && r.cfg.area, cfgInfo, state };
  writeForm(state);
  loaded.state = readForm(); // as the form represents it
  updateDirty();
  return loaded.state;
}

// ------------------------------------------------------------ saving

// Without the browser's private storage (a private window, or a page that is neither https nor
// localhost) the game's files live in memory and end with this page (lib/vfs.js `persistent`):
// nothing written here would be there for the game. Say so instead of "Saved".
const NO_STORAGE = 'this window gives the page no storage (a private window, or a page not opened from https or localhost), so the game\u2019s settings cannot be kept';

function needStorage(fs) {
  if (!fs.persistent) throw new Error(NO_STORAGE);
}

async function writeGameFiles(fs, appBytes) {
  needStorage(fs);
  fs.writeFile(APP, appBytes);
  // A first app.cfg without a cfg.cfg would be ignored: the game resets both to its
  // defaults when cfg.cfg is missing. Write the cfg.cfg of a first start along with it.
  let wroteCfg = false;
  if (!fs.exists(CFG)) { fs.writeFile(CFG, encodeCfgCfg(firstStartCfgBody(), newSeed())); wroteCfg = true; }
  await fs.flush();
  return wroteCfg;
}

async function warnIfRunning() {
  if (embedded) { $('running').hidden = true; return false; } // the game behind the popup: it restarts after a save
  const running = await gameIsRunning();
  $('running').hidden = !running;
  return running;
}

async function save() {
  const s = readForm();
  if (!$('gameSpeed').checkValidity()) throw new Error('Game speed must be a whole number from 1 to 1000.');
  const base = loaded && loaded.appRaw ? loaded.appRaw : FIRST_START_APP_CFG;
  const bytes = buildAppCfg(s, base);
  let wroteCfg;
  try {
    wroteCfg = await withUserFs((fs) => writeGameFiles(fs, bytes));
  } catch (e) {
    if (e.message !== NO_STORAGE) throw e;
    saveHostSettings(s.host); // this page's own settings are the browser's (localStorage) and are kept
    throw new Error(`${NO_STORAGE}. This page\u2019s own settings (picture size and scaling, sound, game speed) were saved`);
  }
  saveHostSettings(s.host);
  if (embedded) { restartGame('Saved.'); return; }
  await load();
  const running = await warnIfRunning();
  setMessage(`Saved. The game uses these settings the next time it starts${wroteCfg ? ' (a first-start cfg.cfg was written with app.cfg)' : ''}.${running ? ' Close the running game first, or it will write its own settings back.' : ''}`, running ? 'error' : 'ok');
}

async function reset() {
  const bytes = portStartAppCfg(); // the port's first start: 32-bit colour and textures, windowed
  await withUserFs((fs) => writeGameFiles(fs, bytes));
  saveHostSettings(HOST_DEFAULTS);
  if (embedded) { restartGame('Defaults restored.'); return; }
  await load();
  setMessage('Defaults restored and saved. cfg.cfg (in-game options, keys, progress) was kept.', 'ok');
}

async function currentFiles() {
  return withUserFs(async (fs) => {
    const a = await readFile(fs, APP), c = await readFile(fs, CFG);
    return { 'app.cfg': a ? a.data : null, 'cfg.cfg': c ? c.data : null };
  });
}

async function exportZip() {
  return writeZip(settingsZipFiles(await currentFiles(), loadHostSettings()));
}

async function importZip(bytes) {
  const z = await parseSettingsZip(bytes);
  const names = Object.keys(z.files);
  if (names.length) {
    await withUserFs(async (fs) => {
      needStorage(fs);
      for (const n of names) fs.writeFile(`C:\\ReACT\\${n}`, z.files[n]);
      if (z.files['app.cfg'] && !fs.exists(CFG)) fs.writeFile(CFG, encodeCfgCfg(firstStartCfgBody(), newSeed()));
      await fs.flush();
    });
  }
  if (z.host) saveHostSettings(z.host);
  await load();
  return [...names, ...(z.host ? ['mbr-settings.json'] : [])];
}

function confirmDialog(text, okLabel) {
  const d = $('confirm');
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}

// ------------------------------------------------------------ wiring

async function init() {
  if (embedded) setupEmbedded();
  buildTextureRows();
  const form = $('form');
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
  // the browser's own validation stops the submit (game speed outside 1..1000): say why here too
  form.addEventListener('invalid', (ev) => {
    const label = ev.target.id === 'gameSpeed' ? 'Game speed must be a whole number from 1 to 1000' : ev.target.validationMessage;
    setMessage(`Could not save: ${label}.`, 'error');
  }, true);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    save().catch((e) => setMessage(`Could not save: ${describeStorageError(e)}`, 'error'));
  });
  $('revert').addEventListener('click', () => { writeForm(loaded.state); setMessage(''); });
  $('detail-default').addEventListener('click', () => {
    writeForm({ textures: DIALOG_DEFAULT_TEXTURES, evasion: false, host: { gameSpeed: HOST_DEFAULTS.gameSpeed } });
  });
  $('reset').addEventListener('click', async () => {
    if (!(await confirmDialog('Put the Startup Menu, Detailed configuration and browser settings back to their defaults? cfg.cfg (in-game options, keys, unlocks, records) is kept.', 'Reset'))) return;
    reset().catch((e) => setMessage(`Could not reset: ${describeStorageError(e)}`, 'error'));
  });
  $('export').addEventListener('click', async () => {
    try {
      const zip = await exportZip();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      a.download = `meltyblood-react-settings-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { setMessage(`Could not export: ${describeStorageError(e)}`, 'error'); }
  });
  $('import').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    try {
      const done = await importZip(new Uint8Array(await f.arrayBuffer()));
      if (embedded) restartGame(`Imported ${done.join(', ')} from ${f.name}.`);
      else setMessage(`Imported ${done.join(', ')} from ${f.name}.`, 'ok');
    } catch (e) { setMessage(`Could not import ${f.name}: ${e.message}`, 'error'); }
  });
  window.addEventListener('focus', () => warnIfRunning().catch(() => {}));
  await load();
  await warnIfRunning();
  document.documentElement.dataset.ready = '1';
}

window.mbSettings = {
  load, save, reset, exportZip, importZip, files: currentFiles,
  get state() { return readForm(); },
  set(partial) { writeForm(partial); return readForm(); },
};

init().catch((e) => setMessage(describeStorageError(e), 'error'));
