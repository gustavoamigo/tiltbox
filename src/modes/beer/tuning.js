// Beer: the FLIP liquid with water's physics and a lager's look, plus the head (foam, lacing,
// carbonation) in head.js. See docs/modes/beer.md for why each number has its value.

// The liquid's share of the budget: a little under water's, since the head runs beside it.
const BEER_Q = {
  low: { count: 2400, cells: 1600, pressureIters: 24, push: 2, maxSub: 2, texScale: 0.33, caustics: false },
  medium: { count: 3800, cells: 2500, pressureIters: 28, push: 2, maxSub: 2, texScale: 0.42, caustics: true },
  high: { count: 5600, cells: 3600, pressureIters: 32, push: 2, maxSub: 3, texScale: 0.5, caustics: true },
};

// The liquid: water's physics (the FLIP engine's water numbers), a level pool to start.
export const BEER = {
  name: 'beer',
  quality: BEER_Q,
  fill: 0.55,
  boxMetres: 0.4,
  flipRatio: 0.85,
  visc: 0,
  viscIters: 0,
  viscRounds: 1,
  wallSlip: 1,
  drift: 12,
  damp: 0.45,
  flatDamp: 6,
  cfl: 3.5,
  foam: { lo: 1e9, hi: 2e9, gain: 0, tau: 1, land: 0 }, // the engine's whitewater is off: the head is foam
  splat: 2.7,
  thresh: 0.4,
  loneWeight: 4,
  fingerR: 0.075,
  fingerFoam: 0,
  speedRef: 1.5,
  bed: 'water',
  drops: true,
  // A full pint at rest: the bottom 55% of the box (x breaks ties, so rows fill evenly).
  seed: (x, y) => 1 - y + 1e-4 * x,
  look: {
    pattern: 2, // plain glass
    tileSize: 22,
    bgTop: [0.05, 0.038, 0.03],
    bgBot: [0.022, 0.016, 0.012],
    tileA: [0, 0, 0],
    tileB: [0, 0, 0],
    grout: [0, 0, 0],
    wetGain: [2.6, 1.9, 0.8],
    absorb: [0.12, 0.38, 1.5], // per 100 px: blue goes first, red last: gold turning amber with depth
    shallow: [1.0, 0.78, 0.22],
    deep: [0.68, 0.38, 0.04],
    deepPx: 230,
    rimCol: [1.0, 0.92, 0.62],
    rim: 0.45,
    rimW: 3.0,
    mirror: 0.3,
    specCol: [1.0, 0.97, 0.85],
    spec: 1.0,
    shine: 40,
    lens: 6,
    bulge: 0.2,
    foamCol: [0.98, 0.92, 0.75],
    foam: 0,
    spray: 0.35,
    caust: 0.55,
    caustCol: [1.0, 0.82, 0.38],
    rays: 0.3,
    bubbleHole: 0.5,
    caustScale: 0.035,
    glow: 0.18,
    glowCol: [1.0, 0.75, 0.25],
    bubbles: null, // carbonation is drawn by the head renderer
  },
};

// The head: foam, lacing and carbonation (head.js, render.js).
export const HEAD = {
  quality: {
    // foamR: foam particle radius in liquid particle radii; with these the head has about the
    // same number of foam particles (and cost) at every quality
    low: { maxFoam: 2000, maxBubbles: 500, foamIters: 3, foamR: 1.12, texScale: 0.33 },
    medium: { maxFoam: 2600, maxBubbles: 800, foamIters: 3, foamR: 1.15, texScale: 0.42 },
    high: { maxFoam: 2800, maxBubbles: 1200, foamIters: 3, foamR: 1.32, texScale: 0.5 },
  },
  head: 0.125, // head at rest, of the liquid's height
  // Foam particles
  rise: 0.25, // m/s: foam pushed under the surface floats back up this fast
  grab: 25, // 1/s: how fast submerged foam takes the liquid's velocity
  airDrag: 1.5, // 1/s
  maxPush: 0.1, // m/s: most the push-apart may add to a velocity beyond stopping it
  cohesion: 0.4, // of the gap between near foam particles closed a frame
  stackBias: 0.4, // push-apart share the upper particle of a stacked pair takes over half (0.4: 90%)
  xsph: 0.12, // velocity shared between touching foam particles per frame: foam moves as a body
  wallGrip: 5, // 1/s: foam touching a side wall loses its speed along it (it clings)
  fineLife: 150, // s, mean: the rest head collapses slowly
  shakeLife: [5, 18], // s: foam a shake makes lives this long (uniform), then collapses
  shakeFine: 0.1, // of a shake's foam, the share that is fine and stays
  // Making foam
  shakeTau: 0.06, // s: the high-pass that tells a shake from a tilt
  shakeLo: 4, // m/s² of high-passed g where foaming starts
  shakeHi: 14, // and where it saturates
  stirLo: 0.15, // m/s mean liquid speed where a finger's stir starts foaming (a 1 m/s stir gives about 0.26)
  stirHi: 0.5,
  foamRate: 250, // px a second the head grows by (across the box), at full agitation and carbonation
  co2Use: 1 / 1000, // carbonation used per px of head a shake makes
  co2Back: 1 / 90, // 1/s: and how fast it comes back (a toy never goes flat for good)
  // Carbonation
  sites: [ // nucleation points on the glass (box fractions), bubbles/s each
    [0.16, 0.95, 14], [0.43, 0.985, 10], [0.71, 0.93, 16], [0.92, 0.8, 8], [0.07, 0.7, 8],
    [0.58, 0.2, 10], [0.3, 0.05, 8],
  ],
  bulkRate: 18, // bubbles/s from anywhere in the bulk
  shakeBubbles: 900, // more, per second, at full agitation
  riseV0: 0.02, // m/s: a fresh bubble's rise
  riseAcc: 0.07, // m/s²: it grows as it rises, and speeds up
  riseMax: 0.16, // m/s
  bubbleR: [0.8, 1.4], // sim px at birth
  bubbleGrow: 0.45, // radius growth per second of rise
  bubbleLife: 7, // s: a bubble that never reaches the surface fades
  bubbleFlatLife: 0.5, // s: and on a flat phone (scaled between the two by in-plane g)
  bubbleFoam: 1.2, // px² of foam each bubble adds to the head where it arrives
  // Lacing: foam leaves a film on the back glass that slides down and fades
  laceDeposit: 0.6, // per second where foam stands
  laceMax: 0.8,
  laceLife: 25, // s
  laceWash: 0.4, // s, under the liquid
  laceSlide: 3.5, // sim px/s at 1 g
  look: {
    cream: [1.0, 0.975, 0.9],
    warm: [0.93, 0.78, 0.46], // wet foam where it meets the beer
    shade: [0.78, 0.72, 0.6],
    lace: [0.95, 0.93, 0.85],
    bubbleRim: [1.0, 0.96, 0.82],
    bubbleFill: [1.0, 0.85, 0.45],
    splat: 2.4, // foam splat radius in foam particle diameters
    loneWeight: 3, // splat weight of a fleck of foam on its own
    thresh: 0.42,
  },
};
