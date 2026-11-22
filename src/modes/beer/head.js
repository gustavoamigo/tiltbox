// The head of a pint, beside the FLIP liquid (../fluid/sim.js), which it reads but never pushes:
//   foam:   light particles packed by position-based push-apart. Out of the liquid they fall with
//           gravity and rest on whatever is under them; in it they take the liquid's velocity plus
//           a rise against gravity, so the head floats on top whichever way the box points.
//           Each has a lifetime; at its end it shrinks away and the rest settle into its place.
//   lacing: a film on the back glass wherever foam has stood, on a grid twice as fine as the
//           sim's. It slides down slowly, fades, and the liquid washes it off.
//   bubbles: carbonation tracers carried by the liquid's grid velocity plus a rise that grows
//           with age. They start at a few nucleation points on the glass and anywhere in the
//           bulk, and feed the head where they reach the surface.
// A shake (g high-passed, so not a tilt) or a hard stir releases gas: new foam just under the surface and a flurry
// of bubbles, while the carbonation lasts (it comes back slowly).
//
// Units: sim px, px/s, seconds; m/s values in the config are scaled by pxPerM. Every array is
// allocated up front or when the box changes size: a step allocates nothing.

const G = 9.81;
const HEX = 2 * Math.sqrt(3); // area of a hexagonal packing cell, in r²

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class Head {
  constructor(sim, cfg, q) {
    this.sim = sim;
    this.cfg = cfg;
    this.q = q;
    const M = q.maxFoam;
    this.maxFoam = M;
    this.nf = 0;
    this.fx = new Float32Array(M); this.fy = new Float32Array(M);
    this.fvx = new Float32Array(M); this.fvy = new Float32Array(M);
    this.ox = new Float32Array(M); this.oy = new Float32Array(M);
    this.fr = new Float32Array(M); // radius now
    this.frt = new Float32Array(M); // radius it grows to (0: dying)
    this.fc = new Float32Array(M); // coarse 0..1 (fresh foam from a shake)
    this.fage = new Float32Array(M);
    this.flife = new Float32Array(M);
    this.hashOf = new Int32Array(M); this.ids = new Int32Array(M);
    this.sx = new Float32Array(M); this.sy = new Float32Array(M); this.sr = new Float32Array(M);
    this.svx = new Float32Array(M); this.svy = new Float32Array(M);
    this.snn = new Uint8Array(M);
    this.pvx = new Float32Array(M); this.pvy = new Float32Array(M); // velocity before the push-apart
    this.fnn = new Uint8Array(M); // foam neighbours touching, last frame (lone foam draws heavier)
    this.hashFirst = null; this.hashCount = null;
    this.cand = new Int32Array(sim.n); // liquid particles near the surface, this frame

    const B = q.maxBubbles;
    this.maxBubbles = B;
    this.nb = 0;
    this.bx = new Float32Array(B); this.by = new Float32Array(B);
    this.bage = new Float32Array(B); this.br = new Float32Array(B);
    this.bph = new Float32Array(B); // wobble phase
    this.siteAcc = new Float32Array(cfg.sites.length);
    this.bubbleLifeNow = cfg.bubbleLife; // s: how long a bubble may live, given the tilt (render fades it out)

    this.W = 0; this.H = 0; this.pxPerM = 1;
    this.rf = 1;
    this.lw = 0; this.lh = 0;
    this.lace = null; this.laceTmp = null; this.lace8 = null;
    this.co2 = 1;
    this.spawnAcc = 0;
    this.bulkAcc = 0;
    this.credit = 0;
    this.agit = 0;
    this.shake = 0; // m/s², g high-passed (see step)
    this.lpFast = { x: 0, y: G, z: 0 };
    this.lpInit = false;
    this.time = 0;
    this.made = 0; // foam particles made by shakes, total (tests)
    this.arrived = 0; // bubbles that reached the surface (tests, sound)
    this.arrivals = 0; // smoothed arrivals per second (sound)
    this._rand = 0x9e3779b9;
    this.prof = null; // set to {} to accumulate per-stage ms (tests)
    this.seeded = false;
  }

  rnd() { // xorshift32, 0..1
    let x = this._rand;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._rand = x >>> 0;
    return this._rand / 4294967296;
  }

  // The box changed size (or first call): rescale into it, as the liquid does.
  resize(W, H, pxPerM) {
    if (this.W > 0 && (W !== this.W || H !== this.H)) {
      const kx = W / this.W; const ky = H / this.H;
      for (let i = 0; i < this.nf; i++) { this.fx[i] *= kx; this.fy[i] *= ky; this.fvx[i] *= kx; this.fvy[i] *= ky; }
      for (let i = 0; i < this.nb; i++) { this.bx[i] *= kx; this.by[i] *= ky; }
    }
    this.W = W; this.H = H; this.pxPerM = pxPerM;
    this.rf = this.q.foamR * this.sim.r;
    this.hs = 2 * 1.3 * this.rf; // hash cell: the largest diameter
    this.hashNX = Math.ceil(W / this.hs) + 1;
    this.hashNY = Math.ceil(H / this.hs) + 1;
    const hc = this.hashNX * this.hashNY;
    if (!this.hashFirst || this.hashFirst.length !== hc + 1) {
      this.hashFirst = new Int32Array(hc + 1);
      this.hashCount = new Int32Array(hc);
    }
    const lw = 2 * this.sim.nx; const lh = 2 * this.sim.ny;
    if (lw !== this.lw || lh !== this.lh) {
      this.lw = lw; this.lh = lh;
      this.lace = new Float32Array(lw * lh);
      this.laceTmp = new Float32Array(lw * lh);
      this.lace8 = new Uint8Array(lw * lh);
    }
    this._clampAll();
    if (!this.seeded) this.reset();
  }

  // A fresh pint: a level head of cfg.head of the liquid's height on the liquid as seeded
  // (upright), no lacing, no bubbles, full carbonation.
  reset() {
    const { sim, W, rf } = this;
    let top = Infinity;
    for (let i = 0; i < sim.n; i++) if (sim.py[i] < top) top = sim.py[i];
    top -= sim.r;
    const liquidH = this.H - top;
    const h0 = this.cfg.head * liquidH;
    const dx = 2 * rf; const dy = Math.sqrt(3) * rf;
    this.nf = 0;
    // Rows from the liquid up; the head's own weight packs it a little (a few % of its height).
    for (let row = 0; ; row++) {
      const y = top - rf * 0.6 - row * dy;
      if (top - y > h0 * 1.06 || y < rf) break;
      for (let x = rf + (row & 1 ? rf : 0); x <= W - rf; x += dx) {
        this._add(x + (this.rnd() - 0.5) * 0.2 * rf, y, rf * (0.92 + 0.13 * this.rnd()), 0, this._fineLife(), 1);
      }
    }
    this.nf0 = Math.max(1, this.nf);
    this.nb = 0;
    this.siteAcc.fill(0);
    if (this.lace) this.lace.fill(0);
    this.co2 = 1; this.spawnAcc = 0; this.bulkAcc = 0; this.credit = 0; this.agit = 0;
    this.made = 0; this.arrived = 0; this.arrivals = 0;
    this.seeded = true;
  }

  _fineLife() { return -this.cfg.fineLife * Math.log(1 - this.rnd() * 0.999); }

  _add(x, y, rt, coarse, life, grown) {
    if (this.nf >= this.maxFoam) return -1;
    const i = this.nf++;
    this.fx[i] = x; this.fy[i] = y; this.fvx[i] = 0; this.fvy[i] = 0;
    this.frt[i] = rt; this.fr[i] = grown ? rt : 0.35 * rt;
    this.fc[i] = coarse; this.fage[i] = 0; this.flife[i] = life; this.fnn[i] = 6;
    return i;
  }

  _remove(i) {
    const k = --this.nf;
    if (i === k) return;
    this.fx[i] = this.fx[k]; this.fy[i] = this.fy[k]; this.fvx[i] = this.fvx[k]; this.fvy[i] = this.fvy[k];
    this.fr[i] = this.fr[k]; this.frt[i] = this.frt[k]; this.fc[i] = this.fc[k];
    this.fage[i] = this.fage[k]; this.flife[i] = this.flife[k]; this.fnn[i] = this.fnn[k];
  }

  _clampAll() {
    const { W, H } = this;
    for (let i = 0; i < this.nf; i++) {
      if (!Number.isFinite(this.fx[i]) || !Number.isFinite(this.fy[i])) { this.fx[i] = W / 2; this.fy[i] = H / 2; }
      if (!Number.isFinite(this.fvx[i]) || !Number.isFinite(this.fvy[i])) { this.fvx[i] = 0; this.fvy[i] = 0; }
      const r = this.fr[i];
      this.fx[i] = Math.min(Math.max(this.fx[i], r), W - r);
      this.fy[i] = Math.min(Math.max(this.fy[i], r), H - r);
    }
    for (let i = 0; i < this.nb; i++) {
      this.bx[i] = Math.min(Math.max(this.bx[i], 1), W - 1);
      this.by[i] = Math.min(Math.max(this.by[i], 1), H - 1);
    }
  }

  // Liquid fraction at (x, y): the sim's cell-centre density over its rest density, bilinear
  // between cells inside the box.
  phi(x, y) {
    const { hx, hy, NX, NY, density, rest } = this.sim;
    let gx = x / hx + 0.5; let gy = y / hy + 0.5;
    if (gx < 1) gx = 1; else if (gx > NX - 2.001) gx = NX - 2.001;
    if (gy < 1) gy = 1; else if (gy > NY - 2.001) gy = NY - 2.001;
    const i0 = gx | 0; const j0 = gy | 0;
    const tx = gx - i0; const ty = gy - j0;
    const b = i0 + j0 * NX;
    const d = (1 - tx) * (1 - ty) * density[b] + tx * (1 - ty) * density[b + 1]
      + tx * ty * density[b + NX + 1] + (1 - tx) * ty * density[b + NX];
    const f = d / rest;
    return f > 1 ? 1 : f;
  }

  // The liquid's grid velocity at (x, y) into this.vel, as the particles read it (faces between
  // two air cells carry no weight). Returns false where there is no liquid face nearby.
  velAt(x, y) {
    const { hx, hy, NX, NY, u, v, uValid, vValid } = this.sim;
    let gxp = x / hx + 1; let gyp = y / hy + 1;
    if (gxp < 1) gxp = 1; else if (gxp > NX - 1.001) gxp = NX - 1.001;
    if (gyp < 1) gyp = 1; else if (gyp > NY - 1.001) gyp = NY - 1.001;
    let X = gxp; let Y = gyp - 0.5;
    let x0 = X | 0; let y0 = Y | 0; let tx = X - x0; let ty = Y - y0; let b = x0 + y0 * NX;
    let w00 = uValid[b] * (1 - tx) * (1 - ty); let w10 = uValid[b + 1] * tx * (1 - ty);
    let w11 = uValid[b + NX + 1] * tx * ty; let w01 = uValid[b + NX] * (1 - tx) * ty;
    let d = w00 + w10 + w11 + w01;
    if (!(d > 0)) return false;
    this.vx = (w00 * u[b] + w10 * u[b + 1] + w11 * u[b + NX + 1] + w01 * u[b + NX]) / d;
    X = gxp - 0.5; Y = gyp;
    x0 = X | 0; y0 = Y | 0; tx = X - x0; ty = Y - y0; b = x0 + y0 * NX;
    w00 = vValid[b] * (1 - tx) * (1 - ty); w10 = vValid[b + 1] * tx * (1 - ty);
    w11 = vValid[b + NX + 1] * tx * ty; w01 = vValid[b + NX] * (1 - tx) * ty;
    d = w00 + w10 + w11 + w01;
    if (!(d > 0)) return false;
    this.vy = (w00 * v[b] + w10 * v[b + 1] + w11 * v[b + NX + 1] + w01 * v[b + NX]) / d;
    return true;
  }

  // A random liquid particle within `maxDepth` cells of the air (or deeper than minDepth);
  // its index, or -1 after a few misses.
  _pickLiquid(minDepth, maxDepth) {
    const sim = this.sim;
    const { n, px, py, dens, dist, NX } = sim;
    const ihx = 1 / sim.hx; const ihy = 1 / sim.hy;
    for (let t = 0; t < 12; t++) {
      const i = (this.rnd() * n) | 0;
      if (dens[i] < 0.6) continue;
      const d = dist[((px[i] * ihx + 1) | 0) + ((py[i] * ihy + 1) | 0) * NX];
      if (d >= minDepth && d <= maxDepth) return i;
    }
    return -1;
  }

  // env: the mode's env. Advances foam, bubbles and lacing by dt; reads the liquid as the
  // sim's last frame left it.
  step(dt, env) {
    const cfg = this.cfg;
    const P = this.pxPerM;
    this.time += dt;
    const g = env.g;
    const gx = g.x * P; const gy = g.y * P;
    const gin = Math.hypot(g.x, g.y);
    // against in-plane gravity; on a flat phone bubbles and foam rise toward the viewer instead
    const upx = gin > 1e-3 ? -g.x / gin : 0; const upy = gin > 1e-3 ? -g.y / gin : -1;
    const inPlane = Math.min(1, gin / G);

    // Agitation: a shake, or a stir fast enough to beat air in. The shake is g high-passed over
    // 60 ms (held 0.25 s): a hand shake at 4-8 Hz passes at 80-95% of its swing, a tilt (even a
    // quick half-second one) leaves under 3 m/s², so tilting keeps the head as it is.
    const kf = 1 - Math.exp(-dt / cfg.shakeTau);
    const lp = this.lpFast;
    if (!this.lpInit) { lp.x = g.x; lp.y = g.y; lp.z = g.z; this.lpInit = true; }
    lp.x += (g.x - lp.x) * kf; lp.y += (g.y - lp.y) * kf; lp.z += (g.z - lp.z) * kf;
    const hp = Math.hypot(g.x - lp.x, g.y - lp.y, g.z - lp.z);
    this.shake = Math.max(hp, this.shake * Math.exp(-dt / 0.25));
    const shake = smooth01((this.shake - cfg.shakeLo) / (cfg.shakeHi - cfg.shakeLo));
    const stir = env.pointers && env.pointers.length
      ? smooth01((this.sim.meanSpeed / P - cfg.stirLo) / (cfg.stirHi - cfg.stirLo)) : 0;
    this.agit = Math.max(shake, stir);
    this.co2 += (1 - this.co2) * (1 - Math.exp(-dt * cfg.co2Back));

    const prof = this.prof;
    let t = prof ? performance.now() : 0;
    const lap = (k) => { if (!prof) return; const t1 = performance.now(); prof[k] = (prof[k] || 0) + t1 - t; t = t1; };
    this._makeFoam(dt, upx, upy);
    lap('make');
    this._bubbles(dt, upx, upy, inPlane);
    lap('bubbles');
    const sub = dt > 1 / 50 ? 2 : 1;
    for (let s = 0; s < sub; s++) this._foam(dt / sub, gx, gy, upx, upy, inPlane, Math.abs(g.z) / G);
    lap('foam');
    this._lacing(dt, g.x / G, g.y / G);
    lap('lace');
  }

  // Gas out of solution: new foam just under the surface, where it floats up into the head.
  _makeFoam(dt, upx, upy) {
    const cfg = this.cfg;
    const sim = this.sim;
    const perPx = this.W / (HEX * this.rf * this.rf); // foam particles per px of head
    this.spawnAcc += cfg.foamRate * perPx * this.agit * this.co2 * dt;
    if (this.spawnAcc < 1) return;
    // the liquid particles within 2.5 cells of the air
    const { n, px, py, dens, dist, NX } = sim;
    const ihx = 1 / sim.hx; const ihy = 1 / sim.hy;
    const cand = this.cand;
    let nc = 0;
    for (let i = 0; i < n; i++) {
      if (dens[i] < 0.6) continue;
      if (dist[((px[i] * ihx + 1) | 0) + ((py[i] * ihy + 1) | 0) * NX] <= 2.5) cand[nc++] = i;
    }
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.nf >= this.maxFoam || nc === 0) { this.spawnAcc = 0; break; }
      const p = cand[(this.rnd() * nc) | 0];
      const fine = this.rnd() < cfg.shakeFine;
      const [l0, l1] = cfg.shakeLife;
      const life = fine ? this._fineLife() : l0 + (l1 - l0) * this.rnd();
      const coarse = fine ? 0 : 0.4 + 0.6 * this.rnd();
      const x = sim.px[p] + (this.rnd() - 0.5) * this.rf + upx * this.rf;
      const y = sim.py[p] + (this.rnd() - 0.5) * this.rf + upy * this.rf;
      const i = this._add(x, y, this.rf * (0.95 + 0.3 * coarse) * (0.9 + 0.2 * this.rnd()), coarse, life, 0);
      if (i >= 0) {
        this.fvx[i] = sim.vx[p]; this.fvy[i] = sim.vy[p];
        this.made++;
        this.co2 = Math.max(0, this.co2 - cfg.co2Use / perPx);
      }
    }
  }

  _foam(dt, gx, gy, upx, upy, inPlane, flat) {
    const cfg = this.cfg;
    const P = this.pxPerM;
    const { fx, fy, fvx, fvy, ox, oy, fr, frt, fage, flife, pvx, pvy } = this;
    const rise = cfg.rise * P * inPlane;
    const airK = Math.exp(-(cfg.airDrag + 6 * flat) * dt);
    const vmax = 6 * P;
    const grow = 1 - Math.exp(-dt / 0.25);
    const shrink = 1 - Math.exp(-dt / 0.6);
    // Forces, then predicted positions.
    for (let i = 0; i < this.nf; i++) {
      fage[i] += dt;
      if (fage[i] > flife[i]) frt[i] = 0;
      fr[i] += (frt[i] - fr[i]) * (frt[i] > 0 ? grow : shrink);
      const x = fx[i]; const y = fy[i];
      ox[i] = x; oy[i] = y;
      const s = smooth01((this.phi(x, y) - 0.3) / 0.5); // how far under the surface
      let vx = fvx[i] + gx * dt * (1 - s);
      let vy = fvy[i] + gy * dt * (1 - s);
      if (s > 0 && this.velAt(x, y)) {
        const k = 1 - Math.exp(-cfg.grab * dt * s);
        vx += (this.vx + upx * rise - vx) * k;
        vy += (this.vy + upy * rise - vy) * k;
      }
      vx *= airK; vy *= airK;
      const sp2 = vx * vx + vy * vy;
      if (!(sp2 <= vmax * vmax)) {
        const f = sp2 > 0 && Number.isFinite(sp2) ? vmax / Math.sqrt(sp2) : 0;
        vx = Number.isFinite(vx) ? vx * f : 0; vy = Number.isFinite(vy) ? vy * f : 0;
      }
      fvx[i] = vx; fvy[i] = vy;
      pvx[i] = vx; pvy[i] = vy;
      fx[i] = x + vx * dt; fy[i] = y + vy * dt;
    }
    // Remove the ones that have shrunk away.
    for (let i = this.nf - 1; i >= 0; i--) if (frt[i] === 0 && fr[i] < 0.3 * this.rf) this._remove(i);

    if (this.prof) { const t0 = performance.now(); this._pack(this.q.foamIters, dt, gx / (G * P), gy / (G * P)); this.prof.pack = (this.prof.pack || 0) + performance.now() - t0; }
    else this._pack(this.q.foamIters, dt, gx / (G * P), gy / (G * P));

    // Velocities from the corrected positions; walls; touching side walls grip. A packed head
    // has overlaps left over from earlier frames (and new foam grows into it); undoing them
    // must not fling foam about, so what the push-apart adds to a velocity, beyond stopping
    // the motion into a neighbour, is capped.
    const { W, H } = this;
    const grip = Math.exp(-cfg.wallGrip * dt);
    const idt = 1 / dt;
    const cap = cfg.maxPush * P;
    for (let i = 0; i < this.nf; i++) {
      const r = fr[i];
      let x = fx[i]; let y = fy[i];
      let wx = 0; let wy = 0;
      if (!(x >= r)) { x = r; wx = -1; } else if (!(x <= W - r)) { x = W - r; wx = 1; }
      if (!(y >= r)) { y = r; wy = -1; } else if (!(y <= H - r)) { y = H - r; wy = 1; }
      fx[i] = x; fy[i] = y;
      const ax = pvx[i]; const ay = pvy[i];
      let dvx = (x - ox[i]) * idt - ax; let dvy = (y - oy[i]) * idt - ay;
      const dv = Math.sqrt(dvx * dvx + dvy * dvy);
      const lim = cap + Math.sqrt(ax * ax + ay * ay);
      if (dv > lim) { dvx *= lim / dv; dvy *= lim / dv; }
      let vx = ax + dvx; let vy = ay + dvy;
      // (out of the liquid only: under it, foam on the glass floats up like the rest)
      if ((wx || wy) && this.phi(x, y) < 0.3) {
        if (wx) vy *= grip;
        if (wy) vx *= grip;
      }
      fvx[i] = vx; fvy[i] = vy;
    }
  }

  // Push-apart among the foam (pairs closer than the sum of their radii move apart by half the
  // overlap each), then a share of the relative velocity between touching pairs (XSPH), so the
  // head moves as one creamy body instead of a pile of marbles. Same hash walk as the liquid's
  // push-apart: each cell checks the rest of itself and its right neighbour, and the three
  // cells below; every pair is seen once.
  _pack(iters, dt, gnx, gny) {
    const { nf, fx, fy, fr, fvx, fvy, ox, oy, hashOf, ids, hashFirst, hashCount, sx, sy, sr, svx, svy } = this;
    const HX = this.hashNX; const HY = this.hashNY;
    const inv = 1 / this.hs;
    const hc = HX * HY;
    hashCount.fill(0);
    for (let i = 0; i < nf; i++) {
      let cx = (fx[i] * inv) | 0; let cy = (fy[i] * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= HX) cx = HX - 1;
      if (cy < 0) cy = 0; else if (cy >= HY) cy = HY - 1;
      const c = cx + cy * HX;
      hashOf[i] = c; hashCount[c]++;
    }
    let acc = 0;
    for (let c = 0; c < hc; c++) { hashFirst[c] = acc; acc += hashCount[c]; hashCount[c] = hashFirst[c]; }
    hashFirst[hc] = acc;
    for (let i = 0; i < nf; i++) {
      const k = hashCount[hashOf[i]]++;
      ids[k] = i; sx[k] = fx[i]; sy[k] = fy[i]; sr[k] = fr[i];
    }
    const lastRow = (HY - 1) * HX;
    for (let it = 0; it < iters; it++) {
      // cohesion once a frame, with the last pass
      const coh = it === iters - 1 ? this.cfg.cohesion : 0;
      for (let c = 0; c < hc; c++) {
        const a = hashFirst[c]; const b = hashFirst[c + 1];
        if (a === b) continue;
        const e1 = hashFirst[c + 2 < hc ? c + 2 : hc];
        let lo = 0; let hi = 0;
        if (c < lastRow) { const d = c + HX; lo = hashFirst[d - 1]; hi = hashFirst[d + 2 < hc ? d + 2 : hc]; }
        for (let k = a; k < b; k++) {
          this._relax(k, k + 1, e1, coh, gnx, gny);
          if (lo < hi) this._relax(k, lo, hi, coh, gnx, gny);
        }
      }
    }
    // XSPH on the velocities the corrections imply.
    const idt = 1 / dt;
    for (let k = 0; k < nf; k++) {
      const i = ids[k];
      svx[k] = fvx[i] + (sx[k] - fx[i]) * idt;
      svy[k] = fvy[i] + (sy[k] - fy[i]) * idt;
    }
    const mu = this.cfg.xsph;
    const snn = this.snn;
    snn.fill(0, 0, nf);
    for (let c = 0; c < hc; c++) {
      const a = hashFirst[c]; const b = hashFirst[c + 1];
      if (a === b) continue;
      const e1 = hashFirst[c + 2 < hc ? c + 2 : hc];
      let lo = 0; let hi = 0;
      if (c < lastRow) { const d = c + HX; lo = hashFirst[d - 1]; hi = hashFirst[d + 2 < hc ? d + 2 : hc]; }
      for (let k = a; k < b; k++) {
        for (let pass = 0; pass < 2; pass++) {
          const m0 = pass ? lo : k + 1; const m1 = pass ? hi : e1;
          for (let m = m0; m < m1; m++) {
            const dx = sx[m] - sx[k]; const dy = sy[m] - sy[k];
            const md = 1.1 * (sr[k] + sr[m]);
            if (dx * dx + dy * dy >= md * md) continue;
            if (snn[k] < 255) snn[k]++;
            if (snn[m] < 255) snn[m]++;
            const ex = (svx[m] - svx[k]) * mu * 0.5; const ey = (svy[m] - svy[k]) * mu * 0.5;
            svx[k] += ex; svy[k] += ey; svx[m] -= ex; svy[m] -= ey;
          }
        }
      }
    }
    // Back to particle order: the position is the corrected one; the XSPH change goes into the
    // position too, so the velocity pass after the walls picks it up.
    for (let k = 0; k < nf; k++) {
      const i = ids[k];
      const vxc = fvx[i] + (sx[k] - fx[i]) * idt; const vyc = fvy[i] + (sy[k] - fy[i]) * idt;
      this.fnn[i] = snn[k];
      fx[i] = sx[k] + (svx[k] - vxc) * dt;
      fy[i] = sy[k] + (svy[k] - vyc) * dt;
    }
    void ox; void oy;
  }

  // Sorted particle k against sorted particles m0..m1-1: push apart where they overlap; where
  // they are near but apart and coh > 0, draw them together a little (the films between
  // bubbles), which closes the voids a shake leaves in the head and rounds off spikes and flecks.
  // Of a pair stacked along gravity (gnx, gny: in-plane g over 1 g) the upper one moves: the
  // lower one carries it. Shared equally, a tall head sinks into itself and into the beer (the
  // push-apart is too soft to carry a deep stack in a few iterations); biased, the support
  // reaches the top.
  _relax(k, m0, m1, coh, gnx, gny) {
    const { sx, sy, sr } = this;
    const bias = this.cfg.stackBias;
    const reach = this.hs; // cohesion reaches at most one hash cell
    let x = sx[k]; let y = sy[k];
    const rk = sr[k];
    for (let m = m0; m < m1; m++) {
      let dx = sx[m] - x;
      const md = rk + sr[m];
      let mc = coh > 0 ? 1.35 * md : md;
      if (mc > reach) mc = reach;
      if (dx >= mc || dx <= -mc) continue;
      let dy = sy[m] - y;
      if (dy >= mc || dy <= -mc) continue;
      let d2 = dx * dx + dy * dy;
      if (d2 >= mc * mc) continue;
      if (d2 >= md * md) {
        const d = Math.sqrt(d2);
        const f = (0.5 * coh * (d - md)) / d;
        dx *= f; dy *= f;
        x += dx; y += dy; sx[m] -= dx; sy[m] -= dy;
        continue;
      }
      if (d2 < 1e-8) { dx = ((k * 7919) % 13) - 6.5; dy = ((m * 104729) % 11) - 5.5; d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2);
      const f = (md - d) / d;
      let t = (dx * gnx + dy * gny) / d; // +1: m is right below k (at 1 g in the plane)
      if (t > 1) t = 1; else if (t < -1) t = -1;
      const wk = 0.5 + bias * t;
      dx *= f; dy *= f;
      x -= dx * wk; y -= dy * wk; sx[m] += dx * (1 - wk); sy[m] += dy * (1 - wk);
    }
    sx[k] = x; sy[k] = y;
  }

  _bubbles(dt, upx, upy, inPlane) {
    const cfg = this.cfg;
    const P = this.pxPerM;
    const { bx, by, bage, br, bph, W, H } = this;
    const fizz = 0.4 + 0.6 * this.co2;
    // Births: the nucleation sites (only where they are under the liquid), and the bulk.
    const sites = cfg.sites;
    for (let s = 0; s < sites.length; s++) {
      const [sxf, syf, rate] = sites[s];
      const x = sxf * W; const y = syf * H;
      if (this.phi(x, y) < 0.7) { this.siteAcc[s] = 0; continue; }
      this.siteAcc[s] += rate * fizz * dt;
      while (this.siteAcc[s] >= 1) {
        this.siteAcc[s] -= 1;
        this._addBubble(x + (this.rnd() - 0.5) * 1.5, y + (this.rnd() - 0.5) * 1.5, 0.8);
      }
    }
    this.bulkAcc += (cfg.bulkRate * fizz + cfg.shakeBubbles * this.agit * this.co2) * dt;
    const sim = this.sim;
    while (this.bulkAcc >= 1) {
      this.bulkAcc -= 1;
      const p = this._pickLiquid(1.5, 1e9);
      if (p >= 0) this._addBubble(sim.px[p], sim.py[p], 0.8 + 0.6 * this.agit * this.rnd());
    }
    // Motion: with the liquid, plus a rise that grows as the bubble does.
    const v0 = cfg.riseV0 * P; const va = cfg.riseAcc * P; const vm = cfg.riseMax * P;
    // On a flat phone a bubble rises toward the glass the viewer looks through, across the thin
    // layer of beer, and is gone in a moment; tracked for the full life, the bubbles from a site
    // would pile up into a string where they started.
    const life = cfg.bubbleFlatLife + (cfg.bubbleLife - cfg.bubbleFlatLife) * inPlane;
    this.bubbleLifeNow = life;
    let arrived = 0;
    for (let i = this.nb - 1; i >= 0; i--) {
      const a = (bage[i] += dt);
      let x = bx[i]; let y = by[i];
      const ph = this.phi(x, y);
      if (ph < 0.4 || a > life) {
        if (ph < 0.4 && a > 0.05) { arrived++; this._feed(x, y); }
        this._removeBubble(i);
        continue;
      }
      let rise = v0 + va * a; if (rise > vm) rise = vm;
      rise *= inPlane;
      let vx = 0; let vy = 0;
      if (this.velAt(x, y)) { vx = this.vx; vy = this.vy; }
      const wob = 0.15 * rise * Math.sin(bph[i] + a * 9);
      x += (vx + upx * rise - upy * wob) * dt;
      y += (vy + upy * rise + upx * wob) * dt;
      bx[i] = x < 1 ? 1 : x > W - 1 ? W - 1 : x;
      by[i] = y < 1 ? 1 : y > H - 1 ? H - 1 : y;
      br[i] += cfg.bubbleGrow * dt * (0.6 + 0.4 * inPlane);
    }
    this.arrived += arrived;
    this.arrivals += (arrived / dt - this.arrivals) * (1 - Math.exp(-dt / 0.3));
  }

  _addBubble(x, y, size) {
    if (this.nb >= this.maxBubbles) return;
    const i = this.nb++;
    const [r0, r1] = this.cfg.bubbleR;
    this.bx[i] = x; this.by[i] = y; this.bage[i] = 0;
    this.br[i] = (r0 + (r1 - r0) * this.rnd()) * size;
    this.bph[i] = this.rnd() * 6.283;
  }

  _removeBubble(i) {
    const k = --this.nb;
    if (i === k) return;
    this.bx[i] = this.bx[k]; this.by[i] = this.by[k]; this.bage[i] = this.bage[k];
    this.br[i] = this.br[k]; this.bph[i] = this.bph[k];
  }

  // A bubble reached the surface: now and then that adds a fine foam particle to the head there.
  _feed(x, y) {
    this.credit += this.cfg.bubbleFoam / (HEX * this.rf * this.rf);
    if (this.credit < 1) return;
    this.credit -= 1;
    this._add(x, y, this.rf * (0.9 + 0.15 * this.rnd()), 0, this._fineLife(), 0);
  }

  // Lacing: deposit where foam stands, slide down along gravity, fade, wash off under liquid.
  _lacing(dt, gnx, gny) {
    const cfg = this.cfg;
    const { lw, lh, W, H } = this;
    let L = this.lace; let T = this.laceTmp;
    const cw = W / lw; const ch = H / lh;
    // slide: sample upstream, in cells
    const sx = (gnx * cfg.laceSlide * dt) / cw; const sy = (gny * cfg.laceSlide * dt) / ch;
    const keep = Math.exp(-dt / cfg.laceLife);
    const wash = Math.exp(-dt / cfg.laceWash);
    for (let j = 0; j < lh; j++) {
      let y = j - sy; if (y < 0) y = 0; else if (y > lh - 1.001) y = lh - 1.001;
      const j0 = y | 0; const ty = y - j0;
      for (let i = 0; i < lw; i++) {
        let x = i - sx; if (x < 0) x = 0; else if (x > lw - 1.001) x = lw - 1.001;
        const i0 = x | 0; const tx = x - i0;
        const b = i0 + j0 * lw;
        T[i + j * lw] = ((1 - tx) * (1 - ty) * L[b] + tx * (1 - ty) * L[b + 1]
          + tx * ty * L[b + lw + 1] + (1 - tx) * ty * L[b + lw]) * keep;
      }
    }
    this.lace = T; this.laceTmp = L; L = T;
    // wash under the liquid (lace cells are a quarter of a sim cell: that cell's density)
    const { density, NX } = this.sim;
    const thr = 0.55 * this.sim.rest;
    for (let j = 0; j < lh; j++) {
      const row = ((j >> 1) + 1) * NX + 1;
      for (let i = 0; i < lw; i++) {
        const c = i + j * lw;
        if (L[c] > 0.004 && density[row + (i >> 1)] > thr) L[c] *= wash;
      }
    }
    const dep = cfg.laceDeposit * dt;
    const max = cfg.laceMax;
    for (let i = 0; i < this.nf; i++) {
      if (this.fnn[i] < 3) continue; // the body of the head, not flecks flung about
      let ci = (this.fx[i] / cw) | 0; let cj = (this.fy[i] / ch) | 0;
      if (ci >= lw) ci = lw - 1; if (cj >= lh) cj = lh - 1;
      const c = ci + cj * lw;
      const v = L[c] + dep * (this.fr[i] / this.rf);
      L[c] = v > max ? max : v;
    }
    const L8 = this.lace8;
    for (let c = 0; c < lw * lh; c++) L8[c] = (L[c] * 255) | 0;
  }

  // Head thickness: the foam's area (hexagonal packing) over the length of a level surface
  // across the box, perpendicular to in-plane gravity (W upright, H on its side).
  headPx(gx, gy) {
    let a = 0;
    for (let i = 0; i < this.nf; i++) a += this.fr[i] * this.fr[i];
    a *= HEX;
    const gl = Math.hypot(gx, gy) || 1;
    const c = Math.abs(gy / gl); const s = Math.abs(gx / gl);
    const across = Math.min(c > 1e-3 ? this.W / c : Infinity, s > 1e-3 ? this.H / s : Infinity);
    return a / across;
  }
}
