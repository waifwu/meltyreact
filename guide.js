// The guide page: the playing parts of the game's manual (guide.html). Here: each player's keys
// on the button cards, the character picker for the move lists, and the popup over the game.
//
// Over the game (?embedded=1) the game page shows this page in a popup (lib/controls-host.js
// openPage): Close and Esc close it, and the Controls link shows the controls page instead.

import { load, keysOf, keyLabel, CHANNEL, STORAGE_KEY } from './lib/controls-model.js';
import { isPhoneLike } from './lib/touch-controls.js';

// on a phone the page is worded for the on-screen buttons, without the keyboard's keys (guide.html, game.css)
if (isPhoneLike()) document.documentElement.classList.add('phone');

const $ = (id) => document.getElementById(id);
const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
const toGame = (action) => window.parent.postMessage({ type: 'mbr-page', action }, location.origin);

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_DEG = { ArrowUp: -90, ArrowDown: 90, ArrowLeft: 180, ArrowRight: 0 };

// ------------------------------------------------------------ the players' keys for A, B, C and D
function showButtonKeys() {
  let c;
  try { c = load(); } catch { return; }
  const cap = (code) => {
    const k = document.createElement('kbd');
    if (code && Object.hasOwn(ARROW_DEG, code)) {
      k.title = keyLabel(code);
      k.setAttribute('aria-label', `${code.replace('Arrow', '')} arrow`);
      const s = document.createElementNS(SVG_NS, 'svg');
      s.setAttribute('class', 'mb-arr');
      s.setAttribute('aria-hidden', 'true');
      if (ARROW_DEG[code]) s.style.setProperty('--r', `${ARROW_DEG[code]}deg`);
      const u = document.createElementNS(SVG_NS, 'use');
      u.setAttribute('href', '#mb-arr');
      s.append(u);
      k.append(s);
      return k;
    }
    k.textContent = code ? keyLabel(code) : '—';
    return k;
  };
  for (const el of document.querySelectorAll('[data-keys]')) {
    const id = el.dataset.keys;
    const player = (p) => {
      const s = document.createElement('span');
      s.className = 'pk';
      s.append(`Player ${p}`, cap(keysOf(c, `P${p}.${id}`)[0]));
      return s;
    };
    el.replaceChildren(player(1), player(2));
  }
}
showButtonKeys();
window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY || e.key === null) showButtonKeys(); });
try { new BroadcastChannel(CHANNEL).addEventListener('message', (e) => { if (e.data && e.data.type === 'config') showButtonKeys(); }); } catch { /* the storage event still does it */ }

// ------------------------------------------------------------ characters: the manual's move lists
// in the manual's order (com00.jpg .. com17.jpg), copied to guide/moves/
const CHARACTERS = [
  ['sion', 'Sion Eltnam Atlasia'], ['arcueid', 'Arcueid Brunestud'], ['ciel', 'Ciel'], ['akiha', 'Akiha Tohno'],
  ['hisui-kohaku', 'Hisui & Kohaku'], ['shiki-tohno', 'Shiki Tohno'], ['miyako', 'Miyako Arima'], ['mech-hisui', 'Mech-Hisui'],
  ['kohaku', 'Kohaku'], ['hisui', 'Hisui'], ['nrvnqsr-chaos', 'Nrvnqsr Chaos'], ['walachia', 'Walachia (Tatari)'],
  ['vampire-sion', 'Vampire Sion'], ['red-arcueid', 'Red Arcueid'], ['red-akiha', 'Red Akiha'], ['shiki-nanaya', 'Shiki Nanaya'],
  ['satsuki', 'Satsuki Yumizuka'], ['len', 'Len'],
];
const LAST = 'mbr-guide-character';

function showCharacter(slug) {
  const ch = CHARACTERS.find(([s]) => s === slug) || CHARACTERS[0];
  const img = $('movelist');
  img.src = `guide/moves/${ch[0]}.jpg`;
  img.alt = `${ch[1]}: special moves and Arc Drive`;
  for (const b of $('chars').children) b.setAttribute('aria-pressed', String(b.dataset.slug === ch[0]));
  try { localStorage.setItem(LAST, ch[0]); } catch { /* not kept */ }
}

const picker = $('chars');
for (const [slug, name] of CHARACTERS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.slug = slug;
  b.textContent = name;
  b.addEventListener('click', () => showCharacter(slug));
  picker.append(b);
}
let last = null;
try { last = localStorage.getItem(LAST); } catch { last = null; }
showCharacter(last);

// ------------------------------------------------------------ over the game
if (embedded) {
  document.body.classList.add('embedded');
  $('back').hidden = true; // the game page is the parent: never load it in here
  $('close').hidden = false;
  $('close').addEventListener('click', () => toGame('close'));
  for (const a of document.querySelectorAll('a[data-to="controls"]')) {
    a.addEventListener('click', (e) => { e.preventDefault(); toGame('controls'); });
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { e.preventDefault(); toGame('close'); }
  });
}
