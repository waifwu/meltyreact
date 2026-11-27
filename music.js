// The music page (music.html): the game's background music, played from the game's own
// archives. Over the game (?embedded=1) the game page shows this page in a popup and pauses
// the game while it is open (lib/controls-host.js, lib/pause.js); Close and Esc close it.
//
// Where the music is (recompiler/PROGRESS-audio.md): raw MP3 entries (MPEG-1 Layer III, no
// wrapper) named NN.MP3 in two archives, which the game searches in this order for
// .\bgm\NN.mp3: Re·ACT's 10.p, then the base game's data00.p. A number in 10.p hides the same
// number in data00.p, and the bundle does not store the hidden copies (its archives keep only
// what the game reads: data/bundle-manifest.json, lib/ptrim.js). Each track is read with one
// Range request and played by an <audio> element: browsers decode MP3 themselves.

import { decodePTable, pEntryCount, pMaxCount, pTableBytes, P_HEADER_SIZE } from './lib/pfile.js';
import { OffsetMap } from './lib/ptrim.js';

const $ = (id) => document.getElementById(id);
const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
const toGame = (action) => window.parent.postMessage({ type: 'mbr-page', action }, location.origin);

// in the game's search order; the page lists the base game first
const ARCHIVES = [{ path: 'ReACT/10.p', group: 'react' }, { path: 'MeltyBlood/data00.p', group: 'mb' }];
const GROUPS = [
  { id: 'mb', title: 'MELTY BLOOD', help: 'From the original game.', album: 'MELTY BLOOD' },
  { id: 'react', title: 'Re·ACT', help: 'Re·ACT’s own tracks.', album: 'MELTY BLOOD Re·ACT' },
];
const STORE = 'mbr-music';
const REPEATS = { all: 'Repeat: all', one: 'Repeat: this', off: 'Repeat: off' };
const manifestUrl = new URL('./data/bundle-manifest.json', import.meta.url);

// ------------------------------------------------------------ reading the archives
async function fetchPart(part, s, e, wholeFetch) {
  const fullRange = s === 0 && e === part.size;
  const r = (wholeFetch || fullRange)
    ? await fetch(part.url)
    : await fetch(part.url, { headers: { Range: `bytes=${s}-${e - 1}` } });
  if (r.status === 206) {
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== e - s) throw new Error(`short read from ${part.url}`);
    return new Uint8Array(buf);
  }
  if (r.status === 200) {
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== part.size) throw new Error(`short read from ${part.url}`);
    return fullRange ? new Uint8Array(buf) : new Uint8Array(buf, s, e - s);
  }
  throw new Error(`HTTP ${r.status} reading ${part.url}`);
}

/** One archive as the game sees it, read from its stored (trimmed, maybe split) copy. */
function archive(f) {
  const map = new OffsetMap(f.segments, f.size);
  const parts = f.chunks
    ? f.chunks.map((c) => ({ url: new URL(c.path, manifestUrl).href, size: c.size }))
    : [{ url: new URL(f.path, manifestUrl).href, size: f.storedSize }];
  const off = [0]; // where each part starts in the stored copy (parts may differ in size)
  for (const p of parts) off.push(off[off.length - 1] + p.size);
  const wholeFetch = !!(f.chunks && f.chunkSize <= (1 << 20)) || f.storedSize <= (1 << 20);
  return {
    size: f.size,
    wholeFetch,
    stored: (v0, v1) => map.covers(v0, v1),
    /** Bytes [v0, v1) of the archive, which must all be stored. */
    async read(v0, v1) {
      if (!map.covers(v0, v1)) throw new Error('not stored in this bundle');
      const { s0, s1 } = map.span(v0, v1);
      const out = new Uint8Array(s1 - s0);
      const jobs = [];
      let i = 0;
      while (i + 1 < parts.length && off[i + 1] <= s0) i++;
      for (; i < parts.length && off[i] < s1; i++) {
        const base = off[i];
        const a = Math.max(s0, base);
        const b = Math.min(s1, base + parts[i].size);
        if (b > a) jobs.push(fetchPart(parts[i], a - base, b - base, wholeFetch).then((u) => out.set(u, a - s0)));
      }
      await Promise.all(jobs);
      return out;
    },
  };
}

async function loadTracks() {
  const resp = await fetch(manifestUrl, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`cannot read the bundle's file list (HTTP ${resp.status})`);
  const files = (await resp.json()).files || [];
  const seen = new Set();
  const out = [];
  for (const a of ARCHIVES) {
    const f = files.find((x) => x.path === a.path);
    if (!f) continue;
    const ar = archive(f);
    const count = pEntryCount(await ar.read(0, P_HEADER_SIZE));
    if (count > pMaxCount(f.size)) throw new Error(`${a.path}: unreadable archive table`);
    const { entries } = decodePTable(await ar.read(0, pTableBytes(count)));
    for (const e of entries) {
      const m = /^(\d+)\.mp3$/i.exec(e.name.split(/[\\/]/).pop());
      if (!m) continue;
      const no = Number(m[1]);
      if (seen.has(no)) continue; // the game takes the first archive's copy
      seen.add(no);
      if (!ar.stored(e.offset, e.offset + e.size)) continue;
      out.push({ no, label: `Track ${m[1]}`, group: a.group, ar, offset: e.offset, size: e.size, seconds: null });
    }
  }
  const order = (t) => GROUPS.findIndex((g) => g.id === t.group);
  return out.sort((x, y) => order(x) - order(y) || x.no - y.no);
}

/** Length from the first frame's bit rate (the tracks are constant bit rate), or null. */
function mp3Seconds(h, size) {
  if (h.length < 4 || h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return null;
  const mpeg1 = ((h[1] >> 3) & 3) === 3;
  const layer3 = ((h[1] >> 1) & 3) === 1;
  const bi = h[2] >> 4;
  if (!layer3 || bi === 0 || bi === 15) return null;
  const kbps = (mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bi];
  return (size * 8) / (kbps * 1000);
}

const clock = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// ------------------------------------------------------------ the page
const audio = $('audio');
let tracks = [];
let cur = -1; // the chosen track (an index into tracks)
let loaded = -1; // the track in the audio element
let loadSeq = 0;
let repeat = 'all';
let dragging = false;
let prefetched = -1;

function save() {
  const t = tracks[cur];
  try {
    localStorage.setItem(STORE, JSON.stringify({ volume: audio.volume, repeat, no: t ? t.no : null, group: t ? t.group : null }));
  } catch { /* not kept */ }
}
function restore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { s = null; }
  if (!s) return;
  if (Number.isFinite(s.volume)) audio.volume = Math.min(1, Math.max(0, s.volume));
  if (Object.hasOwn(REPEATS, s.repeat)) repeat = s.repeat;
  const i = tracks.findIndex((t) => t.no === s.no && t.group === s.group);
  if (i >= 0) cur = i;
}

function message(text) {
  $('message').textContent = text || '';
  $('message').hidden = !text;
}

function render() {
  const box = $('groups');
  box.replaceChildren();
  for (const g of GROUPS) {
    const list = tracks.map((t, i) => [t, i]).filter(([t]) => t.group === g.id);
    if (!list.length) continue;
    const sec = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = g.title;
    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = `${g.help} ${list.length} tracks.`;
    const ol = document.createElement('ol');
    ol.className = 'tracks';
    ol.setAttribute('aria-label', `${g.title} tracks`);
    for (const [t, i] of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'trk';
      b.dataset.i = String(i);
      const eq = document.createElement('span');
      eq.className = 'eq';
      eq.setAttribute('aria-hidden', 'true');
      eq.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.label;
      const len = document.createElement('span');
      len.className = 'len';
      t.lenEl = len;
      b.append(eq, name, len);
      b.addEventListener('click', () => {
        if (i === cur && loaded === i) toggle();
        else choose(i);
      });
      t.button = b;
      li.append(b);
      ol.append(li);
    }
    sec.append(h2, help, ol);
    box.append(sec);
  }
  if (!box.children.length) message('No music was found in this bundle’s files.');
}

function showLength(t) {
  if (t.lenEl) t.lenEl.textContent = t.seconds ? clock(t.seconds) : '';
}

// a track's length before it is played: one small read of its first frame header each.
// Skipped for whole-chunk (<= 1 MiB) archives where probing every track would download
// ~45 MiB up front; durationchange fills in a track's length once it is played.
async function readLengths() {
  const probe = tracks.filter((t) => !t.seconds && !t.ar.wholeFetch);
  let next = 0;
  const worker = async () => {
    while (next < probe.length) {
      const t = probe[next++];
      if (t.seconds) continue;
      try {
        t.seconds = mp3Seconds(await t.ar.read(t.offset, t.offset + 4), t.size);
      } catch { t.seconds = null; }
      showLength(t);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

function showCurrent() {
  for (const t of tracks) if (t.button) t.button.removeAttribute('aria-current');
  const t = tracks[cur];
  if (!t) return;
  if (t.button) t.button.setAttribute('aria-current', 'true');
  $('now-title').textContent = t.label;
  $('now-from').textContent = GROUPS.find((g) => g.id === t.group).title;
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.label,
      artist: 'MELTY BLOOD Re·ACT',
      album: GROUPS.find((g) => g.id === t.group).album,
      artwork: [{ src: new URL('./icon-512.png', import.meta.url).href, sizes: '512x512', type: 'image/png' }],
    });
  }
}

// the last few tracks' bytes, as object URLs (the playing one is never dropped)
const urls = new Map(); // index -> Promise<object URL>
function urlFor(i) {
  let p = urls.get(i);
  if (p) {
    urls.delete(i);
  } else {
    const t = tracks[i];
    p = t.ar.read(t.offset, t.offset + t.size).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })));
    p.catch(() => { if (urls.get(i) === p) urls.delete(i); });
  }
  urls.set(i, p);
  for (const [k, old] of urls) {
    if (urls.size <= 4) break;
    if (k === loaded || k === i) continue;
    urls.delete(k);
    old.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return p;
}

async function choose(i, { play = true } = {}) {
  if (!tracks.length) return;
  cur = ((i % tracks.length) + tracks.length) % tracks.length;
  const seq = ++loadSeq;
  const t = tracks[cur];
  showCurrent();
  save();
  message('');
  audio.pause();
  $('now-from').textContent = 'Loading…';
  try {
    const url = await urlFor(cur);
    if (seq !== loadSeq) return; // another track was chosen meanwhile
    loaded = cur;
    prefetched = -1;
    audio.src = url;
    audio.loop = repeat === 'one';
    showCurrent();
    if (play) {
      try {
        await audio.play();
      } catch (e) {
        // a browser that wants a click on the page itself first: the Play button starts it
        if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') throw e;
      }
    }
  } catch (e) {
    if (seq !== loadSeq) return;
    showCurrent();
    message(`${t.label} could not be played: ${e && e.message || e}`);
  }
}

function toggle() {
  if (!tracks.length) return;
  if (cur < 0) { choose(0); return; }
  if (loaded !== cur) { choose(cur); return; }
  if (audio.paused) audio.play().catch((e) => message(`Could not play: ${e.message}`));
  else audio.pause();
}

function step(d) {
  if (!tracks.length) return;
  if (d < 0 && loaded === cur && audio.currentTime > 3) { audio.currentTime = 0; return; }
  choose(cur < 0 ? 0 : cur + d);
}

function setRepeat(r) {
  repeat = r;
  $('repeat').textContent = REPEATS[r];
  $('repeat').title = { all: 'Plays every track in turn, then starts again', one: 'Plays this track over and over, as the game does', off: 'Stops after the last track' }[r];
  audio.loop = r === 'one';
  save();
}

// ------------------------------------------------------------ controls
$('toggle').addEventListener('click', toggle);
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('repeat').addEventListener('click', () => setRepeat({ all: 'one', one: 'off', off: 'all' }[repeat]));
$('volume').addEventListener('input', (e) => { audio.volume = Number(e.target.value); save(); });
$('seek').addEventListener('input', (e) => {
  dragging = true;
  $('pos').textContent = clock(Number(e.target.value));
  if (loaded >= 0) audio.currentTime = Number(e.target.value);
});
$('seek').addEventListener('change', () => { dragging = false; });

const syncPlaying = () => {
  const on = !audio.paused;
  document.body.classList.toggle('playing', on);
  $('toggle').setAttribute('aria-label', on ? 'Pause' : 'Play');
  $('toggle').title = on ? 'Pause (Space)' : 'Play (Space)';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
};
audio.addEventListener('play', syncPlaying);
audio.addEventListener('pause', syncPlaying);
audio.addEventListener('durationchange', () => {
  const d = audio.duration;
  const ok = Number.isFinite(d) && d > 0;
  $('seek').disabled = !ok;
  $('seek').max = ok ? String(d) : '0';
  $('dur').textContent = clock(ok ? d : 0);
  const t = tracks[loaded];
  if (ok && t) { t.seconds = d; showLength(t); }
});
audio.addEventListener('timeupdate', () => {
  if (!dragging) {
    $('seek').value = String(audio.currentTime);
    $('pos').textContent = clock(audio.currentTime);
  }
  // the next track's bytes, shortly before it is needed
  const d = audio.duration;
  if (repeat !== 'one' && loaded >= 0 && Number.isFinite(d) && d - audio.currentTime < 20) {
    const n = (loaded + 1) % tracks.length;
    if (prefetched !== n && (repeat === 'all' || n > loaded)) { prefetched = n; urlFor(n).catch(() => {}); }
  }
});
audio.addEventListener('ended', () => {
  if (repeat === 'all') choose(loaded + 1);
  else if (repeat === 'off' && loaded < tracks.length - 1) choose(loaded + 1);
  else { audio.currentTime = 0; syncPlaying(); }
});
audio.addEventListener('error', () => {
  if (loaded >= 0 && audio.error) message(`${tracks[loaded].label} could not be played (media error ${audio.error.code}).`);
});

if ('mediaSession' in navigator) {
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* not offered here */ } };
  on('play', () => { if (audio.paused) toggle(); });
  on('pause', () => audio.pause());
  on('previoustrack', () => step(-1));
  on('nexttrack', () => step(1));
  on('seekto', (d) => { if (loaded >= 0 && Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
}

window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target && e.target.tagName;
  if (e.code === 'Space' && tag !== 'BUTTON' && tag !== 'INPUT' && tag !== 'SELECT') {
    e.preventDefault();
    toggle();
  } else if (e.code === 'Escape' && embedded) {
    e.preventDefault();
    audio.pause();
    toGame('close');
  }
});

// the page's bottom padding follows the player's height (one row, or three on a phone)
new ResizeObserver(() => {
  document.body.style.paddingBottom = `${$('player').offsetHeight + 12}px`;
}).observe($('player'));

// ------------------------------------------------------------ over the game
if (embedded) {
  document.body.classList.add('embedded');
  $('back').hidden = true; // the game page is the parent: never load it in here
  $('close').hidden = false;
  $('paused-note').hidden = false;
  $('close').addEventListener('click', () => { audio.pause(); toGame('close'); });
}

// ------------------------------------------------------------ start
(async () => {
  try {
    tracks = await loadTracks();
  } catch (e) {
    $('groups').replaceChildren();
    message(`The music could not be read: ${e && e.message || e}`);
    return;
  }
  restore();
  $('volume').value = String(audio.volume);
  setRepeat(repeat);
  render();
  if (cur >= 0) {
    showCurrent();
    $('now-from').textContent = `${GROUPS.find((g) => g.id === tracks[cur].group).title} · press Play`;
  }
  readLengths();
})();
