# Balls engine (Marbles, Balls)

`src/modes/balls/`: a rigid-ball engine for the thin box, one layer of spheres seen from the front. `marbles.js` and `balls.js` are presets of it.

| File | Holds |
|---|---|
| `engine.js` | `BallWorld`: the physics |
| `presets.js` | materials, sizes, counts, per-ball looks, `buildWorld` (shared by the mode and headless tests) |
| `mode.js` | the mode: world + renderer + light + sound + stats |
| `render.js`, `shaders.js` | WebGL2: back panel, shadows and caustics, sphere impostors |

## World and units

Positions in sim px, time in s. Gravity arrives in m/s² and is scaled by `pxPerM`: 3200 for marbles, 3000 for rubber balls. A phone screen is about 5500 CSS px/m, so the box reads a little bigger than the phone (falls are a little slower than life, so they are watchable). Radii follow the box area so the balls cover a fixed fraction of it (`fill`: 0.36 marbles, 0.34 balls). On a 393×852 box the mean marble is 16 px (5 mm) in three sizes (13, 16, 21 px), and the rubber balls run from 17 to 51 px in four sizes. Mass ∝ r³ for marbles, r^2.5 for rubber balls (at r³ the biggest would be 25× the smallest and barely move when hit). Counts by quality are 70/105/150 marbles and 26/38/52 balls, scaled by −25% to +15% with the box area.

## How a step works

Each ball is a disc with full 3D spin and an orientation quaternion. In-plane contacts (ball, wall, finger) act on (vx, vy, wz), plus a twist-friction row that damps spin about in-plane axes. The back glass (front glass if `g.z < 0`) is a friction contact per ball, pressed by `|g.z| + glassBase`. It couples (vx, vy) with (wx, wy), so a ball pressed against the glass rolls on it, ω_xy = (ẑ × v)/r, with rolling and spinning resistance. A marble on a tilted flat phone rolls with zero slip, and its pattern turns about the in-plane axis.

Substeps run at 960 Hz (16 per 60 Hz frame; at most 24 per step, so a 30 fps frame runs at 720 Hz instead of doubling the work). Contacts are found every K substeps by a uniform grid with speculative margins: a contact lets its pair close exactly the gap and no more. The margin covers twice the fastest speed (a resting pair can be knocked together by a third ball mid-pass) plus the most that projection may move a ball. K (1–4) is chosen so the fastest ball moves at most 0.25 r_min between passes. Speeds are capped at 5000 px/s (1.6 m/s), under half the smallest radius per substep. Each substep:

1. gravity, light damping, speed limits;
2. warm start. Resting contacts carry their impulse to the next substep. Contacts that were closing faster than the bounce threshold do not: re-applying an impact impulse throws whole piles apart;
3. two velocity Gauss-Seidel sweeps over **hard** contacts (normal, Coulomb friction with spin, twist, rolling resistance), contacts ordered bottom-up along the load direction. Then the glass rows;
4. **shock propagation** (after Guendelman et al. 2003). The balls are visited bottom-up along d = g·0.03 s + mean velocity: d is g for a pile at rest, and points at the wall a flying pile is about to hit. When a ball is reached, its supports (lower balls, walls) are final. Its velocity takes the least change that stops it closing on all of them, an exact 2D problem: at most two constraints are active, so every single and pair is tried. A second sweep does the same top-down against what the ball supports. If no small answer exists (a ball driven into a wall by what is under it), that ball is left to step 3. This is what stops a pile landing on the floor in one substep; plain Gauss-Seidel needs a sweep per layer and lets the layers sink into each other meanwhile;
5. positions;
6. **position projection**: three mass-weighted sweeps that remove 70% of each overlap, then a bottom-up exact-move sweep as in step 4. Velocities are not touched, so no energy is added. A ball may move at most 0.2 r_min this way per pass; once one has, the pass ends early and contacts are found again.

Passes with fast-closing contacts (a pile landing, a ball batted into the pile) get one extra sweep of each kind per 0.25 m/s of closing speed, up to 8. Restitution is applied once per pass to contacts that were closing faster than `restThreshold` (0.12 m/s marbles, 0.1 balls): slower approaches do not bounce, so piles come to rest. If anything still overlaps more than 2% at the frame end, up to two position-only passes clean it up, because the frame end is what is drawn and what `maxOverlap` reports.

When every ball has moved slower than 3 px/s for 0.5 s, the box sleeps and nothing moves until gravity changes by 0.35 m/s², a finger comes near, or the box resizes. A resize scales positions and then relaxes overlaps immediately (positions only).

**Why hard contacts plus projection, not soft contacts.** The earlier draft used Box2D v3 soft contacts. A soft contact under load F sinks F/k into its neighbour, and the bottom row of a 12-layer marble pile carries about 60 ball weights sideways (the rows above wedge it apart). At any stiffness the substep rate allows, that is 15–20% of a radius at rest. Hard contacts with warm starting hold the load exactly, and the projection removes what drift is left.

**The finger** is a kinematic disc, r = 28 px, that slides to the pointer over the frame. Its velocity is its motion (so a held finger does not push), capped at 3000 px/s. It is a soft contact with a force cap of 80 m/s² per ball and no restitution: it shoves, it does not bat. In a jammed pile it slides over the balls (it is invisible) instead of crushing them.

## Tuning values and why

| Value | Marbles | Balls | Why |
|---|---|---|---|
| restitution ball / wall | 0.6 / 0.5 | 0.86 / 0.84 | short glass clack; rubber clearly bounces (a dropped ball comes back to ~74% of its height) |
| friction ball / wall | 0.2 / 0.25 | 0.75 / 0.8 | glass slides and piles flow; rubber grips and spins |
| back-glass friction | 0.3 | 0.8 | the glass contact that makes balls roll |
| glass rolling resistance (× r) | 0.012 | 0.04 | flat phone: a marble rolls above ~0.7° of tilt and coasts ~3.5 s from 0.3 m/s; rubber needs ~2.3° and slows 3× faster |
| sound: heard above / full at | 0.06 / 1.1 m/s | 0.08 / 1.6 m/s | approach speed; intensity also scales with reduced mass^0.3 |

Sound: the 6 loudest impacts per frame go to `audio.impact('glass' | 'rubber', I, pitch)`, with pitch = (base r / r)^0.8 for marbles and ^0.6 for balls (small ones are higher) and ×0.85–0.9 for a wall. The loudest buzzes `ctx.haptic` above 0.8 (marbles) or 0.7 (balls). A pile at rest makes no sound.

## Look

Each ball is one instanced quad; the fragment shader draws a sphere impostor with an antialiased edge.

- **Glass:** the panel is rendered first into a texture: pale linen with a fine weave, multiplied soft contact shadows (tinted by the glass), and an additive caustic per marble. The marble refracts that texture: in through the front face, along the chord, out through the back face, onto the panel. So you see the linen bent and inverted, the marble's own shadow and caustic, and its neighbours. Inside, along the same ray, in the marble's rotated frame: cat's-eye vanes (3–4 planes sorted by depth), twisted ribbons, or a Beer's-law tint. Then Fresnel reflection of a dim room, a sharp highlight, and a darker refracting rim.
- **Rubber:** opaque glossy rubber with a band, two halves, marbled superball, dots or beach-ball gores, all in the ball's rotated frame, so spin and rolling show.
- **Light:** it hangs "above". It follows the low-passed opposite of gravity (0.6 s), so highlights and shadows move as the phone tilts but not as it shakes.

Panel target size: sim px × 1 / 0.8 / 0.6 (high / medium / low); the weave is off at low, where it would alias.

## Measured

Headless Node, the smoke script's gravity sequence (its 90° turn done as a resize to 852×393 and back, the harder case), all frames checked by brute force over every pair, 8 random fills. Overlap is the deepest ball-ball penetration as a fraction of the smaller radius.

| | worst frame, whole script | frames > 5% |
|---|---|---|
| Marbles high (150) | 8% (shakes); ≤ 6% in every other phase | 14 of 14 400 |
| Marbles medium (105) | 10% (hard shake) | 7 |
| Marbles low (70) | 8% | 3 |
| Balls high (52) | 4% | 0 |
| Balls medium / low | 3% / 8% | 0 / 2 |

- Settled pile, 600 more frames: max displacement 0.0000 px, overlap 0.4% (marbles) / 0.3% (balls). This holds with sleeping turned off too (kinetic energy ~1e-29). The pile falls asleep about 1 s after landing; hand tremor of ±0.15 m/s² never wakes it.
- Finger dragged back and forth through a settled pile at 300 / 1500 px/s: marbles 8% / 12%, balls 1% / 8%. No explosion: no ball goes faster than 1.2 m/s.
- Gravity of 45 m/s² in a random new direction every 0.1 s for 10 s: worst frame 13% (marbles) / 7% (balls), 15 / 3 frames over 5%, nothing outside the box, no NaN.
- In the browser (`tools/smoke.py`, a random fill each run), `worstOverlap` over the whole script, pour-in included, was 11.5%, 5.4% and 8.9% for marbles in three runs, and 1.4%, 2.9% and 4.3% for balls.
- Frame strips at 2× (two balls head-on, a ball dropped onto the pile) show contact and bounce without visible overlap; the engine's per-frame worst across both scenes was 3.4% (marbles) and 0.1% (balls).
- Per-frame cost, in-page `__T` numbers (0.1 ms resolution), headless Chromium at 393×852 and DPR 2, on a shared machine at load average 18–26. Median over 35 frames of an awake pile, tilting / hard shaking, step + render:

  | | 1× CPU | `--throttle 4` |
  |---|---|---|
  | Marbles high (150) | 3.4 / 3.6 + 0.1 ms | 11.8 / 13.6 ms |
  | Marbles medium (105) | 2.1 / 2.2 + 0.1 ms | 9.0 / 9.7 ms (single frames to 15–25 ms) |
  | Marbles low (70) | 1.3 / 1.5 + 0.1 ms | 4.2 / 5.6 ms |
  | Balls high (52) | 1.0 / 1.2 + 0.1 ms | 3.2 / 4.1 ms |
  | Balls medium (38) | 0.8 / 0.8 + 0.1 ms | 2.7 / 2.5 ms |

  A sleeping box costs ~0.02 ms. The step is nearly all of it: two velocity sweeps, the shock sweeps and four projection sweeps, at 16 substeps.

## Not verified headless

Feel on a real phone (scale, bounciness, how long things roll), real-device frame rate and GPU cost of the glass shader at DPR 2 (SwiftShader is not a phone GPU), and how the synthesised clacks sound.
