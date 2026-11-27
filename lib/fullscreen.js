// Fullscreen for the game page (recompiler/PROGRESS-fullscreen.md, web/README.md "Fullscreen").
//
// The stage element (the canvas and its messages) goes fullscreen through the Fullscreen API.
// A page may only do that during a user gesture, so it happens on the button, on Alt+Enter,
// or, when the game itself is set to full screen (its launcher setting, app.cfg), on the
// first click or key press after the game takes DirectDraw exclusive mode. The game never
// learns whether the page is fullscreen: its state does not depend on it.
//
// CSS gives the canvas its size, aspect-correct, and with integer=1 only whole multiples of
// the device's pixels. How the picture is enlarged to it (`scaling`, lib/settings-store.js):
//   'sharp'  the drawing buffer gets the canvas's size in device pixels (ResizeObserver's
//            device-pixel-content-box where the browser has it, else CSS size x devicePixelRatio)
//            and the runtime scales the frame into it (MBR_SMOOTH=2, gfx_present);
//   'upscale' the same buffer, scaled by the runtime's sharpened Catmull-Rom (MBR_SMOOTH=3);
//   'pixels' a 640x480 drawing buffer that CSS scales with image-rendering: pixelated;
//   'smooth' the same, scaled bilinear.
// The pointer is hidden after 2 s without movement over the stage.
//
// Escape: in Chromium the page asks for Keyboard Lock on Escape while fullscreen, so a short
// press reaches the game, where the page makes it Pause (lib/controls-model.js, PAGE_PAUSE: the
// original quits on Esc), and holding Escape leaves fullscreen (the browser says so). Elsewhere
// Escape leaves fullscreen at once and the game does not get it. Every change of fullscreen
// releases all keys, so none stays held.
//
// URL parameters read here:
//   integer=1            scale by whole multiples only (windowed "fit" layout and fullscreen)
//   smooth=1             bilinear scaling, when the caller passes no `scaling` (test pages)
//   fullscreen=off       never enter fullscreen by itself when the game is set to full screen
//   escape=browser       no Keyboard Lock: Escape leaves fullscreen at once

const W = 640, H = 480;

function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

export function fullscreenAvailable(el = document.documentElement) {
  return !!(el.requestFullscreen || el.webkitRequestFullscreen) && document.fullscreenEnabled !== false;
}

// Size of the canvas in CSS pixels to fit availW x availH, aspect-correct; with `integer`,
// a whole multiple of 640x480 in device pixels when at least 1x fits.
export function fitSize(availW, availH, { integer = false, dpr = window.devicePixelRatio || 1 } = {}) {
  if (integer) {
    const k = Math.floor(Math.min(availW * dpr / W, availH * dpr / H));
    if (k >= 1) return { w: W * k / dpr, h: H * k / dpr, k };
  }
  const w = Math.min(availW, availH * W / H);
  return { w, h: w * H / W, k: 0 };
}

export function setupFullscreen({ stage, canvas, button, relayout, params = new URLSearchParams(location.search), auto = true, scaling }) {
  const integer = params.get('integer') === '1';
  const mode = scaling || (params.get('smooth') === '1' ? 'smooth' : 'pixels');
  const sharp = mode === 'sharp' || mode === 'upscale'; // the runtime scales into a device-pixel buffer
  const follow = auto && params.get('fullscreen') !== 'off';
  const lockEscape = params.get('escape') !== 'browser';
  const state = { game: null, autoTried: false, autoEntered: false, locked: false };

  const style = document.createElement('style');
  style.textContent = `
    .mbr-fs:fullscreen { background: #000; padding: 0; margin: 0; gap: 0;
      display: flex; flex-direction: column; justify-content: center; align-items: center; width: 100vw; height: 100vh; }
    .mbr-fs:-webkit-full-screen { background: #000; padding: 0; margin: 0; gap: 0;
      display: flex; flex-direction: column; justify-content: center; align-items: center; width: 100vw; height: 100vh; }
    .mbr-fs:fullscreen #message:not(.error) { display: none; }
    .mbr-fs.mbr-idle, .mbr-fs.mbr-idle canvas { cursor: none; }
    #fullscreen.suggest { border-color: currentColor; font-weight: 600; }`;
  document.head.append(style);
  stage.classList.add('mbr-fs');

  const releaseKeys = () => window.dispatchEvent(new Event('blur')); // host_web.c clears its key table on blur

  // sharp: the drawing buffer follows the canvas's device pixels (capped at 2x on phones so
  // 3x Retina displays don't burn >2x extra fragment fill-rate on a 640x480 game)
  let exactSize = false;
  const mobileDprCap = () => document.body.classList.contains('mobile');
  const sizeBuffer = (w, h) => {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  if (sharp && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const d = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
        if (d) {
          exactSize = true;
          const rawDpr = window.devicePixelRatio || 1;
          const factor = mobileDprCap() && rawDpr > 2 ? 2 / rawDpr : 1;
          sizeBuffer(d.inlineSize * factor, d.blockSize * factor);
        }
      }
    });
    try { ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { ro.disconnect(); } // Safari: no such box
  }
  // a new devicePixelRatio without a resize (the window moved to another display)
  const watchRatio = () => {
    if (!sharp || !window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (mq.addEventListener) mq.addEventListener('change', () => { layout(); watchRatio(); }, { once: true });
  };

  function layout() {
    if (fsElement() === stage) {
      if (document.body.classList.contains('mobile')) {
        relayout();
      } else {
        const { w, h } = fitSize(stage.clientWidth || window.innerWidth, stage.clientHeight || window.innerHeight, { integer });
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    } else {
      relayout();
      if (integer && (params.get('scale') || 'fit') === 'fit') {
        const cur = parseFloat(canvas.style.width) || W;
        const { w, h, k } = fitSize(cur, cur * H / W, { integer });
        if (k) { canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
      }
    }
    canvas.style.imageRendering = mode === 'smooth' ? 'auto' : 'pixelated';
    if (sharp) {
      // whole device pixels for the CSS size, and the buffer to match (capped at 2x on phones)
      const rawDpr = window.devicePixelRatio || 1;
      const capDpr = mobileDprCap() ? Math.min(rawDpr, 2) : rawDpr;
      const cssW = parseFloat(canvas.style.width) || W;
      const cssH = parseFloat(canvas.style.height) || H;
      const bw = Math.max(1, Math.round(cssW * capDpr));
      const bh = Math.max(1, Math.round(cssH * capDpr));
      if (capDpr === rawDpr) {
        canvas.style.width = `${bw / rawDpr}px`;
        canvas.style.height = `${bh / rawDpr}px`;
      }
      if (!exactSize) sizeBuffer(bw, bh);
    }
  }

  async function enter() {
    if (fsElement()) return;
    try {
      if (stage.requestFullscreen) await stage.requestFullscreen({ navigationUI: 'hide' });
      else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    } catch (e) {
      console.warn(`[fullscreen] ${e.message}`);
    }
  }
  async function exit() {
    if (!fsElement()) return;
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) { console.warn(`[fullscreen] ${e.message}`); }
  }
  const toggle = () => (fsElement() ? exit() : enter());

  function updateButton() {
    if (!button) return;
    const on = !!fsElement();
    button.hidden = !fullscreenAvailable(stage);
    button.textContent = on ? 'Leave full screen (Alt+Enter)' : 'Full screen (Alt+Enter)';
    button.classList.toggle('suggest', !on && !!(state.game && state.game.exclusive));
    button.title = state.game && state.game.exclusive
      ? `The game is set to full screen (${state.game.w}x${state.game.h}, ${state.game.bpp}-bit)`
      : 'Show the game on the whole screen';
  }

  async function onChange() {
    const on = fsElement() === stage;
    releaseKeys();
    if (on && lockEscape && navigator.keyboard && navigator.keyboard.lock) {
      try { await navigator.keyboard.lock(['Escape']); state.locked = true; } catch { state.locked = false; }
    } else if (!on && state.locked) {
      navigator.keyboard.unlock();
      state.locked = false;
    }
    if (!on) state.autoEntered = false;
    layout();
    updateButton();
  }

  // Alt+Enter, before host_web.c's listener (which ignores Alt combinations anyway)
  const onKey = (e) => {
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) toggle();
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);

  // the game is set to full screen: enter on the first gesture (once; leaving it is respected)
  const onGesture = (e) => {
    if (!follow || state.autoTried || !state.game || !state.game.exclusive || fsElement()) return;
    if (e.type === 'keydown' && (e.code === 'Escape' || e.altKey || e.ctrlKey || e.metaKey)) return;
    if (button && e.target === button) return; // the button does it itself
    state.autoTried = true;
    state.autoEntered = true;
    enter();
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  // the pointer: hidden after 2 s without movement over the stage
  let idleTimer = 0;
  const wake = () => {
    stage.classList.remove('mbr-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stage.classList.add('mbr-idle'), 2000);
  };
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  wake();

  if (button) button.addEventListener('click', () => toggle());
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  window.addEventListener('resize', layout);
  layout();
  watchRatio();
  updateButton();

  return {
    // from the wasm (runtime/host_display.c): the game took or left exclusive full-screen mode
    gameMode(exclusive, w, h, bpp) {
      state.game = { exclusive, w, h, bpp };
      if (!exclusive && state.autoEntered) exit();
      updateButton();
    },
    enter, exit, toggle, layout, scaling: mode,
    get active() { return fsElement() === stage; },
    get gameState() { return state.game; },
  };
}
