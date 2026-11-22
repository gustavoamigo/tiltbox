// A ball mode: the rigid-ball engine (engine.js) under env.g and fingers, drawn by render.js,
// with impact sounds and haptics. Marbles and Balls are presets of this (presets.js).

import { createGL } from '../../gl.js';
import { buildWorld, mulberry32 } from './presets.js';
import { BallRenderer } from './render.js';

const BG_SCALE = { low: 0.6, medium: 0.8, high: 1 }; // panel target, fraction of sim px
const LIGHT_TAU = 0.6; // s: the light follows "up" this slowly (a shake must not swing it)

export async function createBallMode(ctx, preset) {
  const gl = createGL(ctx.canvas);
  if (!gl) throw new Error('This browser has no WebGL2');
  const quality = ctx.quality;
  const view0 = ctx.view;
  const { world, rand } = buildWorld(preset, quality, view0.simW, view0.simH, (Math.random() * 1e9) | 0);
  const looks = preset.makeLooks(world.rel, rand);
  const renderer = new BallRenderer(gl, preset.render, looks, world.n, BG_SCALE[quality] || 1);

  ctx.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  ctx.canvas.addEventListener('webglcontextrestored', () => renderer.restore());

  // The room light hangs above: it follows the low-passed opposite of gravity, from a little
  // left and in front, so highlights and shadows move as the phone tilts but not as it shakes.
  const up = { x: 0, y: -1, z: 0 };
  const L = new Float32Array(3);
  function updateLight(g, dt) {
    const m = Math.hypot(g.x, g.y, g.z);
    if (m > 0.5) {
      const k = 1 - Math.exp(-dt / LIGHT_TAU);
      up.x += (-g.x / m - up.x) * k; up.y += (-g.y / m - up.y) * k; up.z += (-g.z / m - up.z) * k;
    }
    let lx = -0.3 + 0.55 * up.x, ly = 0.55 * up.y, lz = -0.8 + 0.55 * up.z;
    const l = Math.hypot(lx, ly, lz) || 1;
    lx /= l; ly /= l; lz /= l;
    if (lz > -0.35) { lz = -0.35; const s = Math.sqrt((1 - lz * lz) / Math.max(1e-6, lx * lx + ly * ly)); lx *= s; ly *= s; }
    L[0] = lx; L[1] = ly; L[2] = lz;
  }
  updateLight({ x: 0, y: 9.81, z: 0 }, 10);

  let haptT = 0;
  function sound(dt) {
    haptT -= dt;
    const kind = preset.sound;
    for (let k = 0; k < world.impN; k++) {
      const I = world.impI[k];
      // small balls ring higher; the box wall sounds a little duller than another ball
      const pitch = Math.pow(world.baseR / world.impR[k], preset.pitchExp) * (world.impWall[k] ? preset.wallPitch : 1) * (0.96 + 0.08 * rand());
      ctx.audio.impact(kind, I, pitch);
      if (k === 0 && I > preset.hapticAbove && haptT <= 0) { ctx.haptic(I); haptT = 0.09; }
    }
  }

  return {
    resize(view) {
      // the page turning or the pixel ratio changing leaves the box as it is
      if (view.simW !== world.W || view.simH !== world.H) world.resize(view.simW, view.simH);
    },
    step(dt, env) {
      world.setFingers(env.pointers, dt);
      world.step(dt, env.g);
      updateLight(env.g, dt);
      sound(dt);
    },
    render(view) {
      renderer.render(view, world, L);
    },
    stats() {
      const m = world.measure();
      return {
        // overlaps: deepest ball-ball penetration at a frame end, as a fraction of the smaller
        // radius; maxOverlap since the last stats() call, worstOverlap since the last refill
        count: world.n, nan: m.nan, outside: m.outside, maxOverlap: m.maxOverlap, worstOverlap: m.worstOverlap,
        kinetic: m.kinetic, sleeping: world.asleep ? 1 : 0, contacts: m.contacts, passes: m.passes,
        maxSpeed: m.maxSpeed, repairs: m.repairs,
      };
    },
    reset() {
      world.spawn(mulberry32((Math.random() * 1e9) | 0));
    },
    dispose() {
      renderer.dispose();
    },
    debugState() {
      return { x: Array.from(world.x), y: Array.from(world.y), r: Array.from(world.r), vx: Array.from(world.vx), vy: Array.from(world.vy), asleep: world.asleep };
    },
    world, // tests only
  };
}
