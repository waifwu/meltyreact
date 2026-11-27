// AudioWorklet side of the game's sound output (recompiler/runtime/host_web.c, host.h).
//
// The game's mixer runs in the wasm on the page's main thread and posts 44,100 Hz stereo
// frames at absolute positions: committed frames (final, up to the game's sound clock) and
// a speculative stretch beyond them, which the next commit normally replaces before it is
// heard. This processor plays about `latency` behind the committed position. It steers that
// lag back by resampling by at most 0.5 % (this also converts 44.1 kHz to the context's own
// rate), plays on into the speculation while commits stop arriving (a main-thread stall: an
// awaited file read, a long frame), and plays silence and keeps going in time when even the
// speculation runs out, so a long stall leaves a gap rather than a growing delay.
//
// Messages in:  { type: 'write', at, data: Int16Array (interleaved L R) }
//               { type: 'commit', at }        frames before `at` are final
//               { type: 'resync' }            the game paused (hidden tab): start again from the commit
// Messages out: { type: 'stats', ... }        every half second

const RING = 1 << 17; // frames, about 3 s

class MbrAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.srcRate = o.rate || 44100;
    this.latency = o.latency || 0.04;
    this.l = new Float32Array(RING);
    this.r = new Float32Array(RING);
    this.wend = 0;          // one past the highest frame written
    this.commit = -1;       // committed position
    this.commitTime = 0;    // currentTime when the commit last moved
    this.rd = -1;           // read position (frames, integer part)
    this.ph = 0;            // fractional part
    this.s = { quanta: 0, underruns: 0, silence: 0, late: 0, held: 0, lagMin: Infinity, lagMax: -Infinity, lagSum: 0, aheadMin: Infinity,
               ratioMin: Infinity, ratioMax: -Infinity, writes: 0, written: 0, dropped: 0, underrunAt: [] };
    this.lastReport = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'write') {
      let at = m.at, d = m.data, n = d.length >> 1, off = 0;
      const lo = this.rd < 0 ? 0 : this.rd + 2; // what has been played or is being played stays
      if (at < lo) { const k = Math.min(n, lo - at); off = k; at += k; n -= k; this.s.dropped += k; }
      if (this.rd >= 0 && at + n > this.rd + RING - 256) n = Math.max(0, this.rd + RING - 256 - at);
      for (let i = 0; i < n; i++) {
        const j = (at + i) & (RING - 1);
        this.l[j] = d[2 * (off + i)] * 3.0517578125e-5; // 1/32768, exact
        this.r[j] = d[2 * (off + i) + 1] * 3.0517578125e-5;
      }
      if (n > 0 && at + n > this.wend) this.wend = at + n;
      this.s.writes++;
      this.s.written += n;
    } else if (m.type === 'commit') {
      if (m.at !== this.commit) { this.commit = m.at; this.commitTime = currentTime; }
    } else if (m.type === 'resync') {
      this.rd = -1;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (this.commit < 0) { L.fill(0); R.fill(0); return true; }
    if (this.rd < 0) { this.rd = this.commit - Math.round(this.latency * this.srcRate); this.ph = 0; this.commitTime = currentTime; }
    const s = this.s;
    let lag = (this.commit - this.rd) / this.srcRate;
    const stalled = currentTime - this.commitTime > 0.030;
    let ratio = 1;
    if (!stalled) {
      if (lag - this.latency > 0.150) { // far behind after a stall: jump back to the target lag
        const skip = this.commit - Math.round(this.latency * this.srcRate) - this.rd;
        s.late += skip;
        this.rd += skip;
        lag = this.latency;
      } else if (lag < this.latency - 0.150) { // ahead of the mix (a fast clock): wait for it
        L.fill(0); R.fill(0);
        s.held += n;
        return true;
      }
      ratio = Math.min(1.005, Math.max(0.995, 1 + 0.05 * (lag - this.latency)));
    }
    s.quanta++;
    s.lagMin = Math.min(s.lagMin, lag); s.lagMax = Math.max(s.lagMax, lag); s.lagSum += lag;
    s.aheadMin = Math.min(s.aheadMin, (this.wend - this.rd) / this.srcRate);
    s.ratioMin = Math.min(s.ratioMin, ratio); s.ratioMax = Math.max(s.ratioMax, ratio);
    const step = ratio * this.srcRate / sampleRate;
    let rd = this.rd, ph = this.ph, missing = 0;
    for (let i = 0; i < n; i++) {
      const k = rd + Math.floor(ph);
      if (k + 1 >= this.wend) { L[i] = 0; R[i] = 0; missing++; }
      else {
        const f = ph - Math.floor(ph), a = k & (RING - 1), b = (k + 1) & (RING - 1);
        L[i] = this.l[a] + (this.l[b] - this.l[a]) * f;
        R[i] = this.r[a] + (this.r[b] - this.r[a]) * f;
      }
      ph += step;
    }
    const whole = Math.floor(ph);
    this.rd = rd + whole;
    this.ph = ph - whole;
    if (missing) {
      s.underruns++;
      s.silence += missing;
      if (s.underrunAt.length < 32) s.underrunAt.push(currentTime);
    }
    if (currentTime - this.lastReport > 0.5) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'stats', ...s, underrunAt: s.underrunAt.slice(), contextRate: sampleRate, time: currentTime });
    }
    return true;
  }
}

registerProcessor('mbr-audio', MbrAudio);
