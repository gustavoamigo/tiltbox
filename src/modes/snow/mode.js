// Snow globe: a night scene at the bottom of the box, snow and glitter resting on it, a liquid that
// lags the glass. Shake it and the snow lifts into a swirl, then drifts down over 10-20 s; tilt it
// and the snow collects on whichever side is down. See docs/modes/snow.md.
//
// The pieces: fluid.js (the liquid: stable fluids on a coarse grid), flakes.js (flakes carried by
// it, sinking along gravity, resting on a fine occupancy grid), scene.js (the picture and the solid
// mask, from one description), render.js (WebGL2 drawing).

import { createGL } from '../../gl.js';
import { Fluid } from './fluid.js';
import { Flakes } from './flakes.js';
import { sceneLayout, buildMask, paintScene } from './scene.js';
import { createRenderer } from './render.js';
import { Turbulence } from './turb.js';

const G = 9.81;
const QUALITY = {
  low: { flakes: 1100, cells: 800, iters: 16 },
  medium: { flakes: 1700, cells: 1400, iters: 20 },
  high: { flakes: 2400, cells: 2200, iters: 24 },
};
const GLITTER = 0.09; // share of flakes that are glitter

// The liquid lags the glass. Box acceleration (the high-passed part of env.g, m/s²) pushes the
// liquid relative to the box by LAG px/s per m/s of box velocity: far less than the true scale of a
// phone (about 6000 CSS px per metre) because a full, closed globe mostly moves as one with its
// liquid; what is left is the shear near the walls and the scene, which the grid rolls into swirls.
const G_LP_TAU = 0.25; // s: what changes slower than this is tilt, faster is shake
const LAG = 350; // px per m
// Turning the globe in its plane: the liquid keeps still in the world, so it turns backwards in
// the box. ROT_GAIN < 1 stands in for the spin-up the 2D grid cannot see (the front and back glass).
const ROT_GAIN = 0.6;
const ROT_MAX = 6; // rad/s
// A 2D grid has no 3D turbulence: a shake also seeds a few random eddies, at a rate that grows with
// how hard it is shaken, and raises the sub-grid turbulence (turb.js), which mixes the snow up
// through the globe and dies away over a second or two.
const SHAKE_MIN = 7; // m/s² of env.shake before eddies and turbulence start
const TURB_GAIN = 18; // px/s of rms turbulence per m/s² of shake above SHAKE_MIN
const TURB_MAX = 480; // px/s
const TURB_RISE = 0.12; // s
const TURB_FALL = 1.5; // s
const TURB_IDLE = 5; // px/s: the faint convection of a globe at rest, so nothing hangs dead still
const EDDY_RATE = 1.4; // eddies per second per m/s² above SHAKE_MIN
const EDDY_V = 420; // px/s, peak swirl of an eddy at a full shake
const FLUID = { eps: 0.55, decay: 2.4, vmax: 1400 };
const FINGER_R = 34; // px: how wide a finger stirs
const FINGER_VMAX = 2500; // px/s
const CHIME_PITCH = [1, 1.125, 1.25, 1.5, 1.6875, 2]; // a major pentatonic: any two sound sweet

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function createSnowMode(ctx) {
  const gl = createGL(ctx.canvas);
  if (!gl) throw new Error('This browser has no WebGL2');
  const q = QUALITY[ctx.quality] || QUALITY.high;
  const seed = Number(ctx.params && ctx.params.get('seed')) || 0x5eed;
  const rng = mulberry32(seed);
  const flakes = new Flakes(q.flakes, GLITTER, rng);
  const turb = new Turbulence(rng);
  let turbLevel = TURB_IDLE;
  let renderer = createRenderer(gl, q.flakes);
  let lost = false;
  ctx.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  ctx.canvas.addEventListener('webglcontextrestored', () => {
    renderer = createRenderer(gl, q.flakes);
    if (sceneCanvas) renderer.setScene(sceneCanvas, L);
    lost = false;
  });

  const bed = ctx.audio.bed('swirl');
  let W = 0, H = 0, dpr = 0;
  let L = null;
  let fluid = null;
  let sceneCanvas = null;
  let filled = false;
  let time = 0;
  const glp = { x: 0, y: G, z: 0 }; // low-passed g: the tilt
  let phi = 0, havePhi = false, omega = 0;
  let eddyDebt = 0;
  let chimeTokens = 2;
  let lambda = 0;

  function resize(view) {
    const sizeChanged = view.simW !== W || view.simH !== H;
    if (!sizeChanged && view.dpr === dpr) return;
    dpr = view.dpr;
    if (sizeChanged) {
      const oldW = W, oldH = H;
      W = view.simW;
      H = view.simH;
      L = sceneLayout(W, H);
      const mask = buildMask(L);
      const nf = new Fluid(W, H, q.cells);
      nf.setSolid(mask.coverage);
      if (fluid) fluid.copyInto(nf);
      fluid = nf;
      flakes.setBox(W, H, mask.at);
      turb.setBox(W, H);
      if (!filled) { flakes.fill(); filled = true; } else flakes.refit(oldW, oldH);
    }
    sceneCanvas = paintScene(L, dpr, sceneCanvas);
    renderer.setScene(sceneCanvas, L);
  }

  function step(dt, env) {
    time += dt;
    const g = env.g;
    const kl = 1 - Math.exp(-dt / G_LP_TAU);
    glp.x += (g.x - glp.x) * kl;
    glp.y += (g.y - glp.y) * kl;
    glp.z += (g.z - glp.z) * kl;

    // Shake: the box accelerates, the liquid lags.
    fluid.addLag((g.x - glp.x) * LAG, (g.y - glp.y) * LAG, dt);

    // Turning: follow the direction of the (smoothed) in-plane gravity; the glass turns the
    // opposite way to it. Below a few m/s² in plane the direction means nothing (phone flat).
    let w = 0;
    const gpl = Math.hypot(glp.x, glp.y);
    if (gpl > 4) {
      const a = Math.atan2(glp.y, glp.x);
      if (havePhi) {
        let d = a - phi;
        d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        w = Math.max(-ROT_MAX, Math.min(ROT_MAX, -d / dt));
      }
      phi = a;
      havePhi = true;
    } else havePhi = false;
    fluid.addRotation((w - omega) * ROT_GAIN);
    omega = w;

    // Eddies from a hard shake, either sense, mostly just above the snow (where they lift it).
    const over = env.shake - SHAKE_MIN;
    if (over > 0) {
      eddyDebt += over * EDDY_RATE * dt;
      const s = Math.min(1, env.shake / 30);
      const gl = Math.hypot(glp.x, glp.y);
      const upx = gl > 2 ? -glp.x / gl : 0, upy = gl > 2 ? -glp.y / gl : 0;
      while (eddyDebt >= 1) {
        eddyDebt -= 1;
        const R = (0.18 + 0.27 * rng()) * Math.min(W, H); // big eddies outlive small ones
        const k = (rng() * flakes.n) | 0;
        let x, y;
        if (flakes.cell[k] >= 0 && rng() < 0.75) {
          x = flakes.x[k] + upx * R * 0.9;
          y = flakes.y[k] + upy * R * 0.9;
        } else {
          x = rng() * W;
          y = rng() * H;
        }
        x = Math.min(W - 0.5 * R, Math.max(0.5 * R, x));
        y = Math.min(H - 0.5 * R, Math.max(0.5 * R, y));
        fluid.addVortex(x, y, R, (rng() < 0.5 ? -1 : 1) * EDDY_V * s * (0.6 + 0.4 * rng()));
      }
    } else eddyDebt = 0;

    for (const p of env.pointers) {
      let vx = p.vx, vy = p.vy;
      const sp = Math.hypot(vx, vy);
      if (sp > FINGER_VMAX) { vx *= FINGER_VMAX / sp; vy *= FINGER_VMAX / sp; }
      fluid.stir(p.x, p.y, vx, vy, FINGER_R, dt);
    }

    const want = Math.max(TURB_IDLE, Math.min(TURB_MAX, TURB_GAIN * over));
    turbLevel += (want - turbLevel) * (1 - Math.exp(-dt / (want > turbLevel ? TURB_RISE : TURB_FALL)));
    turb.update(dt, turbLevel);

    fluid.step(dt, { eps: FLUID.eps, decay: FLUID.decay, iters: q.iters, vmax: FLUID.vmax });
    flakes.step(dt, g.x, g.y, glp.x, glp.y, fluid, turb);

    // Glitter catches the light as the globe turns and tips.
    lambda = 2.5 * Math.atan2(glp.x, glp.y) + 2.2 * (glp.z / G);

    sound(dt, env);
  }

  function sound(dt, env) {
    const rms = Math.sqrt(fluid.meanSq);
    bed.set(Math.min(1, rms / 260), Math.min(1, fluid.maxSpeed / 1000));
    // A hard shake rattles the glitter against the glass: sparse, rate-limited chimes.
    chimeTokens = Math.min(3, chimeTokens + dt * 4);
    if (env.shake > 14 && chimeTokens >= 1 && rng() < dt * 9) {
      chimeTokens -= 1;
      const s = Math.min(1, (env.shake - 14) / 20);
      ctx.audio.impact('chime', 0.12 + 0.3 * s * rng(), CHIME_PITCH[(rng() * CHIME_PITCH.length) | 0] * (rng() < 0.3 ? 0.5 : 1));
    }
  }

  function render(view) {
    if (lost) return;
    const count = flakes.writeInstances(renderer.data, lambda);
    renderer.draw(view, { count, time, shiftX: -glp.x * 2.2, shiftY: (glp.y - G) * 1.5 });
  }

  function stats() {
    const { nan, outside } = flakes.countBad();
    const n = flakes.n;
    return {
      count: n,
      nan: nan || !Number.isFinite(fluid.meanSq),
      outside,
      airborne: (n - flakes.resting) / n,
      kinetic: flakes.ke, // mean ½v² of the flakes, (px/s)²
      fluidEnergy: 0.5 * fluid.meanSq, // mean ½|u|² of the liquid, (px/s)²
      fluidMax: fluid.maxSpeed,
      turbulence: turbLevel,
      grid: `${fluid.nx}x${fluid.ny}`,
    };
  }

  return {
    resize,
    step,
    render,
    stats,
    reset() {
      flakes.fill();
      fluid.u.fill(0); fluid.v.fill(0); fluid.p.fill(0); fluid.psi.fill(0);
      turbLevel = TURB_IDLE;
      eddyDebt = 0;
    },
    dispose() {
      bed.stop();
      renderer.dispose();
    },
    debugState() {
      return {
        x: Array.from(flakes.x), y: Array.from(flakes.y), cell: Array.from(flakes.cell), kind: Array.from(flakes.kind),
        nx: fluid.nx, ny: fluid.ny, u: Array.from(fluid.u), v: Array.from(fluid.v), solid: Array.from(fluid.solid),
        kDown: flakes.kDown,
        // the rest grid: 0 free, 1 scene or glass, 2 a resting flake
        rest: { RW: flakes.RW, cw: flakes.cw, ch: flakes.ch, st: Array.from(flakes.st), solid: Array.from(flakes.solidOnly) },
      };
    },
  };
}
