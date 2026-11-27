// Pausing the game page: while the music page is open over it and, on a phone, while any page
// or the menu drawer is (lib/controls-host.js, play.js wireMobileUi).
//
// The game already pauses in a hidden tab: every frame ends by waiting for a
// requestAnimationFrame callback (recompiler/runtime/host_web.c, js_host_frame_wait), and a
// hidden tab gets none. A pause does the same in a visible tab: while it lasts, this page's
// requestAnimationFrame callbacks are held, and handed to the browser when it ends. The game
// stops at its next frame and goes on as it does when its tab comes back (the frame cadence
// restarts after a stall of more than 250 ms). The sound output stops with it (lib/audio.js,
// hold). The page's own layout callbacks wait too, and run when the game goes on.
//
// What runs without a frame keeps running, as in a hidden tab: loading, and the attract-mode
// opening movie, which paces itself with Sleep (its sound stops with the output all the same).
//
// Holds nest: the game goes on when every hold is released.

// onResume, if given, is called as the game goes on (the page drops its frame-rate samples: the
// wait would count as slow frames).
export function createPause(getAudio, onResume) {
  const raf = window.requestAnimationFrame;
  let holds = 0;
  let held = [];
  const holding = (cb) => { held.push(cb); return 0; }; // nothing on this page cancels a frame callback
  const set = (on) => {
    window.requestAnimationFrame = on ? holding : raf;
    const audio = getAudio();
    if (audio && audio.hold) audio.hold(on);
    if (!on) {
      if (onResume) onResume();
      const cbs = held;
      held = [];
      for (const cb of cbs) raf.call(window, cb);
    }
  };
  return {
    hold() { if (holds++ === 0) set(true); },
    release() { if (holds > 0 && --holds === 0) set(false); },
    // One frame while paused: the callbacks held so far go to the browser, the game draws its
    // next frame and waits again at the end of it (its next request is held like the others).
    // For a picture that has to be drawn again, after the canvas changed size (play.js). The
    // sound stays stopped.
    step() {
      if (holds === 0 || !held.length) return;
      const cbs = held;
      held = [];
      for (const cb of cbs) raf.call(window, cb);
    },
    get paused() { return holds > 0; },
  };
}
