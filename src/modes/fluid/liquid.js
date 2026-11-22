// A liquid mode: the FLIP sim (sim.js) driven by env.g and fingers, drawn by the screen-space
// renderer (surface.js), with sound and haptics. Water and Honey are presets (tuning.js).

import { createGL } from '../../gl.js';
import { FlipSim } from './sim.js';
import { LiquidRenderer } from './surface.js';

const G = 9.81;
const MAX_FINGER_SPEED = 2.2; // m/s: a flick pushes, it does not detonate
const SLAM = 0.015; // m/s of stopped wall speed, averaged over the liquid: a hard shake or a flip buzzes
const LIGHT_SCREEN = { x: -0.45, y: -0.89 }; // the room light: up and a little left on the screen

export async function createLiquidMode(ctx, preset) {
  const gl = createGL(ctx.canvas);
  if (!gl) throw new Error('This browser has no WebGL2');
  const q = preset.quality[ctx.quality] || preset.quality.medium;
  const sim = new FlipSim({ count: q.count, cells: q.cells, fill: preset.fill });
  Object.assign(sim.params, {
    flipRatio: preset.flipRatio,
    drift: preset.drift,
    // visc is in cells²/s on the high grid; the same liquid on coarser cells needs less
    visc: (preset.visc * q.cells) / preset.quality.high.cells,
    viscIters: preset.viscIters,
    viscRounds: preset.viscRounds,
    wallSlip: preset.wallSlip,
  });
  const renderer = new LiquidRenderer(gl, preset.look, {
    texScale: q.texScale, maxInstances: q.count * 2 + 1200, blur: 2, caustics: q.caustics,
  });

  ctx.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  ctx.canvas.addEventListener('webglcontextrestored', () => renderer.restore());

  const bed = ctx.audio.bed(preset.bed);
  let W = 0;
  let H = 0;
  let pxPerM = 1;
  let seeded = false;
  let time = 0;
  let causticT = 0;
  let wobble = 0;
  const up = { x: 0, y: -1 };
  const light = { x: LIGHT_SCREEN.x, y: LIGHT_SCREEN.y };
  let lastG = { x: 0, y: G, z: 0 };
  let substeps = 1;
  let dropTokens = 3;
  let slamCool = 0;
  let slamLevel = 0;
  const fingers = new Map(); // id -> { x, y, px, py, vx, vy, seen }
  const obstacles = [];

  function seed() {
    sim.seed(preset.seed);
    seeded = true;
  }

  function resize(view) {
    W = view.simW;
    H = view.simH;
    sim.setBox(W, H);
    pxPerM = Math.max(W, H) / preset.boxMetres;
    sim.params.vmax = 6 * pxPerM; // 6 m/s: beyond anything a hand does to a box
    const l = view.vecToSim(LIGHT_SCREEN.x, LIGHT_SCREEN.y);
    light.x = l.x; light.y = l.y;
    if (!seeded) seed();
  }

  // Fingers become moving round obstacles; their positions are swept across the substeps.
  function updateFingers(env) {
    const R = preset.fingerR * Math.min(W, H);
    const vcap = MAX_FINGER_SPEED * pxPerM;
    for (const f of fingers.values()) f.seen = false;
    for (const p of env.pointers) {
      let f = fingers.get(p.id);
      if (!f) { f = { x: p.x, y: p.y, px: p.x, py: p.y, vx: 0, vy: 0, seen: true }; fingers.set(p.id, f); }
      f.px = f.x; f.py = f.y;
      f.x = Math.min(Math.max(p.x, 0), W); f.y = Math.min(Math.max(p.y, 0), H);
      let vx = p.vx || 0;
      let vy = p.vy || 0;
      const s = Math.hypot(vx, vy);
      if (s > vcap) { vx *= vcap / s; vy *= vcap / s; }
      f.vx = vx; f.vy = vy;
      f.seen = true;
    }
    for (const [id, f] of fingers) if (!f.seen) fingers.delete(id);
    while (obstacles.length < fingers.size) obstacles.push({ x: 0, y: 0, r: R, vx: 0, vy: 0, foam: 0, fill: 0 });
    obstacles.length = fingers.size;
    let k = 0;
    for (const f of fingers.values()) {
      const o = obstacles[k++];
      o.r = R; o.vx = f.vx; o.vy = f.vy;
      // whitewater behind a finger moving faster than about 0.3 m/s
      const sp = Math.hypot(f.vx, f.vy) / pxPerM;
      o.foam = preset.fingerFoam * Math.min(1, Math.max(0, (sp - 0.3) / 1.2));
    }
    sim.obstacles = obstacles;
  }

  function placeFingers(t) {
    let k = 0;
    for (const f of fingers.values()) {
      obstacles[k].x = f.px + (f.x - f.px) * t;
      obstacles[k].y = f.py + (f.y - f.py) * t;
      k++;
    }
  }

  function step(dt, env) {
    time += dt;
    const g = env.g;
    lastG = g;
    const gx = g.x * pxPerM;
    const gy = g.y * pxPerM;
    const gPx = G * pxPerM;
    // Lying flat, the back glass carries the liquid's weight and its friction stops the flow.
    const damp = preset.damp + preset.flatDamp * Math.min(1, Math.abs(g.z) / G);

    // In-plane "up" for the lighting, smoothed so shakes do not make the highlights jump.
    const gin = Math.hypot(g.x, g.y);
    if (gin > 2) {
      const k = 1 - Math.exp(-dt / 0.25);
      up.x += (-g.x / gin - up.x) * k;
      up.y += (-g.y / gin - up.y) * k;
      const l = Math.hypot(up.x, up.y) || 1;
      up.x /= l; up.y /= l;
    }

    updateFingers(env);
    // Substeps: enough that the bulk of the liquid crosses at most cfl cells in one, within the
    // budget. A lone fast droplet may jump further; the walls clamp it whatever its speed.
    const h = Math.min(sim.hx, sim.hy);
    const reach = (Math.min(sim.maxSpeed, 2.5 * sim.rmsSpeed) + Math.hypot(gx, gy) * dt) * dt;
    substeps = Math.max(1, Math.min(q.maxSub, Math.ceil(reach / (preset.cfl * h))));
    const sdt = dt / substeps;
    const pushTotal = q.push || 2; // push-apart iterations a frame, spread over the substeps
    sim.params.pressureIters = Math.max(16, Math.ceil(q.pressureIters / substeps));
    sim.beginFrame();
    if (preset.seedWave && gin > 2) {
      // honey: the faint unevenness a hanging layer drips from (see FlipSim.nudge)
      const L = Math.abs(g.x) > Math.abs(g.y) ? H : W; // the box across gravity
      sim.nudge(g.x / gin, g.y / gin, preset.seedWave * pxPerM * dt * 60, (3 * Math.PI) / L, time * 0.7);
    }
    for (let s = 0; s < substeps; s++) {
      placeFingers((s + 1) / substeps);
      sim.params.pushIters = Math.floor((pushTotal * (s + 1)) / substeps) - Math.floor((pushTotal * s) / substeps);
      sim.substep(sdt, gx, gy, damp);
    }
    sim.endFrame(dt, gx, gy, gPx, preset.foam);

    // Sound: the bed follows how much is moving; drops follow real landings.
    const mean = sim.meanSpeed / pxPerM; // m/s
    const level = Math.min(1, mean / (0.3 * preset.speedRef));
    const tone = Math.min(1, sim.maxSpeed / pxPerM / (2 * preset.speedRef));
    bed.set(level, tone);
    causticT += dt * (0.3 + 2.0 * Math.min(1, mean / 0.3));
    wobble += (Math.min(1, mean / 0.4) * 3 - wobble) * (1 - Math.exp(-dt / 0.3));

    dropTokens = Math.min(3, dropTokens + dt * 12);
    if (preset.drops && sim.impacts.n > 0 && dropTokens >= 1) {
      const intensity = Math.min(1, sim.impacts.max / pxPerM / (1.5 * preset.speedRef));
      if (intensity > 0.12) {
        dropTokens -= 1;
        const small = 1 / (1 + 0.15 * sim.impacts.n); // one droplet rings high, a shower lower
        ctx.audio.impact('drop', intensity, 0.8 + 0.7 * small + 0.25 * Math.random());
      }
    }

    // A heavy slam against a wall: speed into the walls stopped this frame, m/s averaged over
    // all the liquid (a whole pool hitting a wall at 1 m/s reads about 0.2).
    const slam = sim.slam / pxPerM;
    slamLevel = Math.max(slam, slamLevel * Math.exp(-dt / 0.3));
    slamCool -= dt;
    if (slam > SLAM && slamCool <= 0) {
      slamCool = 0.18;
      const s = Math.min(1, slam / (4 * SLAM));
      ctx.haptic(s);
      ctx.audio.impact('drop', 0.5 + 0.5 * s, preset.name === 'honey' ? 0.4 : 0.55);
    }
  }

  // Field value inside resting liquid: the splat kernel summed over a hexagonal packing.
  const bulk = (Math.PI * (2 * preset.splat) ** 2) / (8 * Math.sqrt(3));
  const frame = { sim, obstacles, up, light, bulk, loneWeight: preset.loneWeight }; // reused

  function render(view) {
    // A finger under the liquid is on the front glass, not in it: draw the liquid over its hole.
    for (const o of obstacles) {
      const f = sim.liquidAround(o.x, o.y, o.r + 1.5 * Math.max(sim.hx, sim.hy));
      o.fill = Math.min(1, Math.max(0, (f - 0.55) / 0.35));
    }
    frame.splatR = preset.splat * 2 * sim.r;
    frame.thresh = preset.thresh * bulk;
    frame.speedRef = preset.speedRef * pxPerM;
    frame.time = time;
    frame.causticT = causticT;
    frame.wobble = wobble;
    renderer.render(view, frame);
  }

  function stats() {
    const { n, px, py, vx, vy } = sim;
    let nan = false;
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const x = px[i]; const y = py[i];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vx[i]) || !Number.isFinite(vy[i])) nan = true;
      else if (x < 0 || x > W || y < 0 || y > H) outside++;
    }
    return {
      count: n,
      nan,
      outside,
      fillFraction: sim.fillFraction(),
      surfaceTilt: sim.surfaceTilt(lastG.x, lastG.y),
      kinetic: sim.meanSpeed / pxPerM,
      substeps,
      slam: slamLevel,
      cells: `${sim.nx}x${sim.ny}`,
    };
  }

  return {
    resize,
    step,
    render,
    stats,
    reset() { seed(); },
    dispose() {
      bed.stop();
      renderer.dispose();
    },
    debugState() {
      return {
        px: Array.from(sim.px), py: Array.from(sim.py), vx: Array.from(sim.vx), vy: Array.from(sim.vy),
        foam: Array.from(sim.foam), r: sim.r, hx: sim.hx, hy: sim.hy, nx: sim.nx, ny: sim.ny, pxPerM,
        instances: renderer.instances, half: renderer.field ? renderer.field.half : null,
      };
    },
    _sim: sim, // tests: direct access to the solver and the renderer
    _renderer: renderer,
    _preset: preset,
  };
}
