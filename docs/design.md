# Tiltbox design

The screen is a glass box. The phone's accelerometer says which way is down and how hard the box is being shaken, and the contents (water, honey, marbles, bouncy balls, sand, snow) move accordingly. A finger stirs them.

Plain ES modules, run as they are. No build step, no dependencies, no asset files: sounds are synthesised and pictures are drawn in code.

```
python3 tools/serve.py            # http://localhost:8797/
python3 tools/smoke.py [mode...]  # headless check of every mode
```

## Files

| File | Holds |
|---|---|
| `index.html`, `style.css` | Page, start screen, mode bar |
| `src/main.js` | Shell: start screen, mode switching, frame loop, pointers, auto quality, debug overlay, test hooks |
| `src/motion.js` | Sensors to effective gravity; desktop fallback (keys, window drag); synthetic shakes |
| `src/view.js` | The sim frame and its mapping to a possibly rotated screen |
| `src/gl.js` | WebGL2 helpers |
| `src/audio.js` | Synthesised sound (API below) |
| `src/modes/index.js` | Mode registry (id, name, icon, lazy loader) |
| `src/modes/<id>.js` | Each mode's entry point; its engine lives in `src/modes/<engine>/` |
| `docs/modes/<engine>.md` | How each engine works and how it is tuned |
| `tools/smoke.py` | Headless smoke test |

## The simulation frame

The simulation lives in the device's natural frame, not the screen's: x right, y down, in CSS pixels, origin at the device's top-left corner as held in its natural orientation (portrait on a phone). Its size is `view.simW × view.simH`.

The accelerometer reports in that same frame, so physics never needs to know how the page is rotated. When the browser turns the page to landscape, the renderer turns the picture back (`view.clipMatrix`, `view.apply2d`), so the contents stay put against the glass instead of jumping. On desktop the angle is always 0 and the sim frame is the screen.

## Gravity: `env.g`

`env.g = {x, y, z}` is the effective gravity the contents feel, in m/s², in the sim frame: x right, y down, z into the screen (toward the back glass).

A phone reports proper acceleration `f = a − g` in its own frame (x right, y up, z out of the screen; lying face up, `f = (0, 0, +9.81)`). Contents of a box that moves with the phone feel `g − a = −f`, which in the sim frame is `(−f.x, +f.y, +f.z)`. One reading covers tilt and shake: shake the phone and the contents slosh as in a real container. Magnitude is clamped to 45 m/s².

- Upright phone: `g ≈ (0, 9.81, 0)`.
- Lying flat face up: `g ≈ (0, 0, 9.81)`: nothing in the screen plane, everything pressed against the back glass. Modes use `|g.z|` as the normal force for friction against the glass, so sand on a flat phone stays where it is and marbles roll slowly to a stop.
- Shaking: `g` swings by tens of m/s² for fractions of a second. `env.shake` is a high-passed magnitude (m/s²), for effects that want to know "being shaken now" (sparkle, haptics).
- `env.gSlow` is `g` low-passed over 0.35 s: the tilt without the shake. A hand shake moves a phone only a centimetre or so, which at true scale barely stirs the contents; a mode that should respond more exaggerates the shake alone with `gSlow + k·(g − gSlow)`, leaving the tilt true.

iOS has historically reported `accelerationIncludingGravity` with the opposite sign to the spec. `motion.js` checks the sign against `deviceorientation` (beta, gamma follow the spec on both platforms) and corrects it; before the check settles it guesses from how phones are usually held. `?flip=1` / `?flip=0` force it.

Desktop, no sensor: arrow keys (or A/D) tilt the box, ↓ or R straightens it, ↑ turns it over, space shakes it sideways (shift+space up and down), and dragging the browser window around accelerates the box with the window.

Sensors need a secure context (HTTPS). iOS also needs `DeviceMotionEvent.requestPermission()` from a tap; the Start button does that.

## Mode contract

A mode module default-exports a factory. Everything below is called by `main.js` only.

```js
export default async function create(ctx) { ... return mode; }

ctx = {
  canvas,     // a fresh <canvas> for this mode; backing size already view.pxW × view.pxH
  view,       // the current View (simW, simH, dpr, pxW, pxH, angle, clipMatrix, apply2d, toSim)
  audio,      // see Audio
  haptic,     // haptic(strength 0..1): a short buzz where supported (Android); rate-limited
  quality,    // 'low' | 'medium' | 'high': scale particle counts and resolutions with it
  params,     // URLSearchParams of the page, for mode-specific debug switches
  modeName,
  test,       // true under ?test=1
}

mode.resize(view)      // the box changed size or turned (also called once after create). Keep the
                       // contents: rescale or clamp them into the new box, never reset them.
mode.step(dt, env)     // advance by dt seconds, 0 < dt <= 1/30. Substep inside as needed.
                       // env = { g:{x,y,z}, gSlow:{x,y,z}, shake, pointers:[{id,x,y,vx,vy}], time, dt, source }
                       // pointers: fingers (or the mouse while pressed) in sim px and sim px/s
mode.render(view)      // draw the whole frame. The canvas backing size is view.pxW × view.pxH.
mode.stats()           // cheap: { count, nan, outside, ...mode-specific numbers }
                       //   count: particles/bodies; nan: any non-finite state; outside: how many
                       //   are outside [0, simW] × [0, simH] (must stay 0)
mode.reset()           // refill to the starting state (the Refill button)
mode.dispose()         // free GL resources and audio beds; main then loses the context
mode.debugState?()     // optional: richer state for tests (positions, grid, …)
```

Every mode gets its own canvas and context (main replaces the canvas on every switch), so there is no GL state to share or restore. Draw with WebGL2 (`createGL` in `src/gl.js`); map sim coordinates through `view.clipMatrix` (`clip = M * vec3(x, y, 1)`). An offscreen pass in sim orientation is drawn to the screen as a quad covering `[0, simW] × [0, simH]` through the same matrix.

`dt` is real frame time, capped at 1/30 s: a hiccup is slow motion, never a blow-up. With `|g|` up to 45 m/s² flipping direction within a frame, nothing may tunnel out of the box or go non-finite.

## Quality and budgets

`main.js` caps the device pixel ratio by quality (low 1, medium 1.5, high 2) and, once per mode start, drops a level if the device can't keep up (step + render CPU above 11 ms a frame, or frames slower than 25 ms with CPU above 6 ms). `?q=low|medium|high` fixes the level.

Budget per frame, measured in headless Chromium on the development desktop with `tools/smoke.py`: step + render CPU at most about 4 ms at `high`. An iPhone 15 Pro runs JavaScript about as fast as a desktop core; a mid-range Android is three to four times slower, so with `--throttle 4` a mode at `medium` should still fit in about 12 ms.

## Audio

`src/audio.js`, synthesised with Web Audio. Modes call only this:

```js
audio.impact(kind, intensity, pitch = 1)  // one-shot hit; kind 'glass' | 'rubber' | 'grain' | 'drop' | 'chime'
                                          // intensity 0..1, pitch a multiplier around the kind's base
audio.bed(kind) -> { set(level, tone), stop() }   // continuous; kind 'water' | 'honey' | 'sand' | 'swirl' | 'fizz'
                                          // level 0..1 how much is moving, tone 0..1 how fast/bright; set() every frame
```

`impact` is cheap and rate-limited inside, so modes may call it per contact; they should still pass only contacts that would be heard (a real impact speed, not resting contact). `audio.unlock()` runs from the Start tap. The sound button mutes everything, haptics included.

## Test hooks: `window.__T`

Load `?test=1` (no start screen, fixed quality, no saved mode) and drive:

| Hook | Does |
|---|---|
| `__T.ready`, `__T.error` | mode is up; the last error, if any |
| `__T.setMode(id)` | switch; resolves when the mode is created |
| `__T.pause(true)` | stop the real-time loop |
| `__T.step(n, dt = 1/60)` | n steps, one render, returns `stats()` |
| `__T.gravity(x, y, z)` / `__T.gravity(null)` | fix `env.g` (m/s², sim frame) / back to sensors |
| `__T.shake(amp, dur, dirX, dirY, freq)` | a synthetic shake on top of gravity (advances with `step`) |
| `__T.pointer([{x, y, vx, vy}])` / `(null)` | synthetic fingers, sim px |
| `__T.rotate(angle)` / `(null)` | pretend the page is turned 0/90/180/270 |
| `__T.setQuality(q)` | recreate the mode at a quality |
| `__T.stats()`, `__T.modeObj`, `__T.view`, `__T.motion` | state |

`?debug=1` (or the backtick key) shows the debug overlay: fps, step and draw time, gravity, the sensor source and sign calibration, the view, and the mode's stats.
