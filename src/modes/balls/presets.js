// Materials and looks for the two ball modes. Physics constants are in sim px and seconds
// unless a name says otherwise; docs/modes/balls.md explains how they were chosen.

import { BallWorld } from './engine.js';

const BASE = {
  // world scale: sim px per metre of the simulated box. A phone screen is ~5500 CSS px/m; a
  // smaller number reads as a bigger box (slower falls), which keeps fast motion watchable.
  pxPerM: 3200,
  massExp: 3, // mass ∝ r^massExp (3: solid spheres)
  inertiaK: 0.4, // I = k m r² (0.4: solid sphere)
  substepHz: 960, // solver substeps per second (16 a frame at 60 fps)
  maxSubsteps: 24, // per step: a long frame (dt 1/30) runs at 720 Hz, so a slow device that drops
  // frames does not do twice the work per frame and drop more (worst overlap 12% vs 10%)
  maxInterval: 4, // most substeps between collision passes (when everything is slow)
  travel: 0.25, // fastest ball moves at most this fraction of the smallest radius between passes
  velIters: 2, // velocity Gauss-Seidel sweeps per substep
  projectIters: 3, // position projection sweeps per substep
  extraIterSpeed: 0.25, // m/s: a pass gets one more of each per this much closing speed...
  maxExtraIters: 8, // ...up to this many more (a pile landing needs them; a resting one not)
  shockTau: 0.03, // s: support order follows g·shockTau + the mean velocity
  projectBeta: 0.7, // position projection: share of an overlap removed per sweep...
  projectSlop: 0.05, // px: ...beyond this much, which is left to keep resting contacts warm
  projectMax: 0.2, // most correction per contact per sweep, fraction of the smallest radius
  projectReach: 0.2, // a ball projected further than this (fraction of rMin) forces a new pass
  cleanupAbove: 0.02, // frame end: overlap (fraction of a radius) that gets position-only passes...
  cleanupRounds: 2, // ...at most this many
  cleanupDeep: 0.06, // deeper than this: up to cleanupDeepRounds (rare: a pile slammed into a wall
  cleanupDeepRounds: 6, // at the speed cap by an exaggerated shake reached 66% with 2 rounds)
  maxPush: 400, // px/s: fastest the finger pushes a ball out of itself
  speculative: 1.0, // px: contacts are made this far ahead, plus what the motion can close
  maxSpeed: 9000, // px/s: speed cap, and also at most subTravel·rMin per substep (engine resize):
  subTravel: 0.45, // under half the smallest radius per substep. 2.4 m/s rubber, 1.7 m/s marbles
  shakeGain: 3, // the shake (g − gSlow) is multiplied by this; the tilt stays true (boxGravity)...
  shakeDeadband: 0.5, // m/s²: ...beyond this much of it (hand tremor is about ±0.15)
  maxG: 45, // m/s²: most in-plane gravity the box gets after that
  linDamp: 0.03, // 1/s air drag
  angDamp: 0.05,
  sleepSpeed: 3, // px/s: below this for sleepTime seconds, everywhere, and the box sleeps
  sleepTime: 0.5,
  wakeG: 0.35, // m/s²: gravity change that wakes a sleeping box (hand tremor stays below)
  fingerRadius: 28,
  fingerMaxSpeed: 3000, // px/s: a flick pushes hard but does not fire balls into the pile
  fingerFriction: 0.3,
  fingerRestitution: 0, // the finger pushes, it does not bat
  fingerHz: 60, // the finger is a soft contact (stiffness, damping ratio)...
  fingerZeta: 10,
  fingerAccel: 80, // m/s²: ...and a limited one: a jammed pile makes it slide over, not crush
};

export const MARBLES = {
  ...BASE,
  id: 'marbles',
  // the back panel: pale cool linen, so clear glass shows what is behind it, bent
  render: { glass: true, bgLit: [0.9, 0.92, 0.94], bgFar: [0.62, 0.66, 0.72], grain: 0.02, weave: 0.09, shadow: 1 },
  sound: 'glass',
  pitchExp: 0.8, // pitch ∝ (base radius / radius)^pitchExp: small marbles ring higher
  wallPitch: 0.85,
  hapticAbove: 0.8, // impacts louder than this buzz (where the platform can)
  counts: { low: 70, medium: 105, high: 150 },
  fill: 0.36, // fraction of the box area covered by marbles
  sizes: [[0.8, 0.34], [1.0, 0.52], [1.32, 0.14]], // [relative radius, share of the count]
  restitution: 0.6,
  wallRestitution: 0.5,
  restThreshold: 0.12, // m/s: slower approaches do not bounce (piles come to rest)
  friction: 0.2, // glass on glass: low, so piles pack and flow
  wallFriction: 0.25,
  rollRes: 0.008, // rolling resistance arm, fraction of the radius, at in-plane contacts
  glassFriction: 0.3, // against the back glass, pressed by |g.z|
  glassRollRes: 0.012, // flat phone: rolling resistance arm (fraction of r). A marble starts to roll
  // above ~0.7° of tilt, and on a level phone slows by ~0.08 m/s²: from 0.3 m/s it coasts ~3.5 s
  maxG: 30, // m/s²: a 150-marble pile slammed into the floor at the speed cap by 45 m/s² wedged
  // its bottom row (single frames to 30% overlap); at 30 the worst of 18 000 shaken frames is 11%
  glassSpin: 0.02, // drilling resistance arm (× r): a contact patch is tiny. At 0.08, a marble rolling
  // along the floor of a phone held tilted back (|g.z| ≈ 7) lost a third of its speed to it
  glassBase: 0.2, // m/s²: a little glass contact even upright (the box is not perfectly thin)
  soundMin: 0.06, // m/s approach speed: quieter than this is not heard
  soundFull: 1.1,
  makeLooks: marbleLooks,
};

export const BALLS = {
  ...BASE,
  id: 'balls',
  // the back panel: warm cream card, so bright rubber pops and shadows are clear
  render: { glass: false, bgLit: [0.96, 0.92, 0.85], bgFar: [0.7, 0.64, 0.57], grain: 0.02, weave: 0, shadow: 1 },
  sound: 'rubber',
  pitchExp: 0.6,
  wallPitch: 0.9,
  hapticAbove: 0.7,
  pxPerM: 3000,
  massExp: 2.5, // between solid and hollow: big balls are not 40x heavier than small ones
  inertiaK: 0.5,
  counts: { low: 26, medium: 38, high: 52 },
  fill: 0.34,
  sizes: [[0.72, 0.35], [1.0, 0.4], [1.35, 0.17], [2.1, 0.08]],
  restitution: 0.9, // superball
  wallRestitution: 0.88,
  restThreshold: 0.1,
  friction: 0.75,
  wallFriction: 0.8,
  rollRes: 0.01,
  glassFriction: 0.2, // low for rubber: in the tilted-back hold, a ball bouncing off the floor
  // while rolling on the glass loses what friction takes to make it roll the other way (0.8: a
  // drop came back to 32% of its height instead of 68% upright)
  glassRollRes: 0.025, // rubber on glass: rolls above ~1.5° (0.04 before; at 0.015 hand tremor kept
  // a pile on a flat phone creeping instead of falling asleep)
  glassSpin: 0.02,
  glassBase: 0.2,
  soundMin: 0.08,
  soundFull: 1.6,
  makeLooks: rubberLooks,
};

// The gravity the balls feel: the tilt (env.gSlow) as it is, the shake (g − gSlow) times
// mat.shakeGain, because at true scale a hand shake moves the phone a centimetre and barely
// throws anything. The first shakeDeadband m/s² of shake is passed as it is, so hand tremor is
// not exaggerated (an awake pile then still falls asleep in a held phone). Only the in-plane
// part is exaggerated; z (the press on the glass) stays true.
export function boxGravity(mat, g, gSlow, out) {
  const dx = g.x - gSlow.x, dy = g.y - gSlow.y;
  const d = Math.hypot(dx, dy);
  const k = d > mat.shakeDeadband ? 1 + (mat.shakeGain - 1) * (1 - mat.shakeDeadband / d) : 1;
  let x = gSlow.x + k * dx, y = gSlow.y + k * dy;
  const m = Math.hypot(x, y);
  if (m > mat.maxG) { x *= mat.maxG / m; y *= mat.maxG / m; }
  out.x = x; out.y = y; out.z = g.z;
  return out;
}

// Per-ball looks: 16 bytes each, read by the shaders as four normalized vec4s:
// c0, c1, c2 colours (sRGB) and p = (type, seed, a, b).
const S = 16;

const VANE = [[235, 40, 40], [255, 135, 20], [255, 205, 30], [40, 185, 70], [40, 105, 240], [30, 195, 225], [245, 245, 240], [225, 50, 160], [135, 60, 225]];
const CLEAR = [[236, 246, 240], [236, 246, 240], [236, 246, 240], [200, 238, 232], [210, 225, 250], [250, 236, 200]];
const TINT = [[40, 85, 225], [30, 170, 95], [235, 145, 30], [205, 30, 55], [20, 160, 175], [125, 60, 205], [120, 120, 132]];
const OPAQUE = [[238, 234, 226], [140, 28, 26], [90, 160, 232], [60, 160, 112], [242, 200, 92], [28, 28, 34], [240, 112, 92]];
const RUBBER = [[242, 46, 52], [255, 128, 16], [255, 212, 0], [150, 220, 30], [18, 182, 96], [0, 186, 230], [40, 92, 242], [142, 72, 232], [255, 78, 160]];
const WHITE = [246, 246, 244];

function pick(rand, list) { return list[Math.floor(rand() * list.length) % list.length]; }
function pickOther(rand, list, not) {
  for (let i = 0; i < 8; i++) { const c = pick(rand, list); if (c !== not) return c; }
  return list[(list.indexOf(not) + 1) % list.length];
}
function put(out, o, c0, a0, c1, a1, c2, a2, p) {
  out.set([c0[0], c0[1], c0[2], a0, c1[0], c1[1], c1[2], a1, c2[0], c2[1], c2[2], a2, p[0], p[1], p[2], p[3]], o);
}
const seedByte = (rand) => Math.floor(rand() * 256);

// Marble types: 0 cat's eye, 1 clear swirl, 2 tinted clear, 3 opaque swirled.
// c0.a: glass tint density (how much colour a full path through the ball takes on).
function marbleLooks(rel, rand) {
  const out = new Uint8Array(rel.length * S);
  for (let i = 0; i < rel.length; i++) {
    const big = rel[i] > 1.2;
    const u = rand();
    // mostly glass you can see into (cat's eyes, clear swirls, tinted clearies), a few opaque
    const type = big ? (u < 0.7 ? 1 : 3) : u < 0.42 ? 0 : u < 0.7 ? 1 : u < 0.9 ? 2 : 3;
    const o = i * S;
    if (type === 0) {
      const a = pick(rand, VANE), b = rand() < 0.45 ? a : pickOther(rand, VANE, a);
      const vanes = rand() < 0.6 ? 3 : 4;
      put(out, o, pick(rand, CLEAR), 40, a, 255, b, 255, [0, seedByte(rand), vanes, 0]);
    } else if (type === 1) {
      const a = pick(rand, VANE), b = rand() < 0.35 ? WHITE : pickOther(rand, VANE, a);
      const ribbons = 2 + Math.floor(rand() * 3);
      put(out, o, pick(rand, CLEAR), 40, a, 255, b, 255, [1, seedByte(rand), ribbons, 60 + Math.floor(rand() * 140)]);
    } else if (type === 2) {
      put(out, o, pick(rand, TINT), 45 + Math.floor(rand() * 60), WHITE, 0, WHITE, 0, [2, seedByte(rand), 0, 0]);
    } else {
      const base = pick(rand, OPAQUE);
      const a = pickOther(rand, OPAQUE, base), b = rand() < 0.5 ? WHITE : pickOther(rand, VANE, a);
      put(out, o, base, 255, a, 255, b, 255, [3, seedByte(rand), 0, 0]);
    }
  }
  return out;
}

// Rubber types: 0 band, 1 two halves, 2 marbled superball, 3 dots, 4 beach-ball gores.
function rubberLooks(rel, rand) {
  const out = new Uint8Array(rel.length * S);
  for (let i = 0; i < rel.length; i++) {
    const o = i * S;
    const big = rel[i] > 1.8;
    const u = rand();
    const type = big ? (u < 0.5 ? 4 : u < 0.8 ? 0 : 1) : u < 0.3 ? 0 : u < 0.5 ? 1 : u < 0.72 ? 2 : u < 0.9 ? 3 : 4;
    const a = pick(rand, RUBBER), b = pickOther(rand, RUBBER, a), c = pickOther(rand, RUBBER, b);
    const band = rand() < 0.5 ? WHITE : b;
    if (type === 0) put(out, o, a, 255, band, 255, c, 255, [0, seedByte(rand), 0, 0]);
    else if (type === 3) put(out, o, a, 255, rand() < 0.6 ? WHITE : b, 255, c, 255, [3, seedByte(rand), 0, 0]);
    else put(out, o, a, 255, b, 255, c, 255, [type, seedByte(rand), 0, 0]);
  }
  return out;
}

// Relative radii for n balls: the size mix, shuffled.
export function makeSizes(preset, n, rand) {
  const out = [];
  let acc = 0;
  for (const [f, share] of preset.sizes) {
    acc += share;
    while (out.length < Math.round(acc * n) && out.length < n) out.push(f * (0.97 + 0.06 * rand()));
  }
  while (out.length < n) out.push(1);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// How many balls: by quality, a little more on a bigger box, within the mode's range.
export function countFor(preset, quality, simW, simH) {
  const base = preset.counts[quality] || preset.counts.medium;
  const s = Math.min(1.15, Math.max(0.75, Math.sqrt((simW * simH) / (393 * 852))));
  return Math.round(base * s);
}

// The world for a preset at a quality, in a W x H box, poured in. Shared by the mode and the
// headless tests so both see the same thing.
export function buildWorld(preset, quality, W, H, seed = 1) {
  const rand = mulberry32(seed);
  const n = countFor(preset, quality, W, H);
  const world = new BallWorld(makeSizes(preset, n, rand), preset);
  world.resize(W, H);
  world.spawn(rand);
  return { world, rand };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
