// The Sand mode: the grid sand engine (grid.js) driven by env.g and fingers, drawn by render.js,
// with a sand bed, grain ticks on hard hits and haptics on slams.

import { createGL } from '../../gl.js';
import { SandGrid, PX_PER_M, V_MOVING } from './grid.js';
import { SandRenderer } from './render.js';
import { fillLayers } from './fill.js';

// cell: grid cell (= grain) size in CSS px; draw: sprite diameter in cells.
const QUALITY = {
  low: { cell: 4.0, draw: 1.4 },
  medium: { cell: 3.4, draw: 1.4 },
  high: { cell: 2.8, draw: 1.4 },
};
const LEVEL = 0.36; // fill height, fraction of the box

export default async function create(ctx) {
  const gl = createGL(ctx.canvas);
  if (!gl) throw new Error('This browser has no WebGL2');
  const q = QUALITY[ctx.quality] || QUALITY.high;
  const view0 = ctx.view;
  // room for a full box at any orientation of this screen
  const cap = Math.ceil((view0.simW / q.cell + 2) * (view0.simH / q.cell + 2));
  const grid = new SandGrid(cap, q.cell);
  let renderer = new SandRenderer(gl, cap);
  const rgba = new Uint8Array(cap * 4);
  const bed = ctx.audio.bed('sand');
  let filled = false;
  let lastG = { x: 0, y: 9.81, z: 0 };
  let level = 0, tone = 0, tickTokens = 0, slamCool = 0;

  // A lost context (iOS may drop one in the background) comes back empty: build the GL side again.
  ctx.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  ctx.canvas.addEventListener('webglcontextrestored', () => {
    renderer = new SandRenderer(gl, cap);
    renderer.setColours(rgba, grid.n);
  });

  function refill() {
    const n = fillLayers(grid, rgba, LEVEL);
    renderer.setColours(rgba, n);
    filled = true;
  }

  function soundAndTouch(dt) {
    // bed: how much sand moves and how fast
    let moving = 0, speed = 0;
    const { n, vx, vy } = grid;
    if (grid.nAwake) {
      for (let i = 0; i < n; i++) {
        const v2 = vx[i] * vx[i] + vy[i] * vy[i];
        if (v2 > V_MOVING * V_MOVING) { moving++; speed += Math.sqrt(v2); }
      }
    }
    const frac = moving / Math.max(1, n);
    const meanV = moving ? speed / moving : 0;
    const tl = Math.min(1, Math.sqrt(frac * 6));
    const tt = Math.min(1, meanV / 900);
    const k = 1 - Math.exp(-dt / 0.06);
    level += (tl - level) * k;
    tone += (tt - tone) * k;
    bed.set(level, tone);
    // ticks: hard hits against walls and other grains, a few a frame
    tickTokens = Math.min(4, tickTokens + dt * 40);
    const hard = grid.hard / Math.max(1, n);
    if (hard > 0.02 && tickTokens >= 1) {
      const m = Math.min(4, Math.floor(tickTokens));
      for (let j = 0; j < m; j++) ctx.audio.impact('grain', Math.min(1, hard * (0.5 + Math.random())), 0.8 + 0.5 * Math.random());
      tickTokens -= m;
    }
    // a slam of the whole pile against a wall: a short buzz
    slamCool -= dt;
    if (hard > 2.5 && slamCool <= 0) { ctx.haptic(Math.min(1, hard / 12)); slamCool = 0.12; }
  }

  return {
    resize(view) {
      grid.setBox(view.simW, view.simH, lastG);
      if (!filled) refill();
      renderer.dirty = true;
    },

    step(dt, env) {
      lastG = env.g;
      grid.setFingers(env.pointers);
      grid.step(dt, env.g);
      if (grid.moved || grid.nAwake) renderer.dirty = true; // several steps may come before a render
      soundAndTouch(dt);
    },

    render(view) {
      renderer.draw(view, grid, lastG, q.draw);
    },

    stats() {
      const { n, vx, vy } = grid;
      let moving = 0, ke = 0, nan = false, outside = 0;
      for (let i = 0; i < n; i++) {
        const v2 = vx[i] * vx[i] + vy[i] * vy[i];
        if (v2 > V_MOVING * V_MOVING) moving++;
        ke += v2;
        const x = grid.posX(i), y = grid.posY(i);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(v2)) nan = true;
        else if (x < 0 || x > grid.W || y < 0 || y > grid.H) outside++;
      }
      return {
        count: n, nan, outside,
        moving: n ? moving / n : 0,
        reposeAngle: grid.reposeAngle(lastG),
        kinetic: n ? (0.5 * ke) / n / (PX_PER_M * PX_PER_M) : 0, // mean J/kg
        awake: grid.nAwake,
        cell: +grid.sx.toFixed(3),
      };
    },

    debugState() {
      const { n } = grid;
      const x = new Float32Array(n), y = new Float32Array(n);
      for (let i = 0; i < n; i++) { x[i] = grid.posX(i); y[i] = grid.posY(i); }
      return { n, x, y, gw: grid.gw, gh: grid.gh };
    },

    reset() {
      refill();
    },

    dispose() {
      bed.stop();
      renderer.dispose();
    },
  };
}
