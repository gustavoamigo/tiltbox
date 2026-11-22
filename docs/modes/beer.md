# Beer: a pint of lager

`src/modes/beer.js` → `src/modes/beer/`:

| File | Holds |
|---|---|
| `mode.js` | The mode: the FLIP liquid mode from `../fluid/liquid.js` with the `BEER` preset, plus the head; sound, stats |
| `tuning.js` | `BEER` (the liquid: water's physics, a lager's look) and `HEAD` (foam, lacing, carbonation) |
| `head.js` | Foam particles, the lacing grid, carbonation bubbles. Reads the liquid sim, never pushes it |
| `render.js` | WebGL2: foam field, foam and lacing composite, bubble sprites, drawn over the liquid |

The liquid engine in `src/modes/fluid/` is used unchanged: Beer only reads its sim (`density`, `dist`, the grid velocities) after each step and draws after its render. Water and Honey are bit-identical to before Beer (same particle state and pixels at fixed steps, checked with the `audio.js` from before and after; see Measured).

## The liquid

Water's physics exactly (FLIP ratio 0.85, no viscosity, free-slip walls, same damping), a little fewer particles (5600/3800/2400 at high/medium/low against water's 6400/4200/2600) to pay for the head. The engine's own whitewater (`foam`) and its foam bubble pass are off: the head is its own system. 55% fill, seeded as a level pool.

Look: plain dark warm glass behind. Gold where shallow (`shallow` 1.0, 0.78, 0.22), amber where deep (`deep` 0.68, 0.38, 0.04 over `deepPx` 230); absorption is weak in red and strong in blue, so the colour deepens with depth instead of going dark. Golden caustics (medium and high) and light shafts, a weak glow near the surface, a bright band under the surface. The sparkle comes from the carbonation sprites.

## The head

**Foam particles** (`head.js`). Light discs (radius 1.12/1.15/1.32 liquid radii at low/medium/high, which gives about the same count at every quality: about 400 at rest). Each frame:
- Out of the liquid a particle falls with gravity (air drag 1.5/s). Under it (liquid fraction `phi` from the sim's cell density, smoothstep 0.3–0.8) it is pulled at 25/s toward the liquid's grid velocity plus a rise of 0.25 m/s against in-plane gravity. So the head rides the sloshing surface and floats back on top whichever way the box points. Upside down, the liquid falls through the foam and the foam floats up through it.
- Position-based push-apart, 3 iterations (same hash walk as the liquid's). Two changes make a deep head hold up:
  - *Stack bias*: of a pair stacked along gravity, the upper one takes 90% of the correction. Shared equally, a head of 10+ layers sinks into itself and the beer.
  - *Capped push velocity*: what the push-apart adds to a velocity, beyond stopping the motion into a neighbour, is capped at 0.1 m/s. Without it, leftover overlaps fling flecks off the top like popcorn.
- Cohesion: once a frame, near-but-apart pairs (up to 1.35× contact) close 40% of their gap. This closes the voids a shake leaves and rounds off spikes. Then XSPH (12% of the relative velocity between touching pairs), so the head moves as one creamy body.
- Side walls grip the foam above the liquid (5/s along the wall), so it clings a little as the liquid moves away.
- Lifetime: rest foam lives an exponential 150 s on average. At its end a particle shrinks away over about 0.6 s and the rest settle into its place. The carbonation feeds the head (1.2 px² of foam per arriving bubble), so it collapses slowly and never vanishes.

**Foaming.** g high-passed over 60 ms (held 0.25 s) drives the foaming, not `env.shake`. A 4–8 Hz hand shake passes at 80–95% of its swing. A tilt, even a quick half-second one, stays under the 4 m/s² threshold, so a tilt keeps the head as it is. `env.shake` (0.35 s low-pass) reads 5–10 m/s² on an ordinary tilt. Agitation is smoothstep(4..14 m/s²), or a finger stirring hard enough that the liquid's mean speed passes 0.15–0.5 m/s (a 1 m/s circling finger, 120 px at 3 Hz, gives about 0.26 m/s and grows the head to about 2.4×; a slow drag or a finger resting during a slosh makes none). At full agitation the head grows 250 px/s across the box, spawned as foam particles just under the surface (at random liquid particles within 2.5 cells of the air), where they float up into the head from below. 90% of shaken foam is coarse and lives 5–18 s; 10% is fine and stays. Carbonation (`co2`, 0..1) limits it: each px of head a shake makes uses 1/1000, and it comes back at 1/90 s. Shaking keeps working but slowly gives less.

**Lacing.** A grid twice as fine as the sim's. Wherever the body of the head stands (particles with 3+ neighbours, not flecks) it deposits 0.6/s, up to 0.8. Each frame the film slides down along gravity at 3.5 px/s, fades with τ 25 s, and is washed off (τ 0.4 s) wherever the liquid covers it. It is drawn only on dry glass, as patches with scalloped holes that shrink as the film fades. Each patch is mostly clear glass: a net of thin bright bubble walls (about 2 px cells) with a whiter rim where the film thickened at its edge. An earlier version filled the patches at 40–70% opacity, which on the dark glass read as grey dirt and covered half the glass after a long shake (see Review).

**Carbonation.** Tracer bubbles: 7 nucleation points fixed on the glass (5 low, 2 high, so streams also run upside down), 8–16 bubbles/s each, active only while under the liquid. Another 18/s start anywhere in the bulk, plus up to 900/s more at full agitation. A bubble moves with the liquid's grid velocity plus a rise of 0.02 m/s + 0.07 m/s² × age (capped at 0.16 m/s), with a small wobble. Its radius grows 0.45 px/s from 0.8–1.4 px. It dies where `phi` < 0.4 (it has reached the surface, and it feeds the head there) or at the end of its life: 7 s upright, down to 0.5 s on a flat phone (linear in in-plane g), and it fades out over its last 0.2 s. On a flat phone a bubble rises toward the viewer through a thin layer and is gone at once; with a 7 s life and the rise scaled by in-plane g, each site's bubbles piled up into a worm-like string (515 bubbles after 10 s flat; now 43, a small fizzing dot at each site).

## Picture (`render.js`)

After the liquid's own passes:
1. The foam particles are splatted (the liquid's splat shader) into their own half-float field, mirrored at the walls, and blurred once. A fleck with fewer than 4 neighbours is splatted up to 3× heavier, so it shows as a fleck instead of vanishing.
2. Carbonation sprites: a bright rim and a twinkling glint.
3. One full-screen composite, premultiplied over the beer:
   - lacing on the dry glass;
   - the foam body: anti-aliased outline from the field gradient, cream colour, a fine Worley bubble texture (cells 2.2 px, up to 4.5 px in fresh foam), brighter on top and on the rim toward the room light, golden and a little see-through just where it meets the beer.
4. Coarse bubbles in fresh foam: faint rings on the foam particles, so they move with the foam.

## Sound

- The liquid's `water` bed (sloshing and drops), as Water has it.
- A new `fizz` bed in `src/audio.js`, added without changing anything else there: a 2 s loop of tiny bubble pops (1100/s; each a 0.15–0.6 ms ringing ping at 2.5–9 kHz; mostly small, a few louder), high-passed at 2.2 kHz, played faster and brighter with `tone`, its level fluttering slowly. The mode sets level = 0.1 at rest, plus bubble arrivals/400 s, plus 0.12 × the shaken head's excess (up to 2×), plus 0.9 × agitation × carbonation; tone = 0.3 + 0.7 × agitation. Rendered offline through `createSynth` (48 kHz, 3 s, last 2 s measured):

| level | tone | RMS dBFS | peak | centroid |
|---|---|---|---|---|
| 0 | 0.5 | silent | 0 | – |
| 0.12 | 0.3 | −43.6 | 0.08 | 5.1 kHz |
| 0.3 | 0.3 | −36.5 | 0.20 | 5.1 kHz |
| 0.7 | 0.5 | −29.5 | 0.47 | 5.6 kHz |
| 1 | 0 / 0.5 / 1 | −27.0 / −26.3 / −25.4 | 0.49–0.63 | 4.4 / 5.6 / 6.8 kHz |

That is 6–9 dB under the water bed at the same level (−19 dBFS at 1, 0.5): a soft fizz under the slosh. Worst case through the master chain (all five beds flat out plus 120 full hits plus 300 glass hits) peaks at 0.81, with 0.07% of samples in the soft clipper's knee. Building the pop loop takes 14 ms on the desktop (sand's crackle: 19 ms), once per audio context, when Beer first starts.

## Measured

Headless Chromium on the development desktop, 393×852 sim px, paused, 60 Hz steps. Head height is `headPx`: the foam's area over the width of the level surface. Visible head is measured at the centre: the foam's top minus the liquid's top. The liquid column is 467 px.

| | medium | high |
|---|---|---|
| Head at rest, t = 0 → 60 s, upright | 64.2 → 56.2 px (13.7% → 12.0%) | 60.6 → 52.8 px |
| Same, phone held back (g 0, 6.9, 6.9) | 64.3 → 54.7 px | → 51.9 px |
| Visible head at rest | 52–60 px | 33–45 px |
| 20 m/s², 1 s, 6 Hz shake: head before → peak | 64.9 → 233.9 px (×3.6) at 3 s | 61.0 → 231.4 px (×3.8) |
| …at 5 / 10 / 15 / 20 / 30 / 40 s | 232 / 184 / 121 / 70 / 67 / 64 px | 231 / 178 / 119 / 69 / 66 / 65 px |
| Bubble rise (median, by age 0 / 0.5 / 1 / 1.5 / 2 s) | 0.038 / 0.072 / 0.107 / 0.141 / 0.159 m/s | same |
| Liquid `fillFraction` over 3000 frames (shakes up to 45 m/s², two flips, tilts, flat) | 0.552 → 0.551; min 0.502 (spray just after a flip), mean 0.548 | 0.550 → 0.550; min 0.500 |

Per-frame CPU (step + render, medians over 6 chunks of 10 frames; the machine is shared, so repeat before trusting a digit):

| | Beer | Water |
|---|---|---|
| high, held back, at rest | 2.6 ms | 2.4 ms |
| high, shaking / big head | 3.1–3.2 ms | 2.3 ms |
| high, upside down after a shake | 4.0 ms | 3.2 ms |
| medium at 4× CPU throttle, at rest | 7.4 ms | 6.8 ms |
| medium ×4, shaking / big head | 9.8–10.0 ms | 6.6 ms |
| medium ×4, upside down after a shake | 12.6 ms | 8.9 ms |

The head's own share: about 0.4 ms at rest and 1.3–1.7 ms with a shaken head of 1200–2100 particles, mostly the push-apart (about 11 ns per candidate pair). `tools/smoke.py beer water honey` passes, with and without `--throttle 4`.

Water and Honey were checked deterministically: each mode was created while paused and run through a fixed script (settle, 30° tilt, a 20 m/s² shake, held back, upside down). The particle-state hashes and screenshots are identical with the `audio.js` from before the fizz bed and with the new one, and between repeated runs. Nothing in `src/modes/fluid/` changed.

## Review (second pass)

An independent check in the owner's posture (g 0, 6.9, 6.9) and upright, at high (the iPhone's level) and medium, found three things and fixed them in `render.js`, `head.js` and `tuning.js`:

| | before | after |
|---|---|---|
| Lacing: share of the top 40% of the screen covered, 10 / 20 / 45 s after a 15 m/s², 1.5 s shake | 30 / 18 / 4% (flat grey fill) | 27 / 9 / 3% (lace net) |
| Lacing 30 s after a 20 m/s², 5 s shake | 51% covered, grey camouflage blotches | 24%, lace patches |
| Bubbles after 10 s on a flat phone | 515, piled into strings at the sites | 43, a fizzing dot at each site |
| Foam made by a finger circling at 0.5 / 1.1 / 1.8 m/s | 0 / 0 / 849 particles | 0 / 475 / 2337 |

Unchanged and rechecked: head at rest 60 px (held back, high), a gentle 25° tilt and back makes no foam, a 2 s turn-over makes none, a 0.15 s 25 m/s² flick grows the head 60 → 99 px, a 15 m/s² 1.5 s 6 Hz shake 60 → 245 px, back to 69 px at 20 s. `tools/smoke.py beer water honey` passes, also with `--throttle 4`. Smoke's instant flips (a step in g) read as a shake to the 60 ms high-pass and foam the head; a real turn-over does not.

## Not verified here

Feel and look on a real phone: how a real shake drives the high-pass, the extra full-screen pass and splat on a phone GPU (headless measures CPU only), and how the fizz sounds through a phone speaker (judged here only from levels and spectrograms).
