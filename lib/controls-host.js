// The game page's side of the controls (one call from play.js: attachControls).
//
// - Hands the controls configuration (lib/controls-model.js, localStorage) to the runtime as
//   text, at start and whenever the controls page changes it; the runtime takes it at the next
//   frame boundary (hle_input.c, js_controls_take).
// - Applies controller button assignments made while the game runs: the runtime writes them
//   into the game's memory at a frame boundary, as the original launcher did before start-up,
//   and this page rewrites cfg.cfg in its own copy of the user area, so the file and the game
//   agree whichever saves last (lib/cfgcfg.js).
// - Answers the controls page, which asks whether a game is running before it writes cfg.cfg.
// - Adds a "Controls" button that opens the controls page over the game; game input is
//   suspended while it is open. The other pages open over the game the same way; the music
//   page also pauses the game (host.pause, lib/pause.js), and on a phone, where a page covers
//   the whole screen, every page does.
// - Test aid: a run configuration's `pads` timeline replaces the Gamepad API.

import { CHANNEL, STORAGE_KEY, load, pageRuntimeText } from './controls-model.js';
import * as cfgcfg from './cfgcfg.js';
import { touchRuntimeText } from './touch-controls.js';

export function attachControls(host, { fs, guestDir, unattended, runCfg = {} }) {
  host.padcfgQueue = [];
  const cfgPath = `${guestDir}\\cfg.cfg`;

  // configuration text for the runtime; Esc pauses instead of quitting the game (PAGE_PAUSE).
  // In the phone layout (body.mobile, play.js layoutCanvas) the touch buttons' own keys are
  // bound too (lib/touch-controls.js), and again when the layout changes to or from it.
  const touchLayout = () => document.body.classList.contains('mobile');
  const push = () => {
    try {
      const c = load();
      host.controlsText = pageRuntimeText(c) + (touchLayout() ? touchRuntimeText(c) : '');
    } catch (e) { console.warn('[controls]', e); }
  };
  if (typeof runCfg.controls === 'string') host.controlsText = runCfg.controls;
  else if (!unattended) push();
  if (!unattended) {
    window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) push(); });
    if (typeof runCfg.controls !== 'string' && typeof MutationObserver === 'function') {
      let wasTouch = touchLayout();
      new MutationObserver(() => {
        if (touchLayout() !== wasTouch) { wasTouch = !wasTouch; push(); }
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // injected gamepad states (tests): the state stamped F is what the latch of frame F reads;
  // the runtime latches before it reports the frame, so the frame being latched is frames + 1
  if (Array.isArray(runCfg.pads)) {
    const timeline = runCfg.pads.slice().sort((a, b) => a.frame - b.frame);
    host.getGamepads = () => {
      const now = (host.frames | 0) + 1;
      let cur = [];
      for (const t of timeline) { if (t.frame <= now) cur = t.pads || []; else break; }
      return cur.map((p, i) => p && {
        id: p.id || `injected pad ${i}`, index: i, connected: p.connected !== false, mapping: p.mapping ?? 'standard',
        buttons: (p.buttons || []).map((v) => (typeof v === 'number' ? { value: v, pressed: v > 0.5 } : v)),
        axes: p.axes || [],
      });
    };
  }

  // live button assignments at given frames (tests): [{ frame, player, slots, menu, macros }]
  if (Array.isArray(runCfg.padcfg)) {
    const due = runCfg.padcfg.slice().sort((a, b) => a.frame - b.frame);
    const onFrame = host.onFrame;
    host.onFrame = (frame, ...rest) => {
      while (due.length && due[0].frame <= frame) applyPadcfg({ players: [due.shift()] });
      onFrame(frame, ...rest);
    };
  }

  // Pages over the game: the controls, settings and guide pages, one at a time, each in a
  // modal <dialog> (class `<page>-overlay`; controls-page.js closes its own by that name).
  // Game input is suspended while one is open; the keyboard goes to the page in it.
  let overlay = null;
  const realGamepads = host.getGamepads;
  const suspend = (on) => {
    host.getGamepads = on ? () => [] : realGamepads;
    if (on) window.dispatchEvent(new Event('blur')); // the keyboard handler releases every key on blur
  };
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const closeOverlay = (dlg, instant = false) => {
    if (!dlg || !dlg.open) return;
    if (instant || reduceMotion()) { dlg.close(); return; }
    if (dlg.classList.contains('closing')) return;
    dlg.classList.add('closing');
    setTimeout(() => { if (dlg.open) dlg.close(); }, 165);
  };
  const openPage = (page) => {
    if (overlay) {
      if (overlay.dataset.page === page && !overlay.classList.contains('closing')) return;
      closeOverlay(overlay, true); // its close event comes later and leaves the new one alone
    }
    const dlg = document.createElement('dialog');
    dlg.className = `page-overlay ${page}-overlay`;
    dlg.dataset.page = page;
    const phoneOverlay = document.body.classList.contains('mobile') || window.innerWidth <= 720 || window.innerHeight <= 520;
    dlg.style.cssText = phoneOverlay
      ? 'padding:0;border:0;margin:0;max-width:none;max-height:none;width:100vw;height:100dvh;background:#1c0307;overflow:hidden'
      : 'padding:0;border:0;max-width:none;width:min(980px,96vw);height:min(760px,92vh);background:transparent;overflow:visible';
    const frame = document.createElement('iframe');
    // touch: whether the game is in its phone layout, so the page words itself for one (game.css html.phone)
    const touch = document.body.classList.contains('mobile') ? 1 : 0;
    frame.src = new URL(`../${page}.html?embedded=1&touch=${touch}`, import.meta.url).href;
    frame.title = { settings: 'Settings', guide: 'Guide', music: 'Music' }[page] || 'Controls';
    frame.style.cssText = phoneOverlay
      ? 'display:block;width:100%;height:100%;border:0;border-radius:0;background:#1c0307'
      : 'display:block;width:100%;height:100%;border:0;border-radius:8px;background:#1c0307';
    dlg.append(frame);
    document.body.append(dlg);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeOverlay(dlg);
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) closeOverlay(dlg);
    });
    // the music page pauses the game while it is open (its own close, whichever page follows).
    // On a phone every page does: it covers the whole screen there, and the game's own Pause
    // works in some modes only, so a match left running behind it was lost unseen.
    const pauses = host.pause && (page === 'music' || document.body.classList.contains('mobile'));
    if (pauses) host.pause.hold();
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (pauses) host.pause.release();
      if (overlay !== dlg) return;
      overlay = null;
      suspend(false);
      $canvas()?.focus();
    });
    overlay = dlg;
    suspend(true);
    dlg.showModal();
    frame.addEventListener('load', () => frame.contentWindow.focus());
  };
  const open = () => openPage('controls');
  const openSettings = () => openPage('settings');
  const openGuide = () => openPage('guide');
  const openMusic = () => openPage('music');
  // from the page in the overlay (settings.js, guide.js, music.js): close it, show the controls page instead, or
  // restart the game, which reads its settings only when it starts. A plain reload: flushing
  // the game's files first could write its own copy of app.cfg over the one just saved.
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (e.origin !== location.origin || m.type !== 'mbr-page' || !overlay) return;
    const frame = overlay.querySelector('iframe');
    if (!frame || e.source !== frame.contentWindow) return;
    if (m.action === 'close') closeOverlay(overlay);
    else if (m.action === 'controls') open();
    else if (m.action === 'restart') { host.restarting = true; location.reload(); } // restarting: play.js writes nothing on the way out
  });
  const $canvas = () => document.getElementById('canvas');
  if (!unattended) {
    const bar = document.getElementById('actions') || document.getElementById('bar'); // the game page's button strip
    if (bar) {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = 'controls-button';
      b.textContent = 'Controls';
      b.title = 'Keyboard and controller assignments';
      b.addEventListener('click', open);
      // before the sound button: its label shrinks when the first click starts the sound, and a
      // button under it would move away from the pointer between that press and the click
      bar.insertBefore(b, bar.querySelector(':scope > #sound'));
    }
  }

  // messages from the controls page (standalone tab or the overlay)
  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch { bc = null; }
  if (bc && !unattended) {
    bc.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'ping') bc.postMessage({ type: 'running', reply: m.id });
      else if (m.type === 'config') push();
      else if (m.type === 'close' && overlay && overlay.dataset.page === 'controls') closeOverlay(overlay);
      else if (m.type === 'padcfg') {
        let ok = false, error = null;
        try { ok = applyPadcfg(m); } catch (e) { error = e.message; }
        bc.postMessage({ type: 'padcfg-done', reply: m.id, ok, error });
      }
    };
  }

  // m: { players: [{ player (0-based), slots[10], menu[2], macros }] }
  function applyPadcfg(m) {
    let file = null;
    try { file = fs.readAt(cfgPath, 0, fs.size(cfgPath)); } catch { file = null; }
    const write = (bytes) => fs.writeFile(cfgPath, bytes);
    const apply = (bytes) => {
      const d = cfgcfg.decode(bytes);
      if (!d.ok) throw new Error('cfg.cfg does not pass its own checks; not changed');
      for (const p of m.players) {
        const base = 0x9e2fd0 - cfgcfg.GUEST_BASE + 10 * p.player;
        for (let i = 0; i < 10; i++) d.plain[base + i] = p.slots[i];
        d.plain[0x9e2ff8 - cfgcfg.GUEST_BASE + 2 * p.player] = p.menu[0];
        d.plain[0x9e2ff9 - cfgcfg.GUEST_BASE + 2 * p.player] = p.menu[1];
        const mo = 0xa46174 - cfgcfg.GUEST_BASE + p.player;
        d.plain[mo] = (d.plain[mo] & ~7) | (p.macros & 7);
      }
      write(cfgcfg.encode(d.plain, d.seed));
    };
    for (const p of m.players) host.padcfgQueue.push(p);
    if (file && typeof file.then === 'function') file.then(apply).catch((e) => console.warn('[controls] cfg.cfg', e));
    else if (file) apply(file);
    return true;
  }

  return { open, openSettings, openGuide, openMusic };
}
