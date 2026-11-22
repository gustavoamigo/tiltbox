// Liquids for the FLIP engine: physics, the start shape, sound, and look.
// Colours are display RGB 0..1 as the composite adds them up; see docs/modes/fluid.md for why
// each number has its value.

// Per quality: particles and grid cells set the solver's cost (both linearly); texScale is the
// splat field's resolution in texels per sim px.
const WATER_Q = {
  low: { count: 2600, cells: 1700, pressureIters: 24, push: 2, maxSub: 2, texScale: 0.33, caustics: false },
  medium: { count: 4200, cells: 2700, pressureIters: 28, push: 2, maxSub: 2, texScale: 0.42, caustics: true },
  high: { count: 6400, cells: 4000, pressureIters: 32, push: 2, maxSub: 3, texScale: 0.5, caustics: true },
};

// Honey needs no splashy detail, and its viscosity solve spreads faster across fewer cells.
const HONEY_Q = {
  low: { count: 2400, cells: 900, pressureIters: 30, maxSub: 2, texScale: 0.33, caustics: false },
  medium: { count: 4000, cells: 1400, pressureIters: 34, maxSub: 2, texScale: 0.42, caustics: false },
  high: { count: 6000, cells: 2000, pressureIters: 40, maxSub: 2, texScale: 0.5, caustics: false },
};

export const WATER = {
  name: 'water',
  quality: WATER_Q,
  fill: 0.5,
  boxMetres: 0.4, // the box's long side in the world the physics runs in
  flipRatio: 0.85, // 15% PIC: calms the particle-scale noise on the surface, keeps the splash
  visc: 0,
  viscIters: 0,
  viscRounds: 1,
  wallSlip: 1,
  drift: 12, // 1/s; much faster and the density correction itself keeps the pool rippling
  damp: 0.45, // 1/s, always: a slosh in a thin box dies down in a few seconds
  flatDamp: 6, // 1/s more at |g.z| = 9.81: lying flat, the glass holds the film still
  cfl: 3.5, // cells a particle may cross in one substep before another is added
  foam: { lo: 3, hi: 10, gain: 0.25, tau: 1.2, land: 0.45 },
  splat: 2.7, // splat radius in particle diameters
  thresh: 0.4, // iso level, as a fraction of the field inside resting liquid
  loneWeight: 4, // splat weight of a lone droplet, so it shows at about its own size
  fingerR: 0.075, // of the box's short side
  fingerFoam: 0.6, // whitewater a fast finger leaves
  speedRef: 1.5, // m/s that reads as "fast" (spray, sound)
  bed: 'water',
  drops: true,
  // A dam: a block against the left wall, released at once.
  seed: (x, y) => Math.max(x / 0.7, (1 - y) / 0.72),
  look: {
    pattern: 2, // plain glass: the owner asked for no dots behind the water
    tileSize: 22,
    bgTop: [0.03, 0.04, 0.062],
    bgBot: [0.012, 0.018, 0.032],
    tileA: [0.07, 0.085, 0.11],
    tileB: [0.1, 0.12, 0.15],
    grout: [0.0, 0.0, 0.0],
    wetGain: [1.0, 2.2, 3.0],
    absorb: [1.6, 0.45, 0.22],
    shallow: [0.05, 0.36, 0.6],
    deep: [0.0, 0.05, 0.17],
    deepPx: 200,
    rimCol: [0.72, 0.94, 1.0],
    rim: 0.6,
    rimW: 2.5,
    mirror: 0.35,
    specCol: [1.0, 1.0, 1.0],
    spec: 0.8,
    shine: 40,
    lens: 5,
    bulge: 0.15,
    foamCol: [0.86, 0.94, 1.0],
    foam: 0.85,
    spray: 0.6,
    caust: 0.9,
    caustCol: [0.5, 0.85, 1.0],
    rays: 0.35,
    bubbleHole: 0.8,
    caustScale: 0.035,
    glow: 0,
    glowCol: [0, 0, 0],
    bubbles: { size: 0.9, every: 0, ring: [0.85, 0.95, 1.0], fill: [0.45, 0.72, 0.9] },
  },
};

export const HONEY = {
  name: 'honey',
  quality: HONEY_Q,
  fill: 0.4,
  boxMetres: 0.35,
  flipRatio: 0.0, // pure PIC: no splashy detail survives
  drift: 12,
  visc: 1500, // nu / h² on the high grid, 1/s: implicit viscosity a = visc * dt per substep
  viscIters: 10,
  viscRounds: 3,
  wallSlip: 0.6, // walls grip honey sliding along them; no-slip (0) and a coat never drains
  seedWave: 0.003, // m/s per 60 Hz frame: the unevenness a hanging layer drips from
  damp: 0.5,
  flatDamp: 12,
  cfl: 2.5,
  foam: { lo: 1e9, hi: 2e9, gain: 0, tau: 1, land: 0 },
  splat: 2.8,
  thresh: 0.4,
  loneWeight: 4,
  fingerR: 0.075,
  fingerFoam: 0,
  speedRef: 0.5,
  bed: 'honey',
  drops: false,
  // A round dollop high in the box, dropped.
  seed: (x, y) => ((x - 0.5) / 0.4) ** 2 + ((y - 0.36) / 0.32) ** 2,
  look: {
    pattern: 1,
    tileSize: 20,
    bgTop: [0.05, 0.034, 0.02],
    bgBot: [0.028, 0.018, 0.01],
    tileA: [0.012, 0.008, 0.004],
    tileB: [0.02, 0.013, 0.006],
    grout: [0.05, 0.034, 0.014],
    wetGain: [2.4, 1.5, 0.6],
    absorb: [0.25, 0.9, 2.6],
    shallow: [0.75, 0.42, 0.06],
    deep: [0.28, 0.08, 0.006],
    deepPx: 120,
    rimCol: [1.0, 0.85, 0.45],
    rim: 0.3,
    rimW: 5.0,
    mirror: 0.15,
    specCol: [1.0, 0.96, 0.86],
    spec: 1.8,
    shine: 20,
    lens: 10,
    bulge: 0.8,
    foamCol: [1.0, 0.85, 0.5],
    foam: 0,
    spray: 0,
    caust: 0,
    caustCol: [0, 0, 0],
    rays: 0,
    bubbleHole: 0.6,
    caustScale: 0.03,
    glow: 0.5,
    glowCol: [1.0, 0.6, 0.1],
    bubbles: { size: 1.3, every: 61, ring: [1.0, 0.9, 0.65], fill: [0.95, 0.65, 0.2] },
  },
};
