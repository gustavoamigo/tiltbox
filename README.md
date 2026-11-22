# Tiltbox

Your phone's screen is a glass box. Fill it with water, honey, marbles, bouncy balls, sand or snow, then tilt it, shake it, and stir it with a finger.

**Play: <https://gustavoamigo.github.io/tiltbox/>**. Open it on a phone, tap Start and allow motion access.

It runs in the browser. The phone's accelerometer gives the box both its tilt and its shake. Shaking the phone sloshes the water the way it would in a real container, because the contents feel exactly what the sensor feels.

To keep it as an app: on iPhone, *Share → Add to Home Screen*; on Android, *Install app* on the start screen (or the browser menu). Installed, it fills the screen, stays in portrait and works offline.

## Run it locally

```
python3 tools/serve.py          # http://localhost:8797/
```

Phones only hand motion data to pages served over **HTTPS**, and iOS asks for permission once (the Start button). For a phone on the same network:

```
python3 tools/serve.py 8798 --https   # https://<this machine>:8798/
```

It makes a self-signed certificate on first use (kept in `~/.local/share/tiltbox-certs/`, never in the repo). The phone warns about it once: on iOS tap *Show Details → visit this website*.

If you lock the phone in portrait, the box never rotates under you. It copes with rotation anyway.

On a desktop: ← → tilt, ↑ turns the box over, ↓ straightens it, space shakes it, and the mouse stirs. Dragging the browser window around sloshes the contents too.

## Develop

No build step and no dependencies: plain ES modules, everything drawn and synthesised in code. Every push to `main` is published by GitHub Pages as it is (`.nojekyll` keeps files like `_placeholder.js`). `python3 tools/make_icons.py` renders the icons from `icons/icon.svg` and `icons/favicon.svg`.

```
python3 tools/smoke.py               # every mode through tilts, shakes, a finger and a rotation, headless
python3 tools/smoke.py water --throttle 4
```

`?debug=1` (or the backtick key) shows frame times, the gravity vector and the sensor calibration. `docs/design.md` has the frames, units and the mode contract. Each engine is described in `docs/modes/`.
