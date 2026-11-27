// The loading screen of a start: it stands in the canvas's place (play.html #loading) from the
// page's first paint until the game has drawn its first frames and no read of the game's is waiting
// for the network. Everything the game waits for before its title screen (about 60 MB of archive
// data on a first visit, after the 3-4 MB build) is read at its first two frames, before any
// picture: without this screen the canvas stays black and then freezes on the first frame for as
// long as that takes.
//
// It comes back for a fight's load (again(), from play.js fightLoading): the game's own loading
// screen is an animation of 4.6 s that ends in black, and the game then holds that black
// picture until its loader thread has read both characters and the stage, 60 MB and more: two
// seconds on a fast line and a minute on a slow one, with nothing to tell it from a hang. The
// screen then shows what has been downloaded since that load began. Other loads (menus, Story's
// scenes) are not covered.
//
// It shows the page's current step (the status text, until the game runs) and how much has been
// downloaded so far: build and game data, from Resource Timing, so a request counts once it
// completes.

const COUNTED = /\/(data|build)\//;
const SETTLE_MS = 300; // the game must stay clear of waiting reads this long before the screen goes

export function createLoadingScreen({ skip = false } = {}) {
  const root = document.getElementById('loading');
  const none = { track() {}, finish() {}, again() {}, away() {}, count: () => 0 };
  if (!root) return none;
  if (skip) { root.hidden = true; return none; }
  const stepEl = root.querySelector('.loading-step');
  const bytesEl = root.querySelector('.loading-bytes');
  const statusEl = document.getElementById('status');
  const messageEl = document.getElementById('message');
  let bytes = 0, from = 0, finished = false, poll = 0, gameRunning = false, shown = true, hideTimer = 0;
  const cleanups = [];

  const setStep = (text) => { if (text && stepEl.textContent !== text) stepEl.textContent = text; };
  // `from`: what had been downloaded when the load on show began (0 for the start)
  const showBytes = () => { bytesEl.textContent = bytes > from ? `${((bytes - from) / 1048576).toFixed(1)} MB downloaded` : ''; };

  // counted for as long as the page lives: a fight's load shows what arrived since it began
  if (typeof PerformanceObserver === 'function') {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (COUNTED.test(e.name)) bytes += e.encodedBodySize || e.transferSize || 0;
        if (shown) showBytes();
      });
      po.observe({ type: 'resource', buffered: true });
    } catch { /* no byte count: the step and the moving bar still show */ }
  }

  // the page's steps until the game runs ('Loading game bundle…', 'Loading the game build…',
  // 'Starting…'); an error banner or a stopped game ends the screen so the message is seen
  const watch = (el, opts, fn) => {
    if (!el || typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(fn);
    mo.observe(el, opts);
    cleanups.push(() => mo.disconnect());
  };
  const onStatus = () => {
    const t = statusEl.textContent.trim();
    if (/^(Stopped|Game closed)/.test(t) || /error/i.test(t)) finish();
    else if (!gameRunning && t && !/\bfps\b/.test(t)) setStep(t);
  };
  watch(statusEl, { childList: true, characterData: true, subtree: true }, onStatus);
  watch(messageEl, { attributes: true, attributeFilter: ['hidden', 'class'] }, () => {
    if (!messageEl.hidden && messageEl.classList.contains('error')) finish();
  });
  if (statusEl) onStatus();

  /**
   * state() -> { frames, pending }: frames the game has presented and its reads waiting for the
   * network (play.js host.frames, host.readsPending). The screen goes once frames >= 2 and
   * pending stays 0 for SETTLE_MS.
   */
  function track(state) {
    if (finished) return;
    gameRunning = true;
    setStep('Loading the title screen…');
    let clearSince = 0;
    poll = setInterval(() => {
      const { frames, pending } = state();
      if (frames >= 2 && pending === 0) {
        const now = performance.now();
        if (!clearSince) clearSince = now;
        else if (now - clearSince >= SETTLE_MS) finish();
      } else clearSince = 0;
    }, 50);
  }

  // fades out (play.html), then out of the way until again()
  function away() {
    if (!shown) return;
    shown = false;
    root.setAttribute('aria-busy', 'false');
    root.classList.add('done');
    const remove = () => { if (!shown) root.hidden = true; };
    root.addEventListener('transitionend', remove, { once: true });
    clearTimeout(hideTimer);
    hideTimer = setTimeout(remove, 600); // no transition (reduced motion, hidden tab)
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    for (const c of cleanups) c();
    away();
  }

  /**
   * Show the screen again for a later load. It counts what has been downloaded since `since`,
   * a value count() gave when that load began (default: from now on).
   */
  function again(step, since = bytes) {
    if (!finished || shown) return; // the start's own screen is still up, or this one already is
    shown = true;
    clearTimeout(hideTimer);
    from = since;
    stepEl.textContent = step;
    showBytes();
    root.hidden = false;
    root.setAttribute('aria-busy', 'true');
    void root.offsetWidth; // the fade in starts from the hidden state's opacity
    root.classList.remove('done');
  }

  return { track, finish, again, away, count: () => bytes };
}
