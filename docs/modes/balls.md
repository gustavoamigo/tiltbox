# Balls engine (Marbles, Balls)

`src/modes/balls/`: a rigid-ball engine for the thin box, one layer of spheres seen from the front. `marbles.js` and `balls.js` are presets of it.

| File | Holds |
|---|---|
| `engine.js` | `BallWorld`: the physics |
| `presets.js` | materials, sizes, counts, per-ball looks, `buildWorld` (shared by the mode and headless tests) |
| `mode.js` | the mode: world + renderer + light + sound + stats |
| `render.js`, `shaders.js` | WebGL2: back panel, shadows and caustics, sphere impostors |

## World and units

Positions in sim px, time in s. Gravity arrives in m/s² (after the shake exaggeration below) and is scaled by `pxPerM`: 3200 for marbles, 3000 for rubber balls. A phone screen is about 5500 CSS px/m, so the box reads a little bigger than the phone (falls are a little slower than life, so they are watchable). Radii follow the box area so the balls cover a fixed fraction of it (`fill`: 0.36 marbles, 0.34 balls). On a 393×852 box the mean marble is 16 px (5 mm) in three sizes (13, 16, 21 px), and the rubber balls run from 17 to 51 px in four sizes. Mass ∝ r³ for marbles, r^2.5 for rubber balls (at r³ the biggest would be 25× the smallest and barely move when hit). Counts by quality are 70/105/150 marbles and 26/38/52 balls, scaled by −25% to +15% with the box area.

## How a step works

Each ball is a disc with full 3D spin and an orientation quaternion. In-plane contacts (ball, wall, finger) act on (vx, vy, wz), plus a twist-friction row that damps spin about in-plane axes. The back glass (front glass if `g.z < 0`) is a friction contact per ball, pressed by `|g.z| + glassBase`. It couples (vx, vy) with (wx, wy), so a ball pressed against the glass rolls on it, ω_xy = (ẑ × v)/r, with rolling and spinning resistance. A marble on a tilted flat phone rolls with zero slip, and its pattern turns about the in-plane axis.

Substeps run at 960 Hz (16 per 60 Hz frame; at most 24 per step, so a 30 fps frame runs at 720 Hz instead of doubling the work). Contacts are found every K substeps by a uniform grid with speculative margins: a contact lets its pair close exactly the gap and no more. The margin covers twice the fastest speed (a resting pair can be knocked together by a third ball mid-pass) plus the most that projection may move a ball. K (1–4) is chosen so the fastest ball moves at most 0.25 r_min between passes. Speeds are capped at `subTravel` (0.45) × r_min per substep at 960 Hz, and never above `maxSpeed` (9000 px/s): on a 393×852 box that is 7160 px/s (2.4 m/s) for rubber balls and 5420 px/s (1.7 m/s) for marbles. The cap used to be a flat 5000 px/s (1.67 m/s rubber), which a ball dropped from the top of the box already reaches, so a drop came back to 44% of its height instead of 74%, and nothing thrown could rise more than half the box. Each substep:

1. gravity, light damping, speed limits;
2. warm start. Resting contacts carry their impulse to the next substep. Contacts that were closing faster than the bounce threshold do not: re-applying an impact impulse throws whole piles apart;
3. two velocity Gauss-Seidel sweeps over **hard** contacts (normal, Coulomb friction with spin, twist, rolling resistance), contacts ordered bottom-up along the load direction. Then the glass rows;
4. **shock propagation** (after Guendelman et al. 2003). The balls are visited bottom-up along d = g·0.03 s + mean velocity: d is g for a pile at rest, and points at the wall a flying pile is about to hit. When a ball is reached, its supports (lower balls, walls) are final. Its velocity takes the least change that stops it closing on all of them, an exact 2D problem: at most two constraints are active, so every single and pair is tried. A second sweep does the same top-down against what the ball supports. If no small answer exists (a ball driven into a wall by what is under it), that ball is left to step 3. This is what stops a pile landing on the floor in one substep; plain Gauss-Seidel needs a sweep per layer and lets the layers sink into each other meanwhile;
5. positions;
6. **position projection**: three mass-weighted sweeps that remove 70% of each overlap, then a bottom-up exact-move sweep as in step 4. Velocities are not touched, so no energy is added. A ball may move at most 0.2 r_min this way per pass; once one has, the pass ends early and contacts are found again.

Passes with fast-closing contacts (a pile landing, a ball batted into the pile) get one extra sweep of each kind per 0.25 m/s of closing speed, up to 8. Restitution is applied once per pass to contacts that were closing faster than `restThreshold` (0.12 m/s marbles, 0.1 balls): slower approaches do not bounce, so piles come to rest. If anything still overlaps more than 2% at the frame end, up to two position-only passes clean it up, because the frame end is what is drawn and what `maxOverlap` reports; more than 6%, up to six. The deep case is a whole pile slammed into a wall at the speed cap by a hard shake, which wedges the bottom row between the side walls: with two rounds a single frame reached 66%.

When every ball has moved slower than 3 px/s for 0.5 s, the box sleeps and nothing moves until the true gravity (`env.g`, not the exaggerated one) changes by 0.35 m/s², a finger comes near, or the box resizes. A resize scales positions and then relaxes overlaps immediately (positions only).

**Why hard contacts plus projection, not soft contacts.** The earlier draft used Box2D v3 soft contacts. A soft contact under load F sinks F/k into its neighbour, and the bottom row of a 12-layer marble pile carries about 60 ball weights sideways (the rows above wedge it apart). At any stiffness the substep rate allows, that is 15–20% of a radius at rest. Hard contacts with warm starting hold the load exactly, and the projection removes what drift is left.

**Shake exaggeration** (`boxGravity` in `presets.js`, called by `mode.js`). The engine gets `gSlow + k·(g − gSlow)` in the screen plane, z left true: a slow tilt is true, the shake is multiplied by `shakeGain` = 3. At true scale a 15 m/s² hand shake at 6 Hz moves the phone 1 cm at 0.4 m/s and threw nothing (no ball rose more than 8% of the box); a 20 m/s² flick that starts and stops the phone lifted the pile by 3–6%. The first 0.5 m/s² of shake (`shakeDeadband`) passes at gain 1, so hand tremor (±0.15) is not tripled: tripled, it kept an awake pile from ever falling asleep and let it creep tens of px. The result is clamped to `maxG` in plane: 45 m/s² for rubber, 30 for marbles (a 150-marble pile slammed down at 45 wedged its bottom row, single frames to 30% overlap). The gain adds no momentum on average (g − gSlow is high-passed); it throws balls because the floor pushes but cannot pull, as with a real flick.

A turn faster than about a second is partly shake too, because gSlow lags it: held tilted back, a 30° turn over 0.5 s swings the box's "down" to 50° before it settles back to 30° (over 0.2 s: 58°), and a 90° turn over 0.3 s swings it to 123° with up to 17 m/s² in plane. So quick turns throw the pile a little past where it ends up; slow ones are exact. This was kept: it reads as the box being swung, and it is part of what makes a turn feel immediate.

**The finger** is a kinematic disc, r = 28 px, that slides to the pointer over the frame. Its velocity is its motion (so a held finger does not push), capped at 3000 px/s. It is a soft contact with a force cap of 80 m/s² per ball and no restitution: it shoves, it does not bat. In a jammed pile it slides over the balls (it is invisible) instead of crushing them.

## Tuning values and why

| Value | Marbles | Balls | Why |
|---|---|---|---|
| restitution ball / wall | 0.6 / 0.5 | 0.9 / 0.88 | short glass clack; superball (a ball dropped upright comes back to 75% of its height) |
| friction ball / wall | 0.2 / 0.25 | 0.75 / 0.8 | glass slides and piles flow; rubber grips and spins |
| rolling resistance at ball / wall contacts (× r) | 0.008 | 0.01 | was 0.03 for rubber, which held a ball on the floor of a tilted-back phone |
| back-glass friction | 0.3 | 0.2 | the glass contact that makes balls roll. Was 0.8 for rubber: held tilted back (g ≈ (0, 6.9, 6.9)), a ball rolls down the glass, and when it bounces off the floor its spin is the wrong way, so glass friction took most of the bounce (a drop came back to 32% of its height) |
| glass rolling resistance (× r) | 0.012 | 0.025 | flat phone: a marble rolls above ~0.7° of tilt and coasts ~3.5 s from 0.3 m/s; rubber needs ~1.5° (0.04 before; at 0.015 hand tremor kept a pile on a flat phone creeping) |
| glass spinning resistance (× r) | 0.02 | 0.02 | was 0.08 / 0.25. A ball rolling along the floor spins about z, which this resists, pressed by |g.z|: held tilted back, a lone rubber ball on the floor did not move at all on a 5° or 10° turn |
| shake gain / deadband / most in-plane g | 3 / 0.5 / 30 | 3 / 0.5 / 45 | see shake exaggeration |
| sound: heard above / full at | 0.06 / 1.1 m/s | 0.08 / 1.6 m/s | approach speed; intensity also scales with reduced mass^0.3 |

Sound: the 6 loudest impacts per frame go to `audio.impact('glass' | 'rubber', I, pitch)`, with pitch = (base r / r)^0.8 for marbles and ^0.6 for balls (small ones are higher) and ×0.85–0.9 for a wall. The loudest buzzes `ctx.haptic` above 0.8 (marbles) or 0.7 (balls). A pile at rest makes no sound.

## Look

Each ball is one instanced quad; the fragment shader draws a sphere impostor with an antialiased edge.

- **Glass:** the panel is rendered first into a texture: pale linen with a fine weave, multiplied soft contact shadows (tinted by the glass), and an additive caustic per marble. The marble refracts that texture: in through the front face, along the chord, out through the back face, onto the panel. So you see the linen bent and inverted, the marble's own shadow and caustic, and its neighbours. Inside, along the same ray, in the marble's rotated frame: cat's-eye vanes (3–4 planes sorted by depth), twisted ribbons, or a Beer's-law tint. Then Fresnel reflection of a dim room, a sharp highlight, and a darker refracting rim.
- **Rubber:** opaque glossy rubber with a band, two halves, marbled superball, dots or beach-ball gores, all in the ball's rotated frame, so spin and rolling show.
- **Light:** it hangs "above". It follows the low-passed opposite of gravity (0.6 s), so highlights and shadows move as the phone tilts but not as it shakes.

Panel target size: sim px × 1 / 0.8 / 0.6 (high / medium / low); the weave is off at low, where it would alias.

## Measured: liveliness (owner feedback "they should kick more")

Headless Node (`BallWorld` from `presets.js`, the shell's gravity path rebuilt: synthetic pulses as in `motion.js`, the 0.35 s low-pass, `boxGravity`), high quality, 393×852, mean of 4 fills. "Before" is the old tuning (gain 1, flat 5000 px/s cap, the old glass and rubber values); "after" is the current one. A flick is `pulse(20, 0.2 s)`: one-sided (the phone ends up moving, as `__T.shake` does) and two-lobed (the phone moves up and stops, as a hand does). Rise: the most any ball rose above where it rested, as a fraction of the box height. Airborne: balls touching nothing (0.5 px).

| | before, tilted back (0, 6.9, 6.9) | after | before, upright (0, 9.81, 0) | after |
|---|---|---|---|---|
| Rubber: flick, rise / airborne peak (two-lobed) | 5% / 8% | 60% / 59% | 3% / 6% | 58% / 60% |
| Rubber: flick, one-sided | 31% / 16% | 61% / 53% | 23% / 24% | 59% / 73% |
| Rubber: 15 m/s² 6 Hz shake up-down, rise / airborne peak / mean | 5% / 9% / 2% | 62% / 78% / 34% | 4% / 6% / 1% | 61% / 75% / 30% |
| Rubber: same, sideways | 2% / 6% / 1% | 66% / 59% / 27% | 4% / 8% / 2% | 69% / 48% / 22% |
| Rubber: drop from 77% of the box, first bounce / bouncing for | 32% / 1.0 s | 51% / 1.5 s | 44% / 1.5 s | 75% / 2.5 s |
| Rubber: lone ball on the floor, 10° turn, distance in 0.4 s | 0 px | 98 px | 192 px | 249 px |
| Rubber: lone ball asleep on the floor, 5° turn over 0.25 s: moving at / distance in 1 s | never / 0 px | frame 15 / 103 px | frame 11 / 161 px | frame 8 / 167 px |
| Marbles: flick two-lobed, rise / airborne peak | 6% / 2% | 58% / 20% | 4% / 3% | 57% / 26% |
| Marbles: 15 m/s² 6 Hz up-down, rise / airborne peak | 8% / 3% | 55% / 22% | 5% / 3% | 57% / 32% |
| Marbles: same, sideways | 6% / 3% | 50% / 19% | 8% / 4% | 40% / 18% |
| Marbles: drop, first bounce | 13% | 13% | 15% | 24% |
| Marbles: lone ball on the floor, 10° turn, in 0.4 s | 70 px | 131 px | 283 px | 285 px |
| Marbles: lone ball asleep, 5° turn: moving at / distance in 1 s | never / 0 px | frame 12 / 179 px | frame 8 / 180 px | frame 8 / 180 px |

A sleeping box wakes on a 5° turn spread over 15 frames at frame 7–9, when the true gravity has changed by 0.35 m/s² (unchanged; ±0.15 m/s² tremor still never wakes it). A settled pile does not flow on a 5° turn, before or after: 5° is far below a pile's angle of repose, so it shifts by a few px (marbles: up to 19 px) and sleeps again. A gentle 2.5 m/s² shake jiggles a pile (fastest ball 0.2–0.3 m/s, was 0.07–0.1) but throws nothing. Rubber rolling along the floor of a tilted-back phone reaches about two thirds of a lossless roll in the corner between floor and glass (both contacts make it spin).

Known limit: a rubber pile thrown as one lump (a flick from rest) flies to the ceiling and back together and lands nearly dead; only the balls on top keep bouncing, for about half a second. A sideways shake, which breaks the pile up, looks much livelier than a flick. Measured (review, 2026-11-22): a settled rubber pile lifted 300 px and dropped upright comes back 0–5 px on average (the best ball 34–44 px), where a lone ball would come back 230 px; 0.3 s after a flick 1% of the balls are in the air, 2% after a long shake. The cause is not shock propagation (with it switched off the dropped pile lands just as dead) but restitution on contacts that were closing at the pass start: in a lump only the bottom row's floor contacts are, so the bottom row bounces into the pile above, which shares that out inelastically over the following substeps. What was tried, in a scratch copy, and dropped:
- More restitution sweeps per pass (a bounce passed on as a Newton's cradle): a pile slammed into the floor kept 4–19% of its energy instead of 1–2%; little visible difference.
- Poisson restitution per ball (each ball gets its contact velocity change back × e): a pile slammed while touching bounced back with 23–65% of its energy, but the shock sweeps treat supports as infinitely heavy, so it created energy: a poured pile boiled and never settled. Capping each ball's shock part at e × its own approach, and the kicks at the energy the balls had, stopped the boiling but a pile that lands loosely (as after a flick) was dead again: it lands over a dozen substeps, a sequence of collisions that each lose 1 − e² (inelastic collapse; real granular piles do the same, less so because rubber is soft).
- Lower glass friction for rubber (0.1): a lone drop in the tilted-back hold comes back to 61% of its height instead of 51%, but a pile on a flat phone under hand tremor crept up to 76 px in 10 s.


Awake pile under continuous tremor (±0.15 m/s² white noise per axis, 10 s, 6 fills): rubber settles and sleeps 74–100% of the time, creeping ≤ 1.5 px upright or tilted back and 2.5 px (worst 9 px) flat; before, 98–100% and ≤ 0.2 px. Marbles creep 1–16 px and sleep 27–80% of the time, as before (0.3–15 px, 30–91%). A second set of 4 fills (review): rubber flat crept 0.3–14 px and one fill never slept in the 10 s; upright and tilted back ≤ 2 px.

Review measurements of the current tuning, high quality, 393×852, mean of 3–4 fills (tilted back / upright):
- A settled rubber pile turned by 10° / 20° / 30° over 0.25 s: the farthest ball moves 4 / 48 / 160 px tilted back, 11 / 28 / 254 px upright; 0 / 4 / 11% (upright 0 / 3 / 18%) of the balls move more than their radius in 1.5 s. Rubber at friction 0.75 locks like gears; a lone ball rolls at once. Marbles: 10 / 104 / 215 px.
- The finger swiped sideways through the top of a rubber pile at 3000 px/s throws balls up 53% / 41% of the box (fastest 1.7 m/s); at 1500 px/s, 20% / 15%; flicked up from inside the pile, 63%.
- A 2.5 m/s² 5 Hz shake jiggles a pile (fastest ball 0.23–0.26 m/s, 1% rise) and throws nothing.

## Measured

These were measured with the earlier tuning unless marked; the overlap and cost figures after the liveliness change are at the end.

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

- **After the liveliness change** (shake gain, speed cap, glass values), the same smoke-sequence stress extended with owner-style flicks and shakes in both holds, 8 fills, every frame: worst frame marbles 9.9 / 16.5 / 10.4% (high / medium / low), frames over 5% 58 / 28 / 7 of 21 840 (old tuning on the same script: 17.2 / 10.4 / 9.9%, 260 / 24 / 89 frames); rubber 5.1 / 5.4 / 5.7%, 1 / 1 / 2 frames (old: 6.8 / 6.9 / 5.2%, 5 / 2 / 1). Hard flicks and shakes only, 12 fills × 2 holds, 18 000 frames: marbles high 42 frames over 5%, 3 over 10%, none over 20%, worst 12.3% (old 98 / 15 / 0, 12.6%); rubber 6 frames over 5%, worst 9.4% (old 5, 8.4%). Settled piles: still 0.0000 px displacement in 600 frames, overlap 0.4% / 0.3%, sleep on or off, in all three holds. No NaN, nothing outside. (Review, 6 more fills: with sleeping switched off, one upright marble pile crept 1.0 px in 600 frames and another 0.05 px, at kinetic energy ~5e-10; with glass spinning resistance back at 0.04 neither moves, but a lone marble tilted back by 5° then rolls 99 px in 1 s instead of 171. Kept at 0.02: with sleeping on, which is always, the pile is asleep. Owner-style flicks and shakes, 4 fills × 2 holds, 6000 frames, worst / frames over 5%: marbles 13.7% / 10 (high), 8.6% / 6 (medium), 8.1% / 6 (low); rubber 5.3% / 2, 2.3% / 0, 3.4% / 0. The same at 30 fps frames (dt 1/30, 720 Hz substeps): marbles high 10.7% / 17, rubber high 9.2% / 3.)
- Cost after the change, in-page, DPR 2, median of 35 frames of an awake pile (tilting / shaking upright / shaking tilted back), old → new tuning on the same machine and run: marbles high 2.4 → 2.7 / 2.2 → 2.6 / 2.9 → 4.0 ms, medium 1.7 → 2.0 / 1.5 → 1.8 / 1.9 → 2.6 ms; with `--throttle 4` marbles medium 7.1 → 8.8 / 5.9 → 7.1 / 8.3 → 10.2 ms; rubber high 0.8 → 1.0 / 0.8 → 1.0 / 1.0 → 1.6 ms. More balls are moving fast, so more passes run at one substep and with extra sweeps.

## Not verified headless

Feel on a real phone (scale, bounciness, how long things roll, whether a shake gain of 3 feels right with real sensor signals rather than synthetic pulses), real-device frame rate and GPU cost of the glass shader at DPR 2 (SwiftShader is not a phone GPU), and how the synthesised clacks sound.
