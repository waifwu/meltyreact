// The controls page (controls.html): keyboard keys and controller buttons for both players.
//
// Two stores, as recompiler/PROGRESS-gamepads.md explains:
//   - which controller button is which game function: the game's own cfg.cfg (lib/cfgcfg.js),
//     edited the way the original launcher's "Controller 1/2 config" dialog did;
//   - everything the game cannot express (keyboard keys, which controller is which player,
//     stick and d-pad handling): lib/controls-model.js, in localStorage.
// While a game tab runs, cfg.cfg changes go through it (lib/controls-host.js), because that tab
// holds the user area in memory and the game rewrites the file from its own memory.

import * as M from './controls-model.js';
import * as cfgcfg from './cfgcfg.js';
import { getRoot, getDir, getFileIfExists, writeWholeFile } from './opfs.js';
import { isPhoneLike } from './touch-controls.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1';
// On a phone (or over the game in its phone layout: the game page says so in the address) the
// page is about a connected controller first, and is worded for touch (controls.html, game.css).
const phone = isPhoneLike();
if (phone) document.documentElement.classList.add('phone');
const cancelHow = phone ? 'tap it again to cancel' : 'Esc cancels';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STD_NAMES = ['A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Back / Select', 'Start',
  'Left stick', 'Right stick', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];

let cfg = M.load();
let pad = null;            // { plain, seed } of cfg.cfg, or null
let padError = '';
let capture = null;        // { kind: 'key', action } | { kind: 'button', player, f } | { kind: 'dir', player, d }
const bc = (() => { try { return new BroadcastChannel(M.CHANNEL); } catch { return null; } })();

function say(text, kind = '') { const m = $('msg'); m.textContent = text; m.className = `note ${kind}`; }

// ------------------------------------------------------------ keyboard
function saveCfg() {
  M.save(cfg);
  if (bc) bc.postMessage({ type: 'config' });
  render();
}

function bindKey(action, code) {
  const old = M.keysOf(cfg, action);
  // Esc is not handed on: it stays on Pause (lib/controls-model.js, PAGE_PAUSE)
  const handed = old[0] && old[0] !== M.PAGE_PAUSE ? old[0] : null;
  let swapped = null;
  for (const { action: other } of M.allActions()) {
    if (other === action) continue;
    const ks = M.keysOf(cfg, other);
    if (!ks.includes(code)) continue;
    const rest = ks.filter((k) => k !== code);
    if (handed && !rest.includes(handed)) rest.unshift(handed);
    cfg.keys[other] = rest;
    swapped = other;
  }
  cfg.keys[action] = [code];
  saveCfg();
  say(swapped ? `${action} is now ${M.keyLabel(code)}; ${swapped} took ${handed ? M.keyLabel(handed) : 'no key'}.` : `${action} is now ${M.keyLabel(code)}.`);
}

const DIR_DEG = { UP: -90, DOWN: 90, LEFT: 180, RIGHT: 0, ArrowUp: -90, ArrowDown: 90, ArrowLeft: 180, ArrowRight: 0 };
const arrSvg = (deg, title = '') => `<svg class="mb-arr"${deg ? ` style="--r:${deg}deg"` : ''}${title ? ` aria-label="${esc(title)}"` : ' aria-hidden="true"'}><use href="#mb-arr"/></svg>`;
const btnHtml = (ch) => `<span class="mb-btn ${ch.toLowerCase()}">${ch}</span>`;

function actionHtml(id, label) {
  if (Object.hasOwn(DIR_DEG, id)) return `<span class="act-in">${arrSvg(DIR_DEG[id])}<span>${esc(label)}</span></span>`;
  if (/^[ABCD]$/.test(label)) return `<span class="act-in">${btnHtml(label)}</span>`;
  if (/^[ABCD](\+[ABCD])+$/.test(label)) {
    const parts = label.split('+').map(btnHtml).join('<span class="mb-plus" aria-hidden="true">+</span>');
    return `<span class="act-in"><span class="mb-combo">${parts}</span></span>`;
  }
  return esc(label);
}

function keyListHtml(ks) {
  if (!ks.length) return 'no key';
  return ks.map((k) => (Object.hasOwn(DIR_DEG, k) ? arrSvg(DIR_DEG[k], M.keyLabel(k)) : esc(M.keyLabel(k)))).join(', ');
}

function keyRow(action, label) {
  const ks = M.keysOf(cfg, action);
  const isDefault = !Object.prototype.hasOwnProperty.call(cfg.keys, action);
  const cap = capture && capture.kind === 'key' && capture.action === action;
  const bad = conflictSet.has(action);
  const id = action.includes('.') ? action.split('.')[1] : action;
  return `<tr><td class="act">${actionHtml(id, label)}</td><td><button type="button" class="bind${cap ? ' capturing' : ''}${bad ? ' conflict' : ''}${isDefault ? '' : ' changed'}" data-key="${action}">${cap ? 'Press a key…' : keyListHtml(ks)}</button></td>
    <td><button type="button" class="secondary small" data-clear="${action}" title="Leave without a key">Clear</button></td></tr>`;
}

let conflictSet = new Set();
function renderKeys() {
  const problems = M.conflicts(cfg);
  conflictSet = new Set(problems.filter((p) => p.level === 'error').flatMap((p) => p.actions));
  $('key-players').innerHTML = [1, 2].map((p) => `<div><h3>Player ${p}</h3><table><tbody>${M.ACTIONS.map((a) => keyRow(`P${p}.${a.id}`, a.label)).join('')}</tbody></table>
    <div class="row"><button type="button" class="secondary small" data-reset-keys="${p}">Player ${p} defaults</button></div></div>`).join('');
  $('key-global').innerHTML = keyRow('PAUSE', 'Pause (both)');
  $('problems').innerHTML = problems.map((p) => `<li class="${p.level}">${esc(p.text)}</li>`).join('');
}

// ------------------------------------------------------------ cfg.cfg (controller buttons)
async function userDir(create) {
  const root = await getRoot();
  return getDir(root, ['user', 'ReACT'], { create });
}

async function loadPad() {
  pad = null;
  padError = '';
  try {
    const dir = await userDir(false);
    const h = dir && (await getFileIfExists(dir, 'cfg.cfg'));
    if (!h) { padError = 'The game has not written its settings file (cfg.cfg) yet: start the game once, then the buttons can be set here.'; return; }
    const d = cfgcfg.decode(new Uint8Array(await (await h.getFile()).arrayBuffer()));
    if (!d.ok) { padError = 'cfg.cfg does not pass the game\'s own checks, so it is left alone.'; return; }
    pad = d;
  } catch (e) {
    padError = `cfg.cfg could not be read: ${e.message}`;
  }
}

function ask(type, body, reply, ms) {
  return new Promise((resolve) => {
    if (!bc) { resolve(null); return; }
    const id = Math.random().toString(36).slice(2);
    const t = setTimeout(() => { bc.removeEventListener('message', on); resolve(null); }, ms);
    const on = (ev) => {
      if (ev.data && ev.data.type === reply && ev.data.reply === id) { clearTimeout(t); bc.removeEventListener('message', on); resolve(ev.data); }
    };
    bc.addEventListener('message', on);
    bc.postMessage({ type, id, ...body });
  });
}

async function savePad(players) {
  const running = await ask('ping', {}, 'running', 300);
  if (running) {
    const r = await ask('padcfg', { players: players.map((p) => ({ player: p, ...cfgcfg.livePadBytes(pad.plain, p) })) }, 'padcfg-done', 3000);
    if (!r || !r.ok) throw new Error(r && r.error || 'the game tab did not answer');
    return 'the running game';
  }
  const dir = await userDir(true);
  await writeWholeFile(dir, 'cfg.cfg', cfgcfg.encode(pad.plain, pad.seed));
  return 'cfg.cfg';
}

async function assign(player, f, button) {
  const name = cfgcfg.FUNCTIONS.find((x) => x.f === f).name;
  const moved = cfgcfg.assignButton(pad.plain, player - 1, f, button);
  const where = await savePad([player - 1]);
  const movedText = moved.map((g) => cfgcfg.FUNCTIONS.find((x) => x.f === g)).filter(Boolean)
    .map((x) => `${x.name} moved to button ${pad.plain[0x10 + 10 * (player - 1) + x.f] + 1}`);
  say(`Player ${player}: ${name} is button ${button + 1}${movedText.length ? `; ${movedText.join(', ')}` : ''} (saved to ${where}).`);
}

// ------------------------------------------------------------ controllers
const prev = new Map(); // pad index -> { buttons[], axes[] }
const learnedHats = new Map(); // pad index -> axes that are hats
function pads() {
  try { return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter((g) => g && g.connected !== false); } catch { return []; }
}
const pressed = (b) => (typeof b === 'number' ? b > 0.5 : b && (b.pressed || b.value > 0.5));

function assignment(list) {
  const out = { 1: null, 2: null };
  const taken = new Set();
  for (const pass of ['id', 'auto']) {
    for (const p of [1, 2]) {
      const pc = cfg.pads[p];
      if (out[p] || pc.mode !== pass) continue;
      const g = list.find((x) => !taken.has(x.index) && (pass === 'auto' || (pc.id && x.id.includes(pc.id))));
      if (g) { out[p] = g; taken.add(g.index); }
    }
  }
  return out;
}

// a reduced copy of hle_input.c's map_pad, for the live display only
function dirsOf(g, p) {
  const d = { up: false, down: false, left: false, right: false };
  const std = g.mapping === 'standard';
  if (std) ['up', 'down', 'left', 'right'].forEach((k, i) => { if (pressed(g.buttons[12 + i])) d[k] = true; });
  else {
    // a browser reports some hats as one axis that rests outside [-1, 1] (hle_input.c learns it the same way)
    const hats = learnedHats.get(g.index) || new Set();
    g.axes.forEach((v, i) => { if (v > 1.05) hats.add(i); });
    learnedHats.set(g.index, hats);
    for (const i of hats) {
      const v = g.axes[i];
      if (v < -1.05 || v > 1.05) continue;
      const k = Math.round((v + 1) * 3.5);
      const dirs = [['up'], ['up', 'right'], ['right'], ['down', 'right'], ['down'], ['down', 'left'], ['left'], ['up', 'left']][k] || [];
      for (const x of dirs) d[x] = true;
    }
  }
  if (cfg.stick !== false && g.axes.length >= 2) {
    const x = g.axes[0], y = g.axes[1];
    if (Math.hypot(x, y) >= cfg.deadzone) {
      const s = ((Math.floor((Math.atan2(-y, x) * 180 / Math.PI + 22.5) / 45) % 8) + 8) % 8;
      const dirs = [['right'], ['up', 'right'], ['up'], ['up', 'left'], ['left'], ['down', 'left'], ['down'], ['down', 'right']][s];
      for (const k of dirs) d[k] = true;
    }
  }
  for (const [k, srcs] of Object.entries((cfg.dirs[p] || {}))) for (const s of srcs) {
    const i = parseInt(s.slice(1), 10);
    if (s[0] === 'b' && pressed(g.buttons[i])) d[k] = true;
    if (s[0] === 'a' && g.axes[i] !== undefined && (s.endsWith('-') ? g.axes[i] < -0.5 : g.axes[i] > 0.5)) d[k] = true;
  }
  if (d.up && d.down) d.up = false;
  if (d.left && d.right) d.right = false;
  return d;
}

function liveText(g, p) {
  if (!g) return 'no controller';
  const d = dirsOf(g, p);
  const num = d.down ? (d.left ? 1 : d.right ? 3 : 2) : d.up ? (d.left ? 7 : d.right ? 9 : 8) : d.left ? 4 : d.right ? 6 : 5;
  const funcs = [];
  if (pad) {
    const slots = cfgcfg.getPadConfig(pad.plain, p - 1).slots;
    for (const x of cfgcfg.FUNCTIONS) { const b = slots[x.f]; if (b < 10 && pressed(g.buttons[b])) funcs.push(x.name); }
  }
  return `direction ${num}${funcs.length ? `, ${funcs.join(' ')}` : ''}`;
}

function buttonLabel(b, g) {
  if (b >= 10) return `slot ${b + 1} (no button)`;
  return `Button ${b + 1}${g && g.mapping === 'standard' ? ` (${STD_NAMES[b]})` : ''}`;
}

function renderPads() {
  const list = pads();
  const who = assignment(list);
  $('pad-list').innerHTML = list.length ? list.map((g) => {
    const p = who[1] === g ? 'player 1' : who[2] === g ? 'player 2' : 'not used';
    return `<li><b>${esc(g.id)}</b> <span class="muted">(${g.mapping === 'standard' ? 'standard layout' : 'non-standard layout'}, ${g.buttons.length} buttons, ${g.axes.length} axes): ${p}</span></li>`;
  }).join('') : '<li class="muted">None.</li>';
  const ids = [...new Set(list.map((g) => g.id))];
  $('pad-players').innerHTML = [1, 2].map((p) => {
    const pc = cfg.pads[p];
    const opts = [['auto', 'The next free controller'], ['none', 'None (keyboard only)'], ...ids.map((id) => [`id:${id}`, id])];
    if (pc.mode === 'id' && pc.id && !ids.includes(pc.id)) opts.push([`id:${pc.id}`, `${pc.id} (not connected)`]);
    const cur = pc.mode === 'id' ? `id:${pc.id}` : pc.mode;
    const g = who[p];
    let rows = '';
    if (pad) {
      const pcfg = cfgcfg.getPadConfig(pad.plain, p - 1);
      rows = cfgcfg.FUNCTIONS.map((x) => {
        const cap = capture && capture.kind === 'button' && capture.player === p && capture.f === x.f;
        const macro = x.f >= 4 && x.f <= 6 ? `<label class="inline note"><input type="checkbox" data-macro="${p}:${x.f - 4}" ${pcfg.macrosOff[x.f - 4] ? 'checked' : ''}> do not use</label>` : '';
        return `<tr><td class="act">${actionHtml(x.name, x.name)}</td><td><button type="button" class="bind${cap ? ' capturing' : ''}" data-btn="${p}:${x.f}">${cap ? 'Press a button…' : esc(buttonLabel(pcfg.slots[x.f], g))}</button></td><td>${macro}</td></tr>`;
      }).join('');
    }
    const dirs = cfg.dirs[p] || {};
    const dirRows = ['up', 'down', 'left', 'right'].map((d) => {
      const cap = capture && capture.kind === 'dir' && capture.player === p && capture.d === d;
      const srcs = (dirs[d] || []).map((s) => (s[0] === 'b' ? `button ${parseInt(s.slice(1), 10) + 1}` : `axis ${parseInt(s.slice(1), 10) + 1} ${s.endsWith('-') ? '−' : '+'}`));
      return `<button type="button" class="bind small${cap ? ' capturing' : ''}" data-dir="${p}:${d}">${cap ? 'Press…' : `${d}: ${esc(srcs.join(', ') || 'automatic')}`}</button>`;
    }).join(' ');
    return `<div><h3>Player ${p}</h3>
      <div class="row"><label>Controller <select data-assign="${p}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
      <p class="live" id="live-${p}">${esc(liveText(g, p))}</p>
      ${pad ? `<table><tbody>${rows}</tbody></table><div class="row"><button type="button" class="secondary small" data-reset-pad="${p}">Default buttons</button></div>` : `<p class="warn">${esc(padError)}</p>`}
      <details><summary>D-pad of a non-standard controller</summary><p class="note">Only needed when the d-pad does not move the character: click a direction, then press it on the controller.</p>
      <div class="row">${dirRows}</div><button type="button" class="secondary small" data-clear-dirs="${p}">Automatic</button></details></div>`;
  }).join('');
}

function render() {
  renderKeys();
  if (!$('pads').hidden) renderPads();
  $('stick').checked = cfg.stick !== false;
  $('deadzone').value = cfg.deadzone;
  $('deadzone-v').textContent = Number(cfg.deadzone).toFixed(2);
  $('text').textContent = M.toRuntimeText(cfg);
}

// the controller poll: captures and the live display
function poll() {
  const list = pads();
  if (capture && (capture.kind === 'button' || capture.kind === 'dir')) {
    for (const g of list) {
      const was = prev.get(g.index);
      if (!was) continue;
      for (let b = 0; b < g.buttons.length; b++) {
        if (!pressed(g.buttons[b]) || pressed(was.buttons[b])) continue;
        onPadInput(g, { button: b });
        break;
      }
      if (capture && capture.kind === 'dir') {
        for (let a = 0; a < g.axes.length; a++) {
          const v = g.axes[a], w = was.axes[a];
          if (Math.abs(v) > 1.05 || Math.abs(w) > 1.05) continue;
          if (Math.abs(w) < 0.3 && Math.abs(v) > 0.6) { onPadInput(g, { axis: a, sign: v < 0 ? '-' : '+' }); break; }
        }
      }
    }
  }
  for (const g of list) prev.set(g.index, { buttons: g.buttons.map((b) => (pressed(b) ? 1 : 0)), axes: Array.from(g.axes) });
  if (!$('pads').hidden) {
    const who = assignment(list);
    for (const p of [1, 2]) { const el = $(`live-${p}`); if (el) el.textContent = liveText(who[p], p); }
    if (list.length !== lastCount) { lastCount = list.length; renderPads(); }
  }
  requestAnimationFrame(poll);
}
let lastCount = -1;

async function onPadInput(g, what) {
  const c = capture;
  capture = null;
  try {
    if (c.kind === 'button') {
      if (what.button === undefined) return;
      if (g.mapping === 'standard' && what.button >= 12 && what.button <= 15) { say('That is the d-pad, which moves the character; press a button.', 'warn'); return; }
      if (what.button >= cfgcfg.GAME_BUTTONS) { say(`The game sees only the first ten buttons of a controller; button ${what.button + 1} cannot be used.`, 'warn'); return; }
      await assign(c.player, c.f, what.button);
    } else {
      const s = what.button !== undefined ? `b${what.button}` : `a${what.axis}${what.sign}`;
      const dirs = cfg.dirs[c.player] = { ...(cfg.dirs[c.player] || {}) };
      dirs[c.d] = [s];
      saveCfg();
      say(`Player ${c.player}: ${c.d} also comes from ${what.button !== undefined ? `button ${what.button + 1}` : `axis ${what.axis + 1} ${what.sign}`}.`);
    }
  } catch (e) { say(`Not saved: ${e.message}`, 'warn'); }
  finally { render(); }
}

// ------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, input');
  if (!t) return;
  const d = t.dataset;
  // a second click on what is waiting for a key or a button gives the wait up: a phone has no Esc
  if (t.classList.contains('capturing')) { capture = null; say('Cancelled.'); render(); return; }
  if (d.key) { capture = { kind: 'key', action: d.key }; say(phone ? `Press the new key for ${d.key} (${cancelHow}).` : `Press the new key for ${d.key}, or Esc to cancel.`); render(); }
  else if (d.clear) { cfg.keys[d.clear] = []; saveCfg(); say(`${d.clear} has no key now.`); }
  else if (d.resetKeys) { for (const k of Object.keys(cfg.keys)) if (k.startsWith(`P${d.resetKeys}.`)) delete cfg.keys[k]; saveCfg(); say(`Player ${d.resetKeys} has the default keys again.`); }
  else if (d.btn) { const [p, f] = d.btn.split(':').map(Number); capture = { kind: 'button', player: p, f }; say(`Press the button on the controller (${cancelHow}).`); render(); }
  else if (d.dir) { const [p, dd] = d.dir.split(':'); capture = { kind: 'dir', player: Number(p), d: dd }; say(`Press ${dd} on the controller (${cancelHow}).`); render(); }
  else if (d.clearDirs) { delete cfg.dirs[d.clearDirs]; saveCfg(); }
  else if (d.resetPad) {
    const p = Number(d.resetPad) - 1;
    cfgcfg.resetPadConfig(pad.plain, p);
    for (let i = 0; i < 3; i++) cfgcfg.setMacroOff(pad.plain, p, i, false);
    try { say(`Player ${p + 1}: default buttons (saved to ${await savePad([p])}).`); } catch (err) { say(`Not saved: ${err.message}`, 'warn'); }
    render();
  } else if (d.macro) {
    const [p, i] = d.macro.split(':').map(Number);
    cfgcfg.setMacroOff(pad.plain, p - 1, i, t.checked);
    try { await savePad([p - 1]); } catch (err) { say(`Not saved: ${err.message}`, 'warn'); }
  } else if (t.id === 'reset-keys') { cfg.keys = {}; saveCfg(); say('All keys are back to their defaults.'); }
  else if (t.id === 'close') close();
  else if (t.id === 'tab-keys' || t.id === 'tab-pads') {
    const pads = t.id === 'tab-pads';
    $('tab-keys').setAttribute('aria-selected', String(!pads));
    $('tab-pads').setAttribute('aria-selected', String(pads));
    $('keys').hidden = pads;
    $('pads').hidden = !pads;
    if (pads) { await loadPad(); }
    render();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.assign) {
    const v = t.value;
    cfg.pads[t.dataset.assign] = v.startsWith('id:') ? { mode: 'id', id: v.slice(3) } : { mode: v };
    saveCfg();
  } else if (t.id === 'stick') { cfg.stick = t.checked; saveCfg(); }
  else if (t.id === 'deadzone') { cfg.deadzone = Number(t.value); saveCfg(); }
});

window.addEventListener('keydown', (e) => {
  if (!capture) {
    if (embedded && e.code === 'Escape') close();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') { capture = null; say('Cancelled.'); render(); return; }
  if (capture.kind !== 'key') return;
  if (M.RESERVED.has(e.code)) { say(`${M.keyLabel(e.code)} stays with the browser; choose another key.`, 'warn'); return; }
  if (M.DIK[e.code] === undefined) { say(`${e.code} is not a key the game can be given; choose another.`, 'warn'); return; }
  const action = capture.action;
  capture = null;
  bindKey(action, e.code);
  if (M.GAME_OTHER_KEYS[e.code]) say(`${$('msg').textContent} Note: ${M.GAME_OTHER_KEYS[e.code]}.`);
}, true);

window.addEventListener('storage', (e) => { if (e.key === M.STORAGE_KEY) { cfg = M.load(); render(); } });

function close() {
  try {
    const dlg = window.parent !== window && window.parent.document.querySelector('dialog.controls-overlay');
    if (dlg) { dlg.close(); return; }
  } catch { /* not same-origin */ }
  if (bc) bc.postMessage({ type: 'close' });
}

if (embedded) { document.body.classList.add('embedded'); $('close').hidden = false; $('back').hidden = true; }
if (params.get('tab') === 'pads' || (phone && !params.get('tab'))) $('tab-pads').click();
render();
requestAnimationFrame(poll);
