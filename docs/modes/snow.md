# Snow: the snow-globe engine

`src/modes/snow.js` → `src/modes/snow/`:

| File | Holds |
|---|---|
| `mode.js` | The mode: turns `env` (gravity, shake, fingers) into forcing, sound, stats |
| `fluid.js` | The liquid: stable fluids on a coarse collocated grid, plus its stream function |
| `turb.js` | Sub-grid turbulence: a divergence-free random field whose strength follows the shake |
| `flakes.js` | Snow and glitter: airborne flakes carried by the liquid, resting flakes on a fine occupancy grid |
| `scene.js` | The night scene (hills, cottage, pines, far ridge): one description draws the picture and the solid mask |
| `render.js` | WebGL2: one full-screen pass (sky, moon, stars, scene, window glow, glass) and the flakes as point sprites |

## Units and scale

Everything is in sim px (the device's natural frame, x right, y down) and seconds; gravity is `env.g` in m/s². The scene scales with `S = min(W, 0.62 H) / 393` (1 on a 393 px wide phone). There is no metres-to-pixels factor: a full, closed globe moves almost as one with its liquid, so true scale (about 6000 CSS px per metre on a phone) would make every shake a flood. The couplings below are set in px directly.

## How it works

**Liquid** (`fluid.js`). Stam's stable fluids on about 32×69 cells at high quality: semi-Lagrangian advection, vorticity confinement, SOR pressure projection, an exponential decay standing in for the drag of the front and back glass. Walls and the scene are no-slip solid cells. Three things drive it:
- *Lag*: the high-passed part of `env.g` (box acceleration, `g − lowpass(g, 0.25 s)`) pushes the liquid relative to the box, shaped to zero at solids, so what survives projection is shear and swirl near the walls and the scene.
- *Turning*: when the smoothed in-plane gravity turns, the glass has turned the other way; the liquid keeps still in the world, so it gets the opposite solid-body rotation.
- *Eddies*: a shake seeds Gaussian vortices, mostly just above the snow, at a rate proportional to the shake.

Fingers drag the liquid under them toward their own velocity.

After each step the liquid's stream function ψ (`−∇²ψ = curl u`, ψ = 0 in all solids) is solved, and flakes are carried by `curl ψ` rather than the interpolated velocity. Bilinear velocity between the last liquid cell and a solid one always has a part flowing into the solid, which piled flakes into films on every surface; `curl ψ` is exactly divergence-free inside each cell and runs along the solids.

**Turbulence** (`turb.js`). A 2D grid this coarse has no small or three-dimensional eddies, and those are what really mix a shaken globe. Six drifting plane waves of stream function, multiplied by a factor that goes to zero at the four glass walls, give a coherent, divergence-free field that turns along the glass. Its rms level rises with the shake (`18 px/s per m/s²` above 7 m/s², capped at 480, rise 0.12 s, fall 1.5 s) and idles at 5 px/s, so flakes on a flat phone drift instead of hanging dead still.

**Flakes** (`flakes.js`). The velocity of an airborne flake relaxes (τ 0.07 s snow, 0.1 s glitter) toward liquid + turbulence + its terminal velocity along the in-plane gravity (`ws · g / 9.81`), plus a sideways flutter. Resting flakes occupy one cell of a 2 px grid together with the scene and a one-cell ring for the glass:
- A flake lands when it bumps into something below it and the liquid is calm. Below 45 px/s of agitation it always lands; up to 135 px/s it sometimes does, with a random threshold per contact, so settling starts while the churn dies down. It topples one cell down a free diagonal unless it sticks (12%), so piles keep to about 45°.
- "Below" follows the smoothed gravity, not the instantaneous one. A shake's sideways swings would otherwise topple every pile sideways 7 times a second and wake snow deep inside the nooks of the pines, where it stayed trapped.
- A resting flake whose top is exposed is picked up when the liquid plus turbulence exceeds 60 px/s, at a rate growing with the excess. It is flung up and away from its support at up to 800 px/s, with weak drag (τ 0.35 s) for 0.35 s, so it clears the scene before the turbulence takes over.
- While the liquid churns too hard for landing, the resolved flow loses its component into an adjacent blocked cell, the turbulent kick is mirrored off it, and a flake touching a surface gets a kick along the surface normal (0.9 × turbulence). Without these, churning flakes gathered in films along surfaces, up to 135 of them in one 16 px block.

Sinking speeds at 1 g: snow 6 + 8 r + 0–7 px/s (r = 1.2–3.3 px, so about 20–40), 4% almost buoyant (4–9 px/s), glitter 30–52. The starting state is 84% of the snow fallen straight down onto the scene and 16% still falling: a gentle snowfall behind the start screen.

**Picture** (`render.js`, `scene.js`). The scene is painted once per size into a canvas texture: moonlit snowy hills with glints, a dark far ridge on the back glass, frosted pines, a cottage with lit windows. The one full-screen pass draws the sky gradient, stars, moon, the scene texture, a flickering warm glow from the windows, and the glass (superellipse vignette plus a curved reflection that drifts with the tilt). Flakes are point sprites with premultiplied alpha, darkened by the same vignette in the vertex shader instead of a second full-screen pass. Snow is a soft disc; resting snow is drawn larger, shaded by exposure. Glitter (9% of flakes, silver, gold, rose, ice) is a tinted foil hexagon that turns while airborne and flares with a cross and halo when its facet lines up with a light phase that follows the tilt.

**Sound**. The `swirl` bed follows the liquid's rms speed (level, full at 260 px/s) and peak speed (tone). A shake above 14 m/s² rings sparse `chime`s on a pentatonic scale, through a token bucket of about 4 per second.

## Measured

Headless Chromium on the development desktop, 393×852 viewport, `?test=1`, default seed. Timings are from `__T.stats()` (0.1 ms resolution), medians of 90 single-step frames.

Airborne fraction after a side shake (`__T.shake(32, 0.8, 1, 0, 7)`, upright, from settled snow):

| t (s) | 0.5 | 1.2 | 2 | 4 | 6 | 8 | 10 | 12 | 15 | 18 | 22 | 30 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| airborne | 0.66 | 0.98 | 0.99 | 0.93 | 0.52 | 0.43 | 0.39 | 0.35 | 0.25 | 0.17 | 0.08 | 0.03 |

Across four seeds the same shake gave 0.39–0.62 airborne at 6 s, 0.18–0.39 at 10 s, 0.11–0.30 at 15 s and 0.02–0.18 at 22 s: the response is chaotic. The drop between 4 and 6 s is the snow that stayed near the scene settling as the churn ends; the rest falls from as high as the top of the globe. Turned over, the snow falls the full height: 36% is still airborne at 20 s. Flat on the table after a shake, 86% stays airborne for 20 s and drifts at 4–6 px/s rms. A circling finger lifts about 20% of the snow, settled again after about 8 s.

Per frame (step / render CPU, ms):

| Quality (flakes, cells) | settled | shaken, all airborne |
|---|---|---|
| high (2400, 2200) | 0.7 / 0.1 | 1.7–2.3 / 0.1 |
| high, `--throttle 4` | 3.4 / 0.2–0.8 | 8.5 / 0.2 |
| medium (1700, 1400), `--throttle 4` | 1.9 / 0.2 | 4.9 (p90 6.5) / 0.3 |
| low (1100, 800), `--throttle 4` | 0.9 / 0.1 | 3.1 / 0.3 |

Nothing allocates per frame. GPU cost: one full-screen pass plus 2400 point sprites; not measurable headless (SwiftShader), and real-device frame rate is unverified.

## Limits

- The globe is 2D. Flakes cannot pass in front of or behind the cottage and pines, so the scene is a maze for them. The launch, the surface kicks and the smoothed "down" exist to keep snow from getting trapped in it.
- Resting snow is drawn as overlapping discs: a lumpy pile, like the plastic flakes of a real globe, not a smooth blanket.
- Shakes differ a lot from one to the next (see the seed spread above); some leave a third of the snow up at 15 s, some a tenth.
- The couplings (`LAG`, `TURB_GAIN`, `LAUNCH`, sinking speeds) were tuned by eye in headless Chromium with synthetic shakes; how a real hand's shake feels on a phone is untested.
