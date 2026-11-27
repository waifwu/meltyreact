// Main-thread side of the game's sound output: the runtime (recompiler/runtime/host_web.c)
// calls audioOpen / audioWrite / audioCommit on the host object; this module forwards the
// frames to an AudioWorklet (lib/audio-worklet.js) by message. No shared memory, so the page
// needs no cross-origin isolation.
//
// Browsers start audio only after a user gesture, so the context is created on the first
// click or key press on the page (or the sound button). Until then the game runs and mixes
// as usual and its output is dropped, except the last second, which is handed to the worklet
// when it starts so the sound begins without a gap. Nothing the game sees depends on whether
// or when audio starts.
//
// Writes are collected and posted in a microtask: the wasm runs without returning to the
// event loop except where it suspends (frame wait, awaited file read, fiber switch), and
// that is exactly when microtasks run.
//
// What is collected is merged before it is posted: one message for each stretch of frames, with
// a later write over an earlier one where they cover the same frames. The mixer writes 1024
// frames at a time, and every sound call that changes what is heard (Play, Stop, SetVolume,
// SetCurrentPosition) mixes the whole speculation again from the commit: one menu sound was
// three such passes, 94 messages and 91,000 frames (measured with 700 ms of speculation, a
// phone's setting), all for the same 31,000 frames, and a fight has several sounds a frame. Each
// message is a task on the audio thread, which renders nothing while it works through a burst
// of them. Merged, what is written between two suspensions is one message for each stretch (two
// as a rule: the commit, and the speculation's far end), and its frames go into the ring once:
// the same menu sound is 2 messages more than silence, not 94. The mixer still does every pass.

const RATE_DEFAULT = 44100;

export function createAudioOutput({ workletUrl, latency = 0.04, mute = false, volume = 1, onState = () => {} }) {
  let muted = !!mute;
  let held = false; // the game is paused (lib/pause.js): the output stays stopped until released
  let gainNode = null;
  const a = {
    rate: RATE_DEFAULT, latency, state: 'off', ctx: null, node: null, port: null,
    pending: [], commit: -1, queued: false, backlog: [], stats: null, error: null,
  };

  const flush = () => {
    a.queued = false;
    if (!a.port) return;
    for (const w of a.pending) {
      // exactly the frames written: the stretch's array may have room to spare
      const data = w.data.length === 2 * w.n ? w.data : w.data.slice(0, 2 * w.n);
      a.port.postMessage({ type: 'write', at: w.at, data }, [data.buffer]);
    }
    a.pending.length = 0;
    if (a.commit >= 0) a.port.postMessage({ type: 'commit', at: a.commit });
  };
  const queue = () => {
    if (!a.queued) { a.queued = true; queueMicrotask(flush); }
  };

  // ---- called by the runtime
  a.open = (rate, lat) => {
    a.rate = rate;
    if (lat > 0) a.latency = lat;
    a.state = 'waiting';
    onState(a);
    return 0;
  };
  // a.pending: stretches of frames { at, n, data (interleaved, room for at least n frames) } in
  // the order they were begun. A write that starts within the last stretch or right at its end
  // goes into it, over what is there and growing it; any other begins a new stretch. The
  // worklet takes the messages in order, so the ring ends up as if every write had been posted.
  const pend = (at, view) => {
    const n = view.length >> 1;
    let s = a.pending[a.pending.length - 1];
    if (!s || at < s.at || at > s.at + s.n) {
      s = { at, n: 0, data: new Int16Array(Math.max(2 * n, 8192)) };
      a.pending.push(s);
    }
    const end = at - s.at + n;
    if (2 * end > s.data.length) {
      const grown = new Int16Array(Math.max(2 * end, 2 * s.data.length));
      grown.set(s.data.subarray(0, 2 * s.n));
      s.data = grown;
    }
    s.data.set(view, 2 * (at - s.at)); // a copy: the view is into wasm memory
    if (end > s.n) s.n = end;
  };
  a.write = (at, view) => {
    if (a.port) { pend(at, view); queue(); return; }
    const data = view.slice(); // a copy: the view is into wasm memory
    a.backlog.push({ at, data });
    const keepFrom = at + (data.length >> 1) - a.rate; // the last second is enough to start from
    while (a.backlog.length && a.backlog[0].at + (a.backlog[0].data.length >> 1) < keepFrom) a.backlog.shift();
  };
  a.commitTo = (at) => { a.commit = at; if (a.port) queue(); };

  // ---- the user gesture
  a.start = async () => {
    if (a.state !== 'waiting') return;
    a.state = 'starting';
    onState(a);
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !('audioWorklet' in AC.prototype)) throw new Error('this browser has no AudioWorklet');
      let ctx;
      try { ctx = new AC({ sampleRate: a.rate, latencyHint: 'interactive' }); } catch { ctx = new AC({ latencyHint: 'interactive' }); }
      a.ctx = ctx;
      ctx.addEventListener('statechange', () => {
        if (a.state === 'on' && ctx.state === 'running' && a.port) a.port.postMessage({ type: 'resync' });
      });
      const resumed = ctx.resume(); // inside the gesture's handler: some browsers insist
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'mbr-audio', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { rate: a.rate, latency: a.latency },
      });
      const gain = muted ? 0 : volume; // volume: the settings page's master volume
      gainNode = ctx.createGain();
      gainNode.gain.value = gain;
      node.connect(gainNode).connect(ctx.destination);
      node.port.onmessage = (e) => { if (e.data.type === 'stats') a.stats = e.data; };
      a.node = node;
      a.port = node.port;
      for (const w of a.backlog) pend(w.at, w.data);
      a.backlog.length = 0;
      flush();
      if (ctx.state !== 'running') { a.state = 'starting'; onState(a); } // waiting for a gesture (autostart)
      await resumed;
      a.state = 'on';
      onState(a);
      if (held) ctx.suspend().catch(() => {}); // started by a click while the game is paused

    } catch (e) {
      a.error = e && e.message || String(e);
      a.state = 'failed';
      onState(a);
    }
  };

  a.isMuted = () => muted;
  a.setMuted = (on) => {
    const next = !!on;
    if (next === muted) return;
    muted = next;
    if (gainNode && a.ctx) {
      const target = muted ? 0 : volume;
      try {
        gainNode.gain.cancelScheduledValues(a.ctx.currentTime);
        gainNode.gain.setTargetAtTime(target, a.ctx.currentTime, 0.01);
      } catch { gainNode.gain.value = target; }
    }
    if (!muted) a.ensureRunning();
    onState(a);
  };
  a.toggleMute = () => { a.setMuted(!muted); return muted; };

  // Recover from iOS Safari's 'interrupted' state (calls, Control Center, app switch) as well as 'suspended'
  a.ensureRunning = () => {
    if (!a.ctx || held || document.visibilityState !== 'visible') return;
    if (a.ctx.state === 'suspended' || a.ctx.state === 'interrupted') {
      if (a.port) a.port.postMessage({ type: 'resync' });
      a.ctx.resume().catch(() => {});
    }
  };

  // a hidden tab stops requestAnimationFrame and so the game: stop the output with it
  document.addEventListener('visibilitychange', () => {
    if (!a.ctx) return;
    if (document.visibilityState === 'hidden') a.ctx.suspend().catch(() => {});
    else if (!held) { if (a.port) a.port.postMessage({ type: 'resync' }); a.ctx.resume().catch(() => {}); }
  });

  // the game paused in a visible tab (lib/pause.js): stop the output as a hidden tab does, and
  // start it again from the commit when the game goes on
  a.hold = (on) => {
    held = !!on;
    if (!a.ctx) return;
    if (held) a.ctx.suspend().catch(() => {});
    else a.ensureRunning();
  };

  a.summary = () => ({
    state: a.state, error: a.error, mute: muted, volume,
    contextRate: a.ctx ? a.ctx.sampleRate : null,
    baseLatency: a.ctx && a.ctx.baseLatency !== undefined ? a.ctx.baseLatency : null,
    outputLatency: a.ctx && a.ctx.outputLatency !== undefined ? a.ctx.outputLatency : null,
    latencyTarget: a.latency,
    worklet: a.stats,
  });
  return a;
}
