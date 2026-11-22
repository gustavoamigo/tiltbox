// Beer: the FLIP liquid (../fluid/liquid.js) with the BEER preset, and the head beside it
// (head.js: foam, lacing, carbonation; render.js draws it over the beer). The liquid mode is
// used as it is: the head only reads its sim and draws after it.

import { createLiquidMode } from '../fluid/liquid.js';
import { BEER, HEAD } from './tuning.js';
import { Head } from './head.js';
import { HeadRenderer } from './render.js';

const LIGHT_SCREEN = { x: -0.45, y: -0.89 }; // as in liquid.js: the room light, up and a little left

export default async function create(ctx) {
  const base = await createLiquidMode(ctx, BEER);
  const sim = base._sim;
  const q = HEAD.quality[ctx.quality] || HEAD.quality.medium;
  const head = new Head(sim, HEAD, q);
  const renderer = new HeadRenderer(base._renderer.gl, HEAD.look, {
    texScale: q.texScale, maxFoam: q.maxFoam, maxBubbles: q.maxBubbles,
  });
  ctx.canvas.addEventListener('webglcontextrestored', () => renderer.restore());
  const fizz = ctx.audio.bed('fizz');

  const up = { x: 0, y: -1 };
  const light = { x: LIGHT_SCREEN.x, y: LIGHT_SCREEN.y };
  let lastG = { x: 0, y: 9.81, z: 0 };
  let time = 0;
  let headMs = 0;
  let fizzLevel = 0;
  const liqBulk = (Math.PI * (2 * BEER.splat) ** 2) / (8 * Math.sqrt(3));
  const frame = { liquid: base._renderer, liqThresh: BEER.thresh * liqBulk, up, light, time: 0 };

  function resize(view) {
    base.resize(view);
    head.resize(view.simW, view.simH, Math.max(view.simW, view.simH) / BEER.boxMetres);
    const l = view.vecToSim(LIGHT_SCREEN.x, LIGHT_SCREEN.y);
    light.x = l.x; light.y = l.y;
  }

  function step(dt, env) {
    base.step(dt, env);
    const t0 = performance.now();
    head.step(dt, env);
    headMs += (performance.now() - t0 - headMs) * 0.1;
    time += dt;
    const g = env.g;
    lastG = g;
    const gin = Math.hypot(g.x, g.y);
    if (gin > 2) {
      const k = 1 - Math.exp(-dt / 0.25);
      up.x += (-g.x / gin - up.x) * k;
      up.y += (-g.y / gin - up.y) * k;
      const l = Math.hypot(up.x, up.y) || 1;
      up.x /= l; up.y /= l;
    }
    // Fizz: a soft crackle from the bubbles reaching the head, much louder while it foams up.
    // (and a crackle that lingers while a shaken head is still above its resting size)
    const excess = Math.max(0, head.nf / head.nf0 - 1);
    const target = Math.min(1, 0.1 + head.arrivals / 400 + 0.12 * Math.min(2, excess) + 0.9 * head.agit * head.co2);
    fizzLevel += (target - fizzLevel) * (1 - Math.exp(-dt / (target > fizzLevel ? 0.08 : 0.6)));
    fizz.set(fizzLevel, Math.min(1, 0.3 + 0.7 * head.agit));
  }

  function render(view) {
    base.render(view);
    frame.time = time;
    renderer.render(view, head, frame);
  }

  function stats() {
    const s = base.stats();
    const { W, H } = head;
    let nan = s.nan;
    let outside = s.outside;
    for (let i = 0; i < head.nf; i++) {
      const x = head.fx[i]; const y = head.fy[i];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(head.fvx[i]) || !Number.isFinite(head.fvy[i])) nan = true;
      else if (x < 0 || x > W || y < 0 || y > H) outside++;
    }
    for (let i = 0; i < head.nb; i++) {
      const x = head.bx[i]; const y = head.by[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) nan = true;
      else if (x < 0 || x > W || y < 0 || y > H) outside++;
    }
    return {
      ...s,
      nan,
      outside,
      foam: head.nf,
      bubbles: head.nb,
      headPx: head.headPx(lastG.x, lastG.y),
      co2: head.co2,
      headMs,
    };
  }

  return {
    resize,
    step,
    render,
    stats,
    reset() { base.reset(); head.reset(); },
    dispose() {
      fizz.stop();
      renderer.dispose();
      base.dispose();
    },
    debugState() {
      return {
        ...base.debugState(),
        foamX: Array.from(head.fx.subarray(0, head.nf)), foamY: Array.from(head.fy.subarray(0, head.nf)),
        foamR: Array.from(head.fr.subarray(0, head.nf)), foamC: Array.from(head.fc.subarray(0, head.nf)),
        bubX: Array.from(head.bx.subarray(0, head.nb)), bubY: Array.from(head.by.subarray(0, head.nb)),
        bubAge: Array.from(head.bage.subarray(0, head.nb)),
        made: head.made, arrived: head.arrived, rf: head.rf, agit: head.agit,
      };
    },
    _sim: sim,
    _head: head,
  };
}
