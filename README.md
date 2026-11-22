# Tiltbox

Your phone's screen is a glass box. Fill it with water, honey, marbles, bouncy balls, sand or snow, then tilt it, shake it, and stir it with a finger.

It runs in the browser with no install. The phone's accelerometer gives the box both its tilt and its shake. Shaking the phone sloshes the water the way it would in a real container, because the contents feel exactly what the sensor feels.

## Run it

```
python3 tools/serve.py          # http://localhost:8797/
```

Phones only hand motion data to pages served over **HTTPS**, and iOS asks for permission once (the Start button). For a phone on the same network:

```
python3 tools/serve.py 8798 --https   # https://<this machine>:8798/
```

It makes a self-signed certificate on first use (kept in `~/.local/share/tiltbox-certs/`, never in the repo). The phone warns about it once: on iOS tap *Show Details → visit this website*.

On iOS, *Share → Add to Home Screen* gives it the whole screen. If you lock the phone in portrait, the box never rotates under you. It copes with rotation anyway.

On a desktop: ← → tilt, ↑ turns the box over, ↓ straightens it, space shakes it, and the mouse stirs. Dragging the browser window around sloshes the contents too.

## Develop

No build step and no dependencies: plain ES modules, everything drawn and synthesised in code.

```
python3 tools/smoke.py               # every mode through tilts, shakes, a finger and a rotation, headless
python3 tools/smoke.py water --throttle 4
```

`?debug=1` (or the backtick key) shows frame times, the gravity vector and the sensor calibration. `docs/design.md` has the frames, units and the mode contract. Each engine is described in `docs/modes/`.
