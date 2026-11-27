# MELTY BLOOD Re·ACT Final Tuned — Web Port

Playable browser port of **MELTY BLOOD Re·ACT Final Tuned** compiled to WebAssembly, packaged as a static site with zero backend required.

**Live site:** https://meltyreact.pages.dev/

## Features

- **WebAssembly runtime** — auto-selects JSPI (`mbr-jspi.wasm`) with an Asyncify fallback (`mbr-asyncify.wasm`) for browsers without JSPI.
- **WebGL2 rendering** — sharpened Catmull-Rom upscaling (`upscale`, default), sharp bilinear (`sharp`), nearest-neighbor (`pixels`), and bilinear (`smooth`), plus 32-bit colour and textures by default.
- **Web Audio worklet** — low-latency audio mixer with live mute/unmute and configurable latency.
- **Persistent browser saves** — progress, unlocks, replays, and `app.cfg` / `cfg.cfg` persist in OPFS, with `.zip` export/import in **Settings**.
- **Phones & tablets** — automatic multi-touch layout (8-way sliding arcade D-pad or floating stick, `A / B / C / D` jewel buttons, macro deck, landscape auto-fullscreen, PWA manifest).
- **Soundtrack player & Guide** — all 60 BGM tracks streamed directly from the game archives (`music.html`), plus character move lists (`guide.html`).

## Default Controls

| Action | Player 1 | Player 2 |
| --- | --- | --- |
| Move | `W` `A` `S` `D` | `T` `F` `G` `H` |
| Weak / Mid / Strong / Shield (`A` `B` `C` `D`) | `N` `M` `,` `.` | `Z` `X` `C` `V` |
| Macros (`A+D`, `A+B`, `A+B+C`) | `J` `K` `L` | `1` `2` `3` |
| Menu confirm / back | `N` or `Enter` / `M` or `Backspace` | — |
| Pause / Resume | `Esc` (works in all modes, including VS and menus) | — |
| Full screen | `Alt+Enter` | — |

- **Remapping & Gamepads:** open **Controls** (`controls.html`) to rebind any key or configure USB/Bluetooth controllers (Gamepad API).
- **Mouse in menus:** optional and off by default; enable in **Settings → Mouse controls** or with `?mouse=1`.

## Pages

- `index.html` / `play.html` — Game page
- `controls.html` — Keyboard & controller bindings
- `settings.html` — Video, scaling, audio, mouse toggle, and save zip export/import
- `guide.html` — Basics, mechanics, and character move lists
- `music.html` — In-browser BGM player (pauses the game while open)

## Hosting & Bundle Layout

- Pre-trimmed game archives (`~1.44 GB`) are split into `<= 256 KiB` original-block-aligned pieces (`.256kNNNN`) described by `data/bundle-manifest.json` and fetched as plain `HTTP 200` requests (no `Range` header dependency).
- `_headers` sets `Cache-Control: public, max-age=31536000, immutable` on `/data/ReACT/*` and `/data/MeltyBlood/*` while keeping `data/bundle-manifest.json` and `/build/*` revalidated across redeploys.
- Deploys directly on Cloudflare Pages (no build command; output directory `/`) or any static HTTPS/localhost host (`npx serve .` or `python3 -m http.server`).
