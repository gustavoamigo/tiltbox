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

Sim px and seconds; velocities in px/s; gravity arrives in m/s² and is scaled by `PX_PER_M = 3000`, so the 852 px box is a 28 cm bottle and falls are a little slower than life, which makes them watchable. Cells are `cell` px (fitted so the grid exactly covers the box), and each holds one grain: 2.0 / 2.5 / 3.0 px at high / medium / low, 30k / 19k / 13k grains on a 393×852 box filled to 36% (the owner asked for finer sand; until then 2.8 / 3.4 / 4.0 px, and the measurements below were taken at 2.8). At 2.0 px a hard shake costs about 10.6 ms a step headless, against 7 ms at 2.8; auto quality drops a slow phone to medium. Speed is capped at 3000 px/s (1 m/s). The occupancy grid has a border of wall cells 3 deep, so lookups need no bounds checks.

## A step

Substeps are at most 1/180 s. While fewer than 12% of the grains are awake (an avalanche, a trickle) they are 1/480 s, because the pile rules move a grain one cell per substep and are cheap when few grains run them. While the bed is shaken loose (below) they are 1/120 s, because thousands of grains are awake then.

Each substep visits the cells from the leading edge along gravity (rows or columns, whichever axis gravity is nearer, and from the side gravity leans to). Only awake grains are visited, and only lines with awake grains, within the span they occupy. "Below" for a grain is one of the eight grid directions: one of the two nearest to gravity, picked per grain and substep in proportion to the angle between them.

A grain is **supported** if the cell below is a wall, or a grain that is asleep or already at rest this substep. Because the grain below was visited first, a pile whose floor drops away (the box turned over) falls as one rigid block: measured displacement spread across the whole pile 0 cells after 12 frames of fall. A resting grain that loses its support wakes the three cells above it, which the sweep then reaches in the same substep.

**Flying** (unsupported, or faster than 200 px/s): gravity, then Coulomb friction from the back glass (it removes up to `MU_GLASS·|g.z|·h` of speed), then travel along the velocity. The path is read cell by cell (full step, else its larger axis part, else the smaller) and the grain is written once where it ends. A blocked axis is an inelastic collision. The grain loses its approach speed toward the obstacle and, by Coulomb friction, up to `MU` times that much of its sideways speed. A loose grain it hits gets `SHARE` of the push. A hit harder than 400 px/s scatters it by a random 8% of the excess, which turns slams into spray.

**Resting** (supported and slow):
1. no free neighbour: inside the pile. Within `SLAB` cells of a surface steeper than repose, it moves along that slope when the grain ahead has made room; otherwise it sleeps;
2. a free neighbour lying more than `REPOSE` below level, measured against gravity and not the grid: it goes there. This topples spikes and overhangs;
3. otherwise the surface normal is the sum of the offsets of the free cells in a disc of radius 3. If the slope is steeper than `REPOSE`, or than `REPOSE_FLOW` while the grain is already sliding, the grain moves to the free neighbour most nearly downhill along it. It gains about half of g along the slide per substep, so a long slope turns into a fast surface flow. A grain sliding past wakes those within 2 cells and makes them count as sliding for `STIR` substeps: the flowing layer drags the one under it down to the flow angle;
4. nothing to do: after `ACTIVE` substeps without moving it falls asleep (velocity and sub-cell offset cleared).

Gravity turning more than 1.5°, or the back glass starting or stopping to hold the sand, wakes every grain with a free neighbour so the surface looks at its slopes again. On a flat phone (`MU_GLASS·|g.z|` above the in-plane gravity) nothing moves at all, unless it is shaken sideways harder than the glass holds; the bed then slides as a block (it never turns loose, see "Shaking").

**Fingers** are 24 px discs swept from last frame's position to this one across the substeps; see "Fingers" below.

**Resize**: if the grid size changes, the sand is stacked afresh against the wall gravity points at. Each line across that wall keeps about its grains, in their old order, so the heap's profile and the colour layers survive.

## Shaking: the bed has mass

The owner's complaint (2026-11): "it doesn't have any mass … when you shake the phone, it doesn't have that inertia effect". Measured before the change, a 20 m/s² 5 Hz sideways shake moved 1.3% of the grains on average, swung the centre of mass by 0.3% of the box width and piled 8 px against a wall; a 25 m/s² 0.2 s flick moved the mass 0.8% of the width and everything was asleep 0.23 s after it began. Two causes. The pile rules see only the direction of g: a supported grain that is not already flying stays put or slides one cell, so the sideways part of a shake (which is what the hand gives) reached only the top grain or two. And a full-width bed has nowhere to go sideways: real sand under a sideways shake stronger than its friction is driven against the wall and heaps up it, which needs the grains against the wall to be pushed *up*, and nothing pushed.

So while the box is shaken sideways the bed is **loose**:

- **When**: `g − gSlow` across `gSlow` above `A_LOOSE` (4 m/s²) and `|g|` away from its own 0.35 s average by more than `A_MAG` (2 m/s²), each peak-held over `LOOSE_HOLD` (0.15 s) so the zero crossings of a shake stay loose. A tilt, however quick, turns g without stretching it, and an up-and-down shake is along `gSlow`: neither loosens the bed, so piles still settle at the repose angle after a tilt, and a vertical shake still throws the bed up as one block as before. A sideways shake starts loosening at about 6.6 m/s² (where `|g|` grows by 2). The bed is loose only where the slow gravity in the plane beats the back glass (`|gSlow| > MU_GLASS·|gSlow.z|`, a phone tilted more than about 18° from flat): sand shoved up a wall must be able to run back down. On a flat phone the glass held the shoved sand where it was, which left a frozen cloud of grains in the upper half of the box and cracks through the bed after a hard shake (review, 2026-11-22). A flat phone shaken sideways now behaves as it did before the loose bed.
- **Exaggerated**: while loose, the part of the shake across `gSlow` is scaled by `K_SHAKE` = 2 (`env.gSlow + K·(g − gSlow)` with the part along `gSlow` left at 1). The box is a 28 cm bottle at `PX_PER_M` = 3000 while the phone's screen is about 7 cm wide, so a hand shake's centimetre of travel is half as large against the box as it would be in the hand; 2 restores that. The magnitude stays below 60 m/s².
- **Who moves**: the bed wakes whole when it turns loose. A grain with no free neighbour and no free cell within `PUSH_DEPTH` (14) cells straight up (against `gSlow`) is held by the weight above it: it sleeps and costs nothing. Grains with a free neighbour still follow the pile rules while slow, so steep faces and overhangs topple. The layer between moves ballistically even where it is supported, with the usual inelastic collisions and Coulomb friction, which is what lets it slide over the bed and slam into a wall.
- **As a body**: each loose grain takes `VISC` (0.3) of the mean velocity of the grains touching it per substep, so the layer moves together instead of every grain row sliding on the one below.
- **Pushing up the wall**: a loose grain that is blocked by a wall, a sleeping grain or a grain that was itself blocked this substep (a jammed mass, not a falling block waiting for the grains ahead to move on), and is faster than `V_PUSH` (300 px/s), may shove a line of grains, turned from its motion toward "up" (never down), one cell into the nearest free cell within `PUSH_LINE` (40) cells, and move into the first cell. A line of k grains takes the speed v / (1 + k/`PUSH_K`), and the shove happens with the chance that this speed carries it a cell in this substep, so short lines (near the surface, near the wall) move often and long ones rarely: the mass heaps up the wall instead of the whole bed rising. The shoved grains take that speed and the shover keeps it along the shove. Only grains within `PUSH_DEPTH` of the surface shove.
- **Travel is spent**: a grain's sub-cell travel is clamped to its cell after each move. A shove ends the move with travel left over, and that leftover used to pile up into an offset of up to 16 cells, which drew grains outside the box (up to 22 of them in a 20 m/s² side shake; `outside` must stay 0).
- **After**: when the shake stops the bed is no longer loose, every grain is back on the pile rules, and the heaps against the walls avalanche to the repose angle and fall asleep (measured: exact rest again within 0.5–0.75 s).

What did not work, for the next person: making the whole bed loose with straight-ahead line shoves turned it into a gas (deep vertical chasms at the walls, the bed dilated to a cloud, horizontal stripes where whole rows shifted); shoving a line regardless of its length lifted columns faster than gravity could pull them back; treating a long line ahead of a grain as "jammed" made a jumping bed shear into vertical streaks; loosening on any `|g − gSlow|` (not only sideways and stretching) flattened the heaps after a quick 60° tilt to 26° (now 34.5°) and streaked the layers in a vertical shake; `K_SHAKE` along `gSlow` too made a vertical shake blow the bed apart.

## Fingers: a stick through the sand

A finger is a solid disc (`fingerR` 24 px) standing through the sand, swept from last frame's position to this one across the substeps. Each substep the cells under the disc are stamped `WALL`, so sand rests on the finger, slides off it by the pile rules, and its grains collide with it like with a wall. Cells the disc leaves are freed and wake their neighbours, so a wall or a roof left standing falls in.

Each grain the disc moves onto goes the cheapest way out:
- a **line**: along one of the eight directions out of the disc, shoving the run of grains beyond it one cell toward the first free cell (at most `PUSH` cells). Cost: the cells crossed plus the grains shoved, times 1 to 2 the less outward the line points. Near the surface this is cheapest: sand heaps up ahead of and beside the finger;
- a **hop**: straight to the nearest free cell in a ring 3 cells wide around the disc, at `HOP` per cell. Deep in the pile this is cheapest: the sand flows round the finger into the room it just left, so the finger passes through and the sand closes behind it.

A grain the finger runs into leaves at (1 + `FINGER_BOUNCE`) times the finger's speed into it (along the outward normal), plus `FINGER_OUT`, with a random spread of `FINGER_SPREAD` of that, and takes `FINGER_DRAG` of the finger's speed along its surface. The shoved run moves with it, slower the longer it is (`FINGER_RUN`). So the sand ahead keeps ahead of the finger as a bow wave, and a fast swipe throws a spray. A hopped grain takes `FINGER_DRAG` of the finger's velocity. Line scans and shoves are bounded by `FINGER_SCAN` cells a substep, so a finger pressed deep into packed sand (no room round it) clears its disc over 10–15 frames by heaving the sand above instead of stalling a frame.

The owner's complaint (2026-11-22): "On the sand, when interacting via touch, it's not realistic", with a screenshot of a 400 px vertical cliff beside a dug channel and an overhang over a round hole at its bottom. The finger used to shove every grain under it one cell along the most outward line, leaning up, that reached a free cell within 90 cells. Deep in the pile that line went to the surface, so each stroke lifted whole columns: a raised block with vertical sides and a slot behind the finger, and the slot's walls drain only from the bottom grain of each column (the pile rules move a supported grain one cell; the column above falls from rest), about 170 px/s. Measured (headless Chromium, `__T`, high, held back g = (0, 6.9, 6.9), the settled bed's relief 40 px; wall = largest height step over 6 px). While the finger is down, its own disc is the only empty space inside the sand; before, the slot and overhangs above it were open too:

| | finger down: steepest 20 px slope / wall / surface relief | 0.5 s after lifting | 1 s after | moves in 600 still frames after |
|---|---|---|---|---|
| dig: strokes up and down from 760 px to the surface, ending in the sand | 83° / 122 px / 192 px → 35° / 8 px / 40 px | 42° / 8 px → 35° / 4 px | 35° → 35° | 0 → 0 |
| furrow: down from above the surface to 800 px at 400 px/s | 85° / 154 px / 260 px → 31° / 6 px / 38 px | 76° / 36 px → 35° / 6 px | 62° / 18 px, still moving → 35° | 691 → 0 |
| plough: across, 12 px under the surface, 400 px/s | 75° / 60 px / 104 px → 70° / 44 px / 72 px | 35° → 35° | 35° → 35° | 0 → 0 |
| flick: the same at 2000 px/s | 67° / 38 px / 78 px → 71° / 32 px / 76 px | 35° → 35° | 35° → 35° | 0 → 0 |
| tap: resting 20 frames at the surface | 67° / 54 px / 72 px → 31° / 6 px / 44 px | 35° → 35° | 35° → 35° | 0 → 0 |

Upright (g = (0, 9.81, 0)) gives the same picture: the furrow 85° / 158 px before, 31° / 6 px after, and before it was still at 54° and moving 1 s after lifting. Everything has settled at the repose angle by 0.5 s after it lifts (before: up to 1 s, and after the furrow grains were still changing cell 1–11 s after lifting). A plough at the surface heaps 42–48 px ahead of the finger against 20 px behind it (in Node; depth 10–30 px, 400 px/s). A finger dug in and pulled back up towards the surface still pushes the sand above it up and leaves a shaft under it for a moment (wall 130 px as it leaves the sand); that shaft has slumped to 39° 0.5 s after lifting.

`HOP` is not sensitive: 1 heaps 32–40 px ahead (16–18 behind), 2 and 3 heap 44–50 px (22–24 behind), and the dig and the furrow stay as flat with any of them (relief 40–52 px with the finger down). Charging lines for the height they lift sand (tried as `LIFT`) did not stop the shaft and halved the bow wave.

Cost (per frame step + render, desktop shared with other runs, so noisy): over each touch scenario plus 1 s after, high, mean 0.7–1.7 ms (before 0.9–3.0), worst frame 9–14 ms (before 8–36 ms, the deep dig). Medium with `--throttle 4`: mean 2.6–4.3 ms (before 2.4–7.6), p95 8–15 ms; the first frame of a touch is the worst, 34–80 ms against 30–97 ms before, with large run-to-run spread. Without a finger nothing changed: the grid steps bit for bit as before (tilt, shake, flat and flip in Node).

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
| `PUSH` | 160 cells | How far a finger looks along a line for room (was 90, which left a finger pressed into the lower bed with nowhere to put its grains) |
| `FINGER_SCAN` | 4000 cells | Line reads (a shove counts 4) per finger per substep; 20000 cost about 30 ms a frame (Node) while a deep press cleared |
| `HOP` | 1.5 | Cost per cell of a hop round the finger; see "Fingers" |
| `FINGER_BOUNCE`, `FINGER_OUT`, `FINGER_SPREAD` | 0.2, 60 px/s, 0.5 | Speed of a grain the finger runs into: more than the finger's, so it is not overrun, and spread so a flick sprays instead of lifting a sheet |
| `FINGER_DRAG`, `FINGER_RUN` | 0.3, 6 cells | Speed along the finger a touched grain takes; how fast a shoved run slows with its length (giving speed only to the first two grains left a roof of lifted sand over the finger's trail) |
| `K_SHAKE` | 2 | Shake across `gSlow` while loose; see "Shaking". In Node, 20 m/s² 5 Hz side shake, upright: 1 moved 3.6% of the grains and piled 17 px, 2 moves 13% and piles 31 px, 2.5 moved 25% and piled 57 px but mixed the top half of the bed |
| `A_LOOSE`, `A_MAG`, `LOOSE_HOLD` | 4, 2 m/s², 0.15 s | When the bed is loose: a sideways shake, not a tilt |
| `VISC` | 0.3 | Velocity shared with touching grains per substep while loose |
| `V_PUSH`, `PUSH_K`, `PUSH_LINE` | 300 px/s, 12, 40 cells | Shoves of a jammed loose mass; `PUSH_K` 4 piled 26 px where 12 piles 31 |
| `PUSH_DEPTH` | 14 cells | Depth of the loose layer. 20 moved 18% instead of 13% for 30% more CPU; an unlimited depth let gaps open down the whole wall |
| `SUB_DT_LOOSE` | 1/120 s | Halves the cost of a loose bed against 1/180 with about the same response |
| `SCATTER_LOOSE` | 0.02 | `SCATTER` while loose: 0.08 sprayed the layer into a cloud |

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

Shaking, before → after the loose bed (headless Chromium, `__T`, 393×852, high, 15.3k grains; "upright" g = (0, 9.81, 0), "held back" g = (0, 6.9, 6.9), shakes from `__T.shake`; moving = faster than 30 px/s; heap = mean packed height of the 12 columns at a wall above the mean, peak):

| | moving, mean / peak | centre-of-mass swing (box width) | heap at wall | surface tilt, peak | airborne, peak |
|---|---|---|---|---|---|
| side 20 m/s² 5 Hz 1 s, upright | 1.3% / 3.5% → 13% / 31% | 0.3% → 3.6% | 8 → 28 px | 4° → 10° | 0.2% → 2.2% |
| side 20 m/s² 5 Hz 1 s, held back | 1.9% / 4.6% → 30% / 74% | 0.4% → 10% | 10 → 56 px | 4° → 25° | 0.3% → 3.8% |
| hand 15 m/s² 6 Hz 1 s, held back | 1.5% / 3.8% → 11% / 29% | 0.2% → 2.5% | 5 → 19 px | 4° → 5° | 0.3% → 1.5% |

Flick, 25 m/s² for 0.2 s (one half sine): the mass moves 0.8% → 8.3% of the width (upright; 1.2% → 9.5% held back), a slab heaps 109 px (137 px held back) up the far wall, the surface tilts 34° (40°) and avalanches back to a 26° (32°) slope across the box; under 1% of the grains are moving 0.33 s after the flick began and all are asleep after 0.57 s (1.33 s held back; before: 0.23 s, because almost nothing had moved). Vertical 20 m/s² 5 Hz: unchanged, the bed jumps as one block, centre of mass 55 px up at the peak. Rest after shaking: 0 grains change cell over 600 frames, upright and held back. `reposeAngle` after a 60° tilt 35.0° → 34.5°; poured heap 32.5° (unchanged).

Cost of a loose bed: per frame step + render on the shared desktop (load 7–16), high: side shake held back 2.1 → 3.8 ms mean (p95 3.5 → 7.2), hand shake 2.0 → 2.0, flick 0.7 → 1.7 (p95 4.3). Medium with `--throttle 4`: side shake held back 7.0 → 14.4 ms mean (p95 26), hand shake 5.7 → 7.9 (p95 15), flick 1.9 → 6.8 (p95 16). `tools/smoke.py sand` shake phases 1.0 → 4.2 and 2.3 → 3.7 ms a frame (wall), with `--throttle 4` 3.6 → 13.9 and 10.9 → 13.7.

## Limits

- It is a lattice. Resting sand sits on cells (hidden by per-grain offsets). A slope's angle can only take the grid's steps, so the repose angle is reached by thresholds tuned to them, not by friction alone.
- An avalanche flows as a thin surface layer plus `SLAB`; a 50° tilt of a level surface takes about 1.5–2 s to settle, slower than real sand in a box this size.
- A hard shake dilates the pile into rows and columns with one-cell gaps; the shadow fill hides most of them, but some seams show while it is shaking.
- A finger moving deep through the pile hops grains from its front to its back, so it leaves a 48 px wide band of mixed colour along its path. A finger pressed into packed sand with no room round it heaves the sand above it in straight columns, which slump afterwards.
- A steep wall the finger leaves (pulling it up out of the sand) drains from the bottom of each column, at about 170 px/s; a real wall would slump faster.
- Finger feel on a real phone is untested: the measurements use synthetic straight strokes at constant speed.
- Frames where all grains fly (flip, hard shake) cost 3–4× a typical frame; on a mid-range phone at medium they may drop to ~30–40 fps for a moment. A loose bed costs 2–3× what the old shake did: a hard sideways shake at medium on a mid-range phone (estimated with `--throttle 4`) runs at 14 ms a frame on average.
- The loose bed is a mechanism tuned by eye, not a granular stress model. Only the top `PUSH_DEPTH` cells move; the deep bed never shears. The grain shoved up a wall leaves its cell empty, and that hole travels back to the far wall, so a hard shake opens a narrow V-shaped gap down the wall the sand is leaving (up to ~100 px deep for a moment) before the sand slams back into it.
- A hard sideways shake mixes the top two or three colour bands into speckle; a hand shake mixes mainly the top one. The bands below `PUSH_DEPTH` survive any shake.
- A vertical shake makes the bed jump as a rigid block but does not loosen or flow; loosening it streaked the layers.
- Held at a low tilt (24–30° from flat, in-plane gravity 4–5 m/s²), the shake is large against the gravity and the glass slows the heap's return: a 15 m/s² 6 Hz hand shake mixes bands 2–6 (held back at 45°, only the top band), and a 20 m/s² shake churns the whole bed into a dome that settles with its layers mixed.
- A typical hand shake (15 m/s² at 6 Hz, about a centimetre) moves the body of the bed only a little: the centre of mass swings 2.4–3.1% of the width and the surface tilts about 7°. Mostly the top layer fizzes and heaps 17–28 px at the walls. A flick or a hard shake throws the mass. In Node, `VISC` 0.5, `PUSH_DEPTH` 20, `PUSH_K` 20 or `K_SHAKE` 2.5 raise the hand-shake swing to 3.0–4.8%, but each mixes the deeper layers 2–6 times more; they were left as they are until they can be tried in the hand.
- Feel on a real phone is untested: the headless numbers use synthetic sine shakes, and the thresholds (`A_LOOSE`, `A_MAG`) against real sensor noise and walking are unverified.
