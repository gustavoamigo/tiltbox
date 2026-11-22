# Sand engine

`src/modes/sand.js` → `src/modes/sand/`: dry sand as grains on a fine grid, at most one grain per cell, each carrying a velocity. Piles follow cellular-automaton rules measured against real angles; anything that falls or is thrown moves ballistically, cell by cell.

| File | Holds |
|---|---|
| `grid.js` | `SandGrid`: the physics. DOM-free, so it runs in Node for tests |
| `fill.js` | the starting sand: wavy sand-art bands, per-grain colour |
| `render.js` | WebGL2: background with the pile's shadow, grain sprites, glass |
| `mode.js` | the mode: quality, sound, haptics, stats |

## Why a grid and not discs

The brief offered three approaches. A position-based disc solver (Macklin et al. 2014) was built first and measured in Node on the full 393×852 box:

| | PBD discs (r 2.4 px, 5400) | grid (2.8 px cells, 15 000) |
|---|---|---|
| pile at rest | never fully settled: 2–45% of grains above 20 px/s, creeping | exact: 0 grains change cell |
| repose after a 50° tilt | 50–56°, still moving | 36.5°, settled in < 2 s |
| CPU, settled | 7–10 ms a frame | ~0 (everything asleep) |
| CPU, worst (all grains flying) | 12–14 ms | 3.5–4.5 ms |

PBD's trouble is weight: one Gauss-Seidel sweep a substep cannot carry a pile 70 grains deep. Sweeping in exact height order with lopsided shock-propagation weights made a narrow pile settle. Then any leftover overlap became upward speed and the pile boiled; splitting each contact into "new approach" (velocity) and "old overlap" (a move without velocity) stopped the boiling. A full-width pile still crept, and the cost was 3× the budget before drawing anything. The grid is exactly still at rest, about ten times cheaper per grain, and fine enough to look like sand.

## World and units

Sim px and seconds; velocities in px/s; gravity arrives in m/s² and is scaled by `PX_PER_M = 3000`, so the 852 px box is a 28 cm bottle and falls are a little slower than life, which makes them watchable. Cells are `cell` px (fitted so the grid exactly covers the box), and each holds one grain: 2.8 / 3.4 / 4.0 px at high / medium / low, 15.3k / 10.4k / 7.5k grains on a 393×852 box filled to 36%. Speed is capped at 3000 px/s (1 m/s). The occupancy grid has a border of wall cells 3 deep, so lookups need no bounds checks.

## A step

Substeps are at most 1/180 s. While fewer than 12% of the grains are awake (an avalanche, a trickle) they are 1/480 s, because the pile rules move a grain one cell per substep and are cheap when few grains run them.

Each substep visits the cells from the leading edge along gravity (rows or columns, whichever axis gravity is nearer, and from the side gravity leans to). Only awake grains are visited, and only lines with awake grains, within the span they occupy. "Below" for a grain is one of the eight grid directions: one of the two nearest to gravity, picked per grain and substep in proportion to the angle between them.

A grain is **supported** if the cell below is a wall, or a grain that is asleep or already at rest this substep. Because the grain below was visited first, a pile whose floor drops away (the box turned over) falls as one rigid block: measured displacement spread across the whole pile 0 cells after 12 frames of fall. A resting grain that loses its support wakes the three cells above it, which the sweep then reaches in the same substep.

**Flying** (unsupported, or faster than 200 px/s): gravity, then Coulomb friction from the back glass (it removes up to `MU_GLASS·|g.z|·h` of speed), then travel along the velocity. The path is read cell by cell (full step, else its larger axis part, else the smaller) and the grain is written once where it ends. A blocked axis is an inelastic collision. The grain loses its approach speed toward the obstacle and, by Coulomb friction, up to `MU` times that much of its sideways speed. A loose grain it hits gets `SHARE` of the push. A hit harder than 400 px/s scatters it by a random 8% of the excess, which turns slams into spray.

**Resting** (supported and slow):
1. no free neighbour: inside the pile. Within `SLAB` cells of a surface steeper than repose, it moves along that slope when the grain ahead has made room; otherwise it sleeps;
2. a free neighbour lying more than `REPOSE` below level, measured against gravity and not the grid: it goes there. This topples spikes and overhangs;
3. otherwise the surface normal is the sum of the offsets of the free cells in a disc of radius 3. If the slope is steeper than `REPOSE`, or than `REPOSE_FLOW` while the grain is already sliding, the grain moves to the free neighbour most nearly downhill along it. It gains about half of g along the slide per substep, so a long slope turns into a fast surface flow. A grain sliding past wakes those within 2 cells and makes them count as sliding for `STIR` substeps: the flowing layer drags the one under it down to the flow angle;
4. nothing to do: after `ACTIVE` substeps without moving it falls asleep (velocity and sub-cell offset cleared).

Gravity turning more than 1.5°, or the back glass starting or stopping to hold the sand, wakes every grain with a free neighbour so the surface looks at its slopes again. On a flat phone (`MU_GLASS·|g.z|` above the in-plane gravity) nothing moves at all.

**Fingers** are 24 px discs swept from last frame's position to this one across the substeps. Each grain under one is shoved out along a line of cells: the most nearly outward direction, leaning "up", that reaches a free cell within 90 cells. The whole line shifts one cell into it. Deep in the pile the sand above the finger rises; near the surface the finger digs a trench that slumps back behind it. The grains nearest the finger take half its speed, so a flick throws sand.

**Resize**: if the grid size changes, the sand is stacked afresh against the wall gravity points at. Each line across that wall keeps about its grains, in their old order, so the heap's profile and the colour layers survive.

## Drawing

1. Full-screen quad: a dark warm gradient, lighter toward "up". Inside the sand, from the occupancy texture (one byte a cell, the max of four samples half a cell apart, which closes one-cell gaps), a dark sand tone, so gaps between grains read as shadow instead of black holes.
2. Grains as point sprites 1.4 cells across, with a fixed random sub-cell offset each so resting sand shows no lattice. Each grain is lit by the sand above it, read from the occupancy texture along "up" at 1.3, 3, 6, 11 and 18 cells plus two flanks. The free surface is brighter and deep sand darker, so a heap reads as a heap. In the sprite, a grain is a little brighter toward "up" and darker at its rim. About 4.5% of grains are glassy and glint when the tilt reaches their facet angle.
3. Glass: a faint sheen band that drifts with the tilt and a darker rim, one blended quad.

Positions and the occupancy texture are uploaded only when something moved. The start state is eight wavy bands of natural sand colours with one slate layer for contrast. Each grain gets ±10% lightness and a warm/cool cast; 3% are dark mineral specks and 1.5% pale quartz. It is filled settled, so the start screen shows still sand.

## Sound and touch

`audio.bed('sand')`: level `sqrt(6 × fraction of grains faster than 30 px/s)`, tone from their mean speed / 900 px/s, both smoothed over 60 ms. Hard hits (speed lost above 400 px/s, per grain) trigger up to four `grain` ticks a frame. A slam of the whole pile gives a haptic buzz (at most every 120 ms).

## Tuning (`P` in grid.js)

| Constant | Value | Why |
|---|---|---|
| `REPOSE` | 42° | A grid surface comes in steps: 1:2 is 26.6°, 2:3 is 33.7°, 1:1 is 45°. At 42° a resting 2:3 slope holds and 1:1 does not. Measured: heaps 32°, a tilted level surface starts to slide past ~42° |
| `REPOSE_FLOW` | 37° | Flowing sand stops above the 2:3 step, so avalanches end near 35°; at 34° they ran down to the 1:2 step (26.6°) |
| `MU` | 0.6 | Coulomb friction of a blocked move; sand landing on a slope stops within a few cells |
| `MU_GLASS` | 0.32 | A flat phone holds the sand up to 3.1 m/s² of in-plane gravity (a 18° tilt of a flat-lying phone) |
| `SHARE` | 0.4 | A hit grain gets a push only if it is loose (free cell beyond), so pushes do not ripple through the whole pile |
| `V_SLIDE` | 200 px/s | Below this a supported grain follows the pile rules; above, it is in flight over the surface |
| `SLIDE_G` | 0.5 | Speed a sliding grain gains per substep, as a fraction of g·h |
| `SLAB`, `NR` | 6, 3 cells | Depth of the layer that slides under a steep surface; radius of the slope window (2 gave noisier normals and slower avalanches) |
| `ACTIVE`, `STIR` | 6, 2 substeps | How long a grain counts as sliding after moving, or after a neighbour slid past |
| `SCATTER`, `V_SCATTER` | 0.08, 400 px/s | Spray from slams. A random kick to all flying grains during shakes was tried and dropped: it sheared a falling block into vertical streaks |
| `V_MAX` | 3000 px/s | Keeps a flip's cost bounded (cost grows with cells travelled); a flip takes ~0.3 s instead of the free-fall 0.24 s |
| `SUB_DT`, `SUB_DT_FEW`, `FEW` | 1/180, 1/480 s, 12% | See "A step" |
| `PUSH` | 90 cells | How far a finger looks for room; 30 was too short for a finger deep in the pile |

## Measured

Node, full box, high quality (2.8 px cells, 14.8–15.3k grains):
- poured heap (a 4-cell stream from the middle): flanks 31.8° and 32.2°, `reposeAngle` 32.4°;
- settled, upright: 0 grains change cell;
- tilt 20°: 0 grains change cell in 2 s (holds);
- tilt 50°: 8.9% of the grains move, all asleep again within 2 s, `reposeAngle` 36.5°;
- flat on a table (g = 0, 0.3, 9.81): 0 grains change cell;
- turned over: the pile falls as a rigid block (every grain displaced by the same number of cells).

Headless Chromium, `tools/smoke.py` (393×852, DPR 1): every phase passes, `nan` false, `outside` 0. `reposeAngle` reads 31° after the 30° tilt (it holds) and 36° after the 60° tilt avalanche.

Per-frame step + render CPU (`__T.step(1)` one frame at a time through the smoke script's phases, the machine shared with other runs, load ~20):

| | mean | p95 | worst frame |
|---|---|---|---|
| high | 1.2 ms | 4.9 ms | 13–21 ms (first frame of a flip or tilt) |
| medium, `--throttle 4` | 3.1 ms | 10.7 ms | 35 ms (hard shake) |
| low, `--throttle 4` | 2.2 ms | 8.7 ms | 37 ms |

At rest the step is ~0. The heavy frames are the ones where every grain flies: a hard shake (high: 3.2 ms mean over that phase, p95 11.5) and the first 10–15 frames of turning the box over (p95 9 ms).

## Limits

- It is a lattice. Resting sand sits on cells (hidden by per-grain offsets). A slope's angle can only take the grid's steps, so the repose angle is reached by thresholds tuned to them, not by friction alone.
- An avalanche flows as a thin surface layer plus `SLAB`; a 50° tilt of a level surface takes about 1.5–2 s to settle, slower than real sand in a box this size.
- A hard shake dilates the pile into rows and columns with one-cell gaps; the shadow fill hides most of them, but some seams show while it is shaking.
- A finger shoves straight lines of grains, which smears the colour bands into streaks along the push direction.
- Frames where all grains fly (flip, hard shake) cost 3–4× a typical frame; on a mid-range phone at medium they may drop to ~30–40 fps for a moment.
