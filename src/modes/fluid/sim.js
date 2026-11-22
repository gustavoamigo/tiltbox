// 2D FLIP/PIC liquid on a staggered (MAC) grid.
//
// The scheme is the one Matthias Müller teaches in Ten Minute Physics ("FLIP fluid"): particles
// carry the liquid. Each substep they are moved, pushed apart so they do not clump, and their
// velocities splatted onto a staggered grid; the grid is made divergence-free with over-relaxed
// Gauss-Seidel, and the change is read back to the particles as a PIC/FLIP blend. A density term
// in the pressure solve expands over-full cells, which keeps the volume over long runs.
// Viscous liquids (honey) add implicit viscosity on the grid, gripped by the walls, solved with
// over-relaxed Gauss-Seidel too.
//
// Units: positions in sim px (the box is [0, W] x [0, H], y down), velocities px/s,
// accelerations px/s². The grid has a ring of solid ghost cells just outside the box, so the
// walls are exactly the box edges. Cells are hx x hy, nearly square (whole cells fit each side).
// Every array is allocated when the box changes size: a substep allocates nothing.

export const FLUID = 0;
export const AIR = 1;
export const SOLID = 2;

const SQRT3 = Math.sqrt(3);

// How much of a speed into a wall (before, after; positive = into it) was stopped.
function stopped(before, after) {
  if (before <= 0) return 0;
  const d = before - (after > 0 ? after : 0);
  return d > 0 ? d : 0;
}

export class FlipSim {
  // count: particles; cells: target number of grid cells in the box; fill: area fraction the
  // liquid covers at rest density (sets the particle radius and the rest density).
  constructor({ count, cells, fill }) {
    this.n = count;
    this.cellsTarget = cells;
    this.fill = fill;
    const n = count;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.pvx = new Float32Array(n); // velocity at the start of the frame (foam, impacts)
    this.pvy = new Float32Array(n);
    this.foam = new Float32Array(n); // 0..1 whitewater, decays
    this.air = new Float32Array(n); // seconds spent as a lone droplet
    this.dens = new Float32Array(n); // density ratio around the particle, last frame
    // Interpolation cached between P2G and G2P (particles do not move in between).
    this.ub = new Int32Array(n); this.utx = new Float32Array(n); this.uty = new Float32Array(n);
    this.vb = new Int32Array(n); this.vtx = new Float32Array(n); this.vty = new Float32Array(n);
    this.cb = new Int32Array(n); this.ctx = new Float32Array(n); this.cty = new Float32Array(n);
    this.hashOf = new Int32Array(n);
    this.hashIds = new Int32Array(n);
    this.sx = new Float32Array(n); // positions in hash-cell order, during the push-apart
    this.sy = new Float32Array(n);

    this.W = 0;
    this.H = 0;
    this.params = {
      flipRatio: 0.9,
      pressureIters: 30,
      omega: 1.9, // SOR on the pressure; 2 diverges
      drift: 12, // 1/s: how fast a cell's density error is undone (12: a fifth per 60 Hz frame)
      pushIters: 2,
      visc: 0, // implicit viscosity, nu * dt / h² per second of dt (scaled by the substep)
      viscIters: 0,
      viscOmega: 1.6,
      viscRounds: 1, // viscosity-then-pressure rounds per substep
      wallSlip: 1, // 1: free-slip walls; 0: no-slip (see _wallSlip)
      vmax: 1e4, // px/s cap: a guard, never reached in normal play
    };
    this.obstacles = []; // [{x, y, r, vx, vy, foam}] in sim px, px/s; foam it leaves 0..1
    this.slam = 0; // wall impact this frame: speed into the walls stopped near them, px/s per particle
    this.impacts = { n: 0, max: 0 }; // droplet landings this frame, speed in px/s
    this.meanSpeed = 0; // px/s, from the last endFrame()
    this.rmsSpeed = 0;
    this.maxSpeed = 0;
    this.prof = null; // set to {} to accumulate per-stage ms (tests)
  }

  // The box changed size (or first call). Particles are rescaled into the new box; the grid is
  // rebuilt so its cell count stays near the target whatever the aspect.
  setBox(W, H) {
    if (this.W > 0 && (W !== this.W || H !== this.H)) {
      const sx = W / this.W;
      const sy = H / this.H;
      for (let i = 0; i < this.n; i++) {
        this.px[i] *= sx; this.py[i] *= sy;
        this.vx[i] *= sx; this.vy[i] *= sy;
      }
    }
    this.W = W;
    this.H = H;
    this._buildGrid();
    this._clampAll();
  }

  _buildGrid() {
    const { W, H } = this;
    const h = Math.sqrt((W * H) / this.cellsTarget);
    const nx = Math.max(6, Math.round(W / h));
    const ny = Math.max(6, Math.round(H / h));
    this.nx = nx; this.ny = ny;
    const NX = nx + 2;
    const NY = ny + 2;
    this.NX = NX; this.NY = NY;
    this.hx = W / nx; this.hy = H / ny;
    const cells = NX * NY;
    if (!this.u || this.u.length !== cells) {
      this.u = new Float32Array(cells); this.v = new Float32Array(cells);
      this.u0 = new Float32Array(cells); this.v0 = new Float32Array(cells);
      this.uw = new Float32Array(cells); this.vw = new Float32Array(cells);
      this.uValid = new Float32Array(cells); this.vValid = new Float32Array(cells);
      this.uClass = new Uint8Array(cells); this.vClass = new Uint8Array(cells);
      this.s = new Float32Array(cells); // 1 open, 0 solid
      this.solidVx = new Float32Array(cells); this.solidVy = new Float32Array(cells);
      this.type = new Uint8Array(cells);
      this.density = new Float32Array(cells);
      this.coef = new Float32Array(cells * 6);
      this.redBlack = new Int32Array(cells);
      this.pres = new Float32Array(cells); // last substep's pressure (as face-velocity impulse)
      this.presNew = new Float32Array(cells);
      this.dist = new Float32Array(cells);
    }
    this.depth8 = new Uint8Array(nx * ny); // distance to air, for the renderer
    this.pres.fill(0);
    this.presDt = 0;
    this.nFluid = 0;
    // Particle radius: a hexagonal packing of spacing 2r covers fill * W * H with n particles.
    this.r = Math.sqrt((this.fill * W * H) / (2 * SQRT3 * this.n));
    // Rest density in particles per cell (bilinear splat at cell centres).
    this.rest = this.n / (this.fill * nx * ny);
    // Spatial hash for the push-apart: cells one particle diameter wide.
    this.hs = 2 * this.r;
    this.hashNX = Math.ceil(W / this.hs) + 1;
    this.hashNY = Math.ceil(H / this.hs) + 1;
    const hc = this.hashNX * this.hashNY;
    if (!this.hashFirst || this.hashFirst.length !== hc + 1) {
      this.hashFirst = new Int32Array(hc + 1);
      this.hashCount = new Int32Array(hc);
    }
    this._hadObstacles = true;
    this._resetSolids();
  }

  _resetSolids() {
    const { NX, NY, s } = this;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        s[i + j * NX] = i === 0 || j === 0 || i === NX - 1 || j === NY - 1 ? 0 : 1;
      }
    }
    this.solidVx.fill(0);
    this.solidVy.fill(0);
  }

  _clampAll() {
    const r = this.r;
    const { n, px, py, vx, vy } = this;
    for (let i = 0; i < n; i++) {
      // non-finite state cannot be repaired in place; put it back in the box at rest
      if (!Number.isFinite(px[i]) || !Number.isFinite(py[i])) { px[i] = this.W / 2; py[i] = this.H / 2; }
      if (!Number.isFinite(vx[i]) || !Number.isFinite(vy[i])) { vx[i] = 0; vy[i] = 0; }
      px[i] = Math.min(Math.max(px[i], r), this.W - r);
      py[i] = Math.min(Math.max(py[i], r), this.H - r);
    }
  }

  // Put every particle on a hexagonal lattice over the box, keeping the n lattice points with
  // the lowest level(x / W, y / H): any shape whose level sets grow outward comes out at exactly
  // the liquid's area. vel(x / W, y / H) -> [vx, vy] in px/s gives the start a push (optional).
  // Allocates; for resets only.
  seed(level, vel = null, jitter = 0.08) {
    const { n, r, W, H } = this;
    const dx = 2 * r;
    const dy = SQRT3 * r;
    const xs = []; const ys = []; const ls = [];
    let rand = 12345;
    const rnd = () => { rand = (rand * 1103515245 + 12345) & 0x7fffffff; return rand / 0x7fffffff - 0.5; };
    for (let row = 0; ; row++) {
      const y = r + row * dy;
      if (y > H - r) break;
      for (let x = r + (row % 2 ? r : 0); x <= W - r; x += dx) {
        xs.push(x + rnd() * jitter * r); ys.push(y + rnd() * jitter * r); ls.push(level(x / W, y / H));
      }
    }
    const order = Array.from(ls.keys()).sort((a, b) => ls[a] - ls[b]);
    for (let i = 0; i < n; i++) {
      const k = order[i % order.length];
      // more particles than lattice points cannot happen at fill < 0.9; spread any wrap-around
      this.px[i] = xs[k] + (i >= order.length ? rnd() * r : 0);
      this.py[i] = ys[k];
      const v = vel ? vel(xs[k] / W, ys[k] / H) : null;
      this.vx[i] = v ? v[0] : 0;
      this.vy[i] = v ? v[1] : 0;
    }
    this.pvx.set(this.vx); this.pvy.set(this.vy);
    this.foam.fill(0); this.air.fill(0); this.dens.fill(1);
    this._clampAll();
  }

  // Remember the velocities at the start of a frame (for foam and impacts in endFrame()).
  beginFrame() {
    this.pvx.set(this.vx);
    this.pvy.set(this.vy);
    this.impacts.n = 0;
    this.impacts.max = 0;
  }

  // One substep. g: px/s²; damp: 1/s linear drag (glass friction).
  // Order: particles move with the last projected velocity, are pushed apart and kept in the
  // box; their velocities go to the grid, gravity is added there and the grid is projected;
  // the change comes back to the particles. Gravity added before the projection never moves a
  // particle that the floor holds up: added to the particles before they move (the other usual
  // order), a supported pool sinks g·dt² every substep, which at this box's scale is most of a
  // cell per frame, and the density term has to prop it back up with visible jitter.
  substep(dt, gx, gy, damp) {
    const P = this.params;
    const prof = this.prof;
    let t = prof ? performance.now() : 0;
    const lap = prof ? (k) => { const t1 = performance.now(); prof[k] = (prof[k] || 0) + t1 - t; t = t1; } : null;
    this._advect(dt, damp);
    if (prof) lap('advect');
    if (P.pushIters > 0) this._pushApart(P.pushIters);
    if (prof) lap('push');
    this._collide();
    this._markSolids();
    if (prof) lap('collide');
    this._p2g();
    if (prof) lap('p2g');
    const visc = P.visc > 0 && P.viscIters > 0;
    // Viscosity acts on the liquid's own motion before gravity is added: gravity's uniform
    // increment has no shear, and diffused against no-slip walls it would let the walls hold
    // the liquid up by friction, which the pressure then turns into a creep up the walls.
    if (visc) {
      this._wallSlip(P.wallSlip);
      this._viscosity(P.visc * dt, P.viscIters, P.viscOmega);
    }
    if (prof) lap('visc');
    this._addGravity(dt, gx, gy);
    this._prepPressure(dt);
    this._solvePressure(P.pressureIters);
    if (prof) lap('pressure');
    // Split once, the projection turns a falling blob's momentum into a sideways spread in one
    // substep before viscosity can resist the shear; a few more viscosity-then-pressure rounds
    // approach the coupled solve, and the blob lands like honey instead of splashing flat.
    for (let r = 1; visc && r < P.viscRounds; r++) {
      this._wallSlip(P.wallSlip);
      this._viscosity(P.visc * dt, P.viscIters, P.viscOmega);
      if (prof) lap('visc');
      this._solvePressure(P.pressureIters >> 1); // a correction: the first solve did the bulk
      if (prof) lap('pressure');
    }
    this._wallSlip(P.wallSlip);
    // The FLIP share is per 1/60 s: a longer substep keeps less of the particles' own noise, so
    // a phone running at 30 fps settles as calmly as one at 60.
    this._g2p(dt > 1 / 60 ? P.flipRatio ** (dt * 60) : P.flipRatio);
    if (prof) lap('g2p');
  }

  _advect(dt, damp) {
    const { n, px, py, vx, vy } = this;
    const k = Math.exp(-damp * dt);
    const vmax = this.params.vmax;
    const vmax2 = vmax * vmax;
    for (let i = 0; i < n; i++) {
      let x = vx[i] * k;
      let y = vy[i] * k;
      const s2 = x * x + y * y;
      if (!(s2 <= vmax2)) { // too fast, or NaN
        const f = s2 > 0 && Number.isFinite(s2) ? vmax / Math.sqrt(s2) : 0;
        x = Number.isFinite(x) ? x * f : 0;
        y = Number.isFinite(y) ? y * f : 0;
      }
      vx[i] = x; vy[i] = y;
      px[i] += x * dt;
      py[i] += y * dt;
    }
  }

  // A faint long wave of velocity along (dx, dy) (unit), varying across it: amp px/s, k rad/px.
  // Smooth PIC flow carries no noise of its own, so a layer hanging from the ceiling wall to
  // wall is a perfect balance and never starts to drip; real honey always has some unevenness
  // to grow from. Where the liquid is stable, gravity flattens the wave at once.
  nudge(dx, dy, amp, k, phase) {
    const { n, px, py, vx, vy } = this;
    for (let i = 0; i < n; i++) {
      const w = amp * Math.sin((px[i] * -dy + py[i] * dx) * k + phase);
      vx[i] += w * dx;
      vy[i] += w * dy;
    }
  }

  // Particles closer than a diameter are pushed apart by half the overlap each. Positions are
  // counting-sorted into hash cells one diameter wide and copied into contiguous arrays. Each
  // cell then checks two contiguous ranges: the rest of itself plus its right neighbour, and
  // the three cells below; every pair is seen once. At a row's end those ranges reach cells on
  // the far side of the box, which the distance test rejects.
  _pushApart(iters) {
    const { n, px, py, hashOf, hashIds, hashFirst, hashCount, sx, sy } = this;
    const HX = this.hashNX;
    const HY = this.hashNY;
    const inv = 1 / this.hs;
    const minD = 2 * this.r;
    const minD2 = minD * minD;
    const hc = HX * HY;
    hashCount.fill(0);
    for (let i = 0; i < n; i++) {
      let cx = (px[i] * inv) | 0; let cy = (py[i] * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= HX) cx = HX - 1;
      if (cy < 0) cy = 0; else if (cy >= HY) cy = HY - 1;
      const c = cx + cy * HX;
      hashOf[i] = c;
      hashCount[c]++;
    }
    let acc = 0;
    for (let c = 0; c < hc; c++) { hashFirst[c] = acc; acc += hashCount[c]; hashCount[c] = hashFirst[c]; }
    hashFirst[hc] = acc;
    for (let i = 0; i < n; i++) {
      const k = hashCount[hashOf[i]]++;
      hashIds[k] = i; sx[k] = px[i]; sy[k] = py[i];
    }
    const lastRow = (HY - 1) * HX;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < hc; c++) {
        const a = hashFirst[c];
        const b = hashFirst[c + 1];
        if (a === b) continue;
        const e1 = hashFirst[c + 2 < hc ? c + 2 : hc];
        let lo = 0; let hi = 0;
        if (c < lastRow) {
          const d = c + HX;
          lo = hashFirst[d - 1];
          hi = hashFirst[d + 2 < hc ? d + 2 : hc];
        }
        for (let k = a; k < b; k++) {
          let x = sx[k];
          let y = sy[k];
          for (let m = k + 1; m < e1; m++) {
            let dx = sx[m] - x;
            if (dx >= minD || dx <= -minD) continue;
            let dy = sy[m] - y;
            let d2 = dx * dx + dy * dy;
            if (d2 >= minD2) continue;
            if (d2 < 1e-10) { dx = ((k * 7919) % 13) - 6.5; dy = ((m * 104729) % 11) - 5.5; d2 = dx * dx + dy * dy; }
            const d = Math.sqrt(d2);
            const f = (0.5 * (minD - d)) / d;
            dx *= f; dy *= f;
            x -= dx; y -= dy;
            sx[m] += dx; sy[m] += dy;
          }
          for (let m = lo; m < hi; m++) {
            let dy = sy[m] - y;
            if (dy >= minD || dy <= -minD) continue;
            let dx = sx[m] - x;
            let d2 = dx * dx + dy * dy;
            if (d2 >= minD2) continue;
            if (d2 < 1e-10) { dx = ((k * 7919) % 13) - 6.5; dy = ((m * 104729) % 11) - 5.5; d2 = dx * dx + dy * dy; }
            const d = Math.sqrt(d2);
            const f = (0.5 * (minD - d)) / d;
            dx *= f; dy *= f;
            x -= dx; y -= dy;
            sx[m] += dx; sy[m] += dy;
          }
          sx[k] = x; sy[k] = y;
        }
      }
    }
    for (let k = 0; k < n; k++) { const i = hashIds[k]; px[i] = sx[k]; py[i] = sy[k]; }
  }

  // Walls and finger obstacles. Positions end inside [r, W - r] x [r, H - r] whatever happened.
  _collide() {
    const { n, px, py, vx, vy, foam, r, obstacles } = this;
    const minX = r; const maxX = this.W - r;
    const minY = r; const maxY = this.H - r;
    const no = obstacles.length;
    for (let i = 0; i < n; i++) {
      let x = px[i];
      let y = py[i];
      for (let k = 0; k < no; k++) {
        const o = obstacles[k];
        const dx = x - o.x;
        const dy = y - o.y;
        const R = o.r + r;
        const d2 = dx * dx + dy * dy;
        if (d2 < R * R) {
          const d = Math.sqrt(d2);
          if (d > 1e-6) { x = o.x + (dx / d) * R; y = o.y + (dy / d) * R; } else { x = o.x + R; }
          vx[i] = o.vx; vy[i] = o.vy;
          if (foam[i] < o.foam) foam[i] = o.foam; // a fast finger drags air in behind it
        }
      }
      // A wall stops the motion into it (the grip along it is on the grid: _wallSlip).
      if (!(x >= minX)) { x = minX; if (vx[i] < 0) vx[i] = 0; }
      if (!(x <= maxX)) { x = maxX; if (vx[i] > 0) vx[i] = 0; }
      if (!(y >= minY)) { y = minY; if (vy[i] < 0) vy[i] = 0; }
      if (!(y <= maxY)) { y = maxY; if (vy[i] > 0) vy[i] = 0; }
      px[i] = x; py[i] = y;
    }
  }

  // Cells whose centre lies inside a finger become solid, moving with it.
  _markSolids() {
    const { NX, NY, s, solidVx, solidVy, hx, hy } = this;
    if (this._hadObstacles) this._resetSolids();
    this._hadObstacles = this.obstacles.length > 0;
    for (const o of this.obstacles) {
      const i0 = Math.max(1, Math.floor((o.x - o.r) / hx) + 1);
      const i1 = Math.min(NX - 2, Math.ceil((o.x + o.r) / hx) + 1);
      const j0 = Math.max(1, Math.floor((o.y - o.r) / hy) + 1);
      const j1 = Math.min(NY - 2, Math.ceil((o.y + o.r) / hy) + 1);
      const r2 = o.r * o.r;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = (i - 0.5) * hx - o.x;
          const cy = (j - 0.5) * hy - o.y;
          if (cx * cx + cy * cy < r2) {
            const c = i + j * NX;
            s[c] = 0; solidVx[c] = o.vx; solidVy[c] = o.vy;
          }
        }
      }
    }
  }

  // Particles to grid: face velocities, cell types, particle density at cell centres.
  _p2g() {
    const { n, px, py, vx, vy, NX, NY, u, v, uw, vw, u0, v0, s, type, density } = this;
    const { ub, utx, uty, vb, vtx, vty, cb, ctx, cty, solidVx, solidVy } = this;
    const ihx = 1 / this.hx;
    const ihy = 1 / this.hy;
    const cells = NX * NY;
    u.fill(0); v.fill(0); uw.fill(0); vw.fill(0); density.fill(0);
    for (let c = 0; c < cells; c++) type[c] = s[c] === 0 ? SOLID : AIR;
    const xMax = NX - 1.001;
    const yMax = NY - 1.001;
    for (let i = 0; i < n; i++) {
      let gxp = px[i] * ihx + 1;
      let gyp = py[i] * ihy + 1;
      if (gxp < 1) gxp = 1; else if (gxp > xMax) gxp = xMax;
      if (gyp < 1) gyp = 1; else if (gyp > yMax) gyp = yMax;
      const ci = (gxp | 0) + (gyp | 0) * NX;
      if (type[ci] === AIR) type[ci] = FLUID;

      // u lives at (i, j + 0.5)
      let x = gxp; let y = gyp - 0.5;
      let x0 = x | 0; let y0 = y | 0;
      let tx = x - x0; let ty = y - y0;
      let b = x0 + y0 * NX;
      ub[i] = b; utx[i] = tx; uty[i] = ty;
      let w00 = (1 - tx) * (1 - ty); let w10 = tx * (1 - ty); let w11 = tx * ty; let w01 = (1 - tx) * ty;
      const qx = vx[i];
      u[b] += w00 * qx; uw[b] += w00;
      u[b + 1] += w10 * qx; uw[b + 1] += w10;
      u[b + NX + 1] += w11 * qx; uw[b + NX + 1] += w11;
      u[b + NX] += w01 * qx; uw[b + NX] += w01;

      // v lives at (i + 0.5, j)
      x = gxp - 0.5; y = gyp;
      x0 = x | 0; y0 = y | 0;
      tx = x - x0; ty = y - y0;
      b = x0 + y0 * NX;
      vb[i] = b; vtx[i] = tx; vty[i] = ty;
      w00 = (1 - tx) * (1 - ty); w10 = tx * (1 - ty); w11 = tx * ty; w01 = (1 - tx) * ty;
      const qy = vy[i];
      v[b] += w00 * qy; vw[b] += w00;
      v[b + 1] += w10 * qy; vw[b + 1] += w10;
      v[b + NX + 1] += w11 * qy; vw[b + NX + 1] += w11;
      v[b + NX] += w01 * qy; vw[b + NX] += w01;

      // density lives at cell centres (i + 0.5, j + 0.5)
      x = gxp - 0.5; y = gyp - 0.5;
      x0 = x | 0; y0 = y | 0;
      tx = x - x0; ty = y - y0;
      b = x0 + y0 * NX;
      cb[i] = b; ctx[i] = tx; cty[i] = ty;
      density[b] += (1 - tx) * (1 - ty);
      density[b + 1] += tx * (1 - ty);
      density[b + NX + 1] += tx * ty;
      density[b + NX] += (1 - tx) * ty;
    }
    for (let c = 0; c < cells; c++) {
      if (uw[c] > 0) u[c] /= uw[c];
      if (vw[c] > 0) v[c] /= vw[c];
    }
    // Density splatted past a wall into the ghost ring belongs to the cell inside: folded back,
    // a cell against the glass reads as full as one in the middle. Without it the density term
    // sees the middle as over-full and pushes the liquid out to the walls, where it climbs.
    for (let i = 0; i < NX; i++) {
      density[i + NX] += density[i]; density[i] = 0;
      const b = i + (NY - 1) * NX;
      density[b - NX] += density[b]; density[b] = 0;
    }
    for (let j = 1; j < NY - 1; j++) {
      const l = j * NX; const r = l + NX - 1;
      density[l + 1] += density[l]; density[l] = 0;
      density[r - 1] += density[r]; density[r] = 0;
    }

    // Faces touching a solid cell take the solid's velocity (0 for the walls).
    const { uClass, vClass, uValid, vValid } = this;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const c = i + j * NX;
        const tc = type[c];
        // u face between (i-1, j) and (i, j)
        if (i > 0) {
          const tl = type[c - 1];
          if (tl === SOLID || tc === SOLID) {
            u[c] = tl === SOLID && tc === SOLID ? 0.5 * (solidVx[c - 1] + solidVx[c]) : tl === SOLID ? solidVx[c - 1] : solidVx[c];
            uClass[c] = 2;
          } else uClass[c] = tl === FLUID || tc === FLUID ? 1 : 0;
          uValid[c] = tl !== AIR || tc !== AIR ? 1 : 0;
        } else { u[c] = 0; uClass[c] = 2; uValid[c] = 0; }
        // v face between (i, j-1) and (i, j)
        if (j > 0) {
          const tt = type[c - NX];
          if (tt === SOLID || tc === SOLID) {
            v[c] = tt === SOLID && tc === SOLID ? 0.5 * (solidVy[c - NX] + solidVy[c]) : tt === SOLID ? solidVy[c - NX] : solidVy[c];
            vClass[c] = 2;
          } else vClass[c] = tt === FLUID || tc === FLUID ? 1 : 0;
          vValid[c] = tt !== AIR || tc !== AIR ? 1 : 0;
        } else { v[c] = 0; vClass[c] = 2; vValid[c] = 0; }
      }
    }
    // The particles' own velocities, for the FLIP update; the wall faces as the walls see them,
    // so a free-slip wall adds no FLIP change of its own.
    u0.set(u);
    v0.set(v);
    this._wallSlip(this.params.wallSlip, u0, v0);
  }

  // The walls' grip on the liquid sliding along them. The faces in the ghost ring that run
  // along a wall take slip times the velocity just inside: 1 is a free-slip wall, 0 no-slip.
  // These faces are what viscosity and the particles near a wall see as the wall's velocity.
  _wallSlip(slip, u = this.u, v = this.v) {
    const { NX, NY } = this;
    for (let j = 0; j < NY; j++) {
      const l = j * NX;
      v[l] = slip * v[l + 1];
      v[l + NX - 1] = slip * v[l + NX - 2];
    }
    const b = (NY - 1) * NX;
    for (let i = 0; i < NX; i++) {
      u[i] = slip * u[i + NX];
      u[b + i] = slip * u[b + i - NX];
    }
  }

  // Gravity on every open face.
  _addGravity(dt, gx, gy) {
    const { u, v, uClass, vClass } = this;
    const cells = this.NX * this.NY;
    const ax = gx * dt;
    const ay = gy * dt;
    for (let c = 0; c < cells; c++) {
      if (uClass[c] !== 2) u[c] += ax;
      if (vClass[c] !== 2) v[c] += ay;
    }
  }

  // Implicit viscosity, (1 + a·L) f = f0 per velocity component, by over-relaxed Gauss-Seidel.
  // Liquid faces only; solid neighbours contribute their velocity (no-slip), air neighbours
  // nothing (free surface). The previous substep's velocities are the warm start, so a few
  // sweeps a substep add up to a stiff, honey-like flow over a fraction of a second.
  _viscosity(a, iters, omega) {
    const { u, v, uw, vw, uClass, vClass } = this;
    // right-hand side: the velocities as they come in (the P2G weights are no longer needed)
    uw.set(u);
    vw.set(v);
    for (let it = 0; it < iters; it++) {
      this._viscSweep(u, uw, uClass, a, omega);
      this._viscSweep(v, vw, vClass, a, omega);
    }
  }

  _viscSweep(f, f0, cls, a, omega) {
    const { NX, NY } = this;
    for (let j = 1; j < NY - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const c = i + j * NX;
        if (cls[c] !== 1) continue;
        let sum = 0; let cnt = 0;
        if (cls[c - 1]) { sum += f[c - 1]; cnt++; }
        if (cls[c + 1]) { sum += f[c + 1]; cnt++; }
        if (cls[c - NX]) { sum += f[c - NX]; cnt++; }
        if (cls[c + NX]) { sum += f[c + NX]; cnt++; }
        const g = (f0[c] + a * sum) / (1 + a * cnt);
        f[c] += omega * (g - f[c]);
      }
    }
  }

  // Red-black Gauss-Seidel with over-relaxation on the liquid cells. Each cell's divergence
  // (minus the expansion or contraction its density asks for) is removed by moving its open faces; air
  // neighbours are p = 0, solid ones do not move. Cells of one colour share no face, so a
  // colour's sweep has no chain of dependent updates and pipelines well. Coefficients are fixed
  // for the substep, so _prepPressure computes them once: [lx, rx, ty, by, -omega / S, target].
  //
  // Warm start: the last substep's pressure is applied first. Most of the pressure holds the
  // liquid up against gravity and is the same every substep; Gauss-Seidel is slowest at exactly
  // that (a smooth field across the whole depth), so without the warm start a deep pool sinks
  // into itself between substeps and only the density term props it back up, as jitter.
  _prepPressure(dt) {
    const { NX, NY, u, v, s, type, density, redBlack, coef, pres, presNew } = this;
    const ihx = 1 / this.hx;
    const ihy = 1 / this.hy;
    const ax = ihx * ihx;
    const ay = ihy * ihy;
    const rest = this.rest;
    // at most a fifth of the error per substep: more overshoots, and a long frame (30 fps) jitters
    const k = Math.min(this.params.drift, 0.2 / dt);
    const omega = this.params.omega;
    const warm = this.presDt > 0 ? dt / this.presDt : 0; // pressure impulses scale with dt
    presNew.fill(0);
    // Red cells fill the list from the front, black from the back; coef rows match list slots.
    let nr = 0;
    let nb = 0;
    const cells = NX * NY;
    for (let j = 1; j < NY - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const c = i + j * NX;
        if (type[c] !== FLUID) continue;
        const sl = s[c - 1]; const sr = s[c + 1];
        const st = s[c - NX]; const sb = s[c + NX];
        const S = (sl + sr) * ax + (st + sb) * ay;
        if (S === 0) continue;
        const slot = (i + j) & 1 ? cells - 1 - nb++ : nr++;
        redBlack[slot] = c;
        const o = slot * 6;
        coef[o] = sl * ihx; coef[o + 1] = sr * ihx; coef[o + 2] = st * ihy; coef[o + 3] = sb * ihy;
        coef[o + 4] = -omega / S;
        // Over-full cells expand. Under-full ones contract only when walled in by liquid or
        // glass on all sides: at the free surface a thin cell is simply partly air. Without the
        // contraction a slow, viscous liquid only ever gains volume.
        let comp = density[c] / rest - 1;
        if (comp < 0) {
          if (type[c - 1] === AIR || type[c + 1] === AIR || type[c - NX] === AIR || type[c + NX] === AIR) comp = 0;
          else if (comp < -0.5) comp = -0.5;
        }
        coef[o + 5] = k * comp;
        const p0 = pres[c] * warm;
        if (p0 !== 0 && p0 === p0) { // (and not NaN: a bad value must not live on here)
          u[c] -= coef[o] * p0;
          u[c + 1] += coef[o + 1] * p0;
          v[c] -= coef[o + 2] * p0;
          v[c + NX] += coef[o + 3] * p0;
          presNew[c] = p0;
        }
      }
    }
    this.nRed = nr;
    this.nBlack = nb;
    this.nFluid = nr + nb;
    this.pres = presNew; // the substep's pressure accumulates here; the old one is spare now
    this.presNew = pres;
    this.presDt = dt;
  }

  _solvePressure(iters) {
    const { NX, NY, u, v, redBlack, coef, pres } = this;
    const ihx = 1 / this.hx;
    const ihy = 1 / this.hy;
    const cells = NX * NY;
    const nr = this.nRed;
    const b0 = cells - this.nBlack;
    for (let it = 0; it < iters; it++) {
      for (let pass = 0; pass < 2; pass++) {
        const q0 = pass === 0 ? 0 : b0;
        const q1 = pass === 0 ? nr : cells;
        for (let q = q0, o = q0 * 6; q < q1; q++, o += 6) {
          const c = redBlack[q];
          const p = ((u[c + 1] - u[c]) * ihx + (v[c + NX] - v[c]) * ihy - coef[o + 5]) * coef[o + 4];
          u[c] -= coef[o] * p;
          u[c + 1] += coef[o + 1] * p;
          v[c] -= coef[o + 2] * p;
          v[c + NX] += coef[o + 3] * p;
          pres[c] += p;
        }
      }
    }
  }

  // Grid to particles: PIC (the new grid velocity) blended with FLIP (the old particle velocity
  // plus the grid's change). Faces between two air cells are not trusted and get no weight.
  _g2p(flipRatio) {
    const { n, vx, vy, NX, u, v, u0, v0, uValid, vValid } = this;
    const { ub, utx, uty, vb, vtx, vty } = this;
    const pr = 1 - flipRatio;
    for (let i = 0; i < n; i++) {
      let b = ub[i]; let tx = utx[i]; let ty = uty[i];
      let w00 = uValid[b] * (1 - tx) * (1 - ty);
      let w10 = uValid[b + 1] * tx * (1 - ty);
      let w11 = uValid[b + NX + 1] * tx * ty;
      let w01 = uValid[b + NX] * (1 - tx) * ty;
      let d = w00 + w10 + w11 + w01;
      if (d > 0) {
        const pic = (w00 * u[b] + w10 * u[b + 1] + w11 * u[b + NX + 1] + w01 * u[b + NX]) / d;
        const corr = (w00 * (u[b] - u0[b]) + w10 * (u[b + 1] - u0[b + 1]) + w11 * (u[b + NX + 1] - u0[b + NX + 1]) + w01 * (u[b + NX] - u0[b + NX])) / d;
        vx[i] = pr * pic + flipRatio * (vx[i] + corr);
      }
      b = vb[i]; tx = vtx[i]; ty = vty[i];
      w00 = vValid[b] * (1 - tx) * (1 - ty);
      w10 = vValid[b + 1] * tx * (1 - ty);
      w11 = vValid[b + NX + 1] * tx * ty;
      w01 = vValid[b + NX] * (1 - tx) * ty;
      d = w00 + w10 + w11 + w01;
      if (d > 0) {
        const pic = (w00 * v[b] + w10 * v[b + 1] + w11 * v[b + NX + 1] + w01 * v[b + NX]) / d;
        const corr = (w00 * (v[b] - v0[b]) + w10 * (v[b + 1] - v0[b + 1]) + w11 * (v[b + NX + 1] - v0[b + NX + 1]) + w01 * (v[b + NX] - v0[b + NX])) / d;
        vy[i] = pr * pic + flipRatio * (vy[i] + corr);
      }
    }
  }

  // Once per frame, after the substeps: per-particle density, flight time and droplet landings,
  // foam, and the distance-to-air field for the renderer.
  //   gx, gy: gravity px/s²; gPx: 9.81 m/s² in px/s²
  //   foamCfg: { lo, hi (non-gravity acceleration in g that starts / saturates foam), gain (per
  //   frame at saturation), tau (s, decay), land (foam a landing droplet makes) }
  endFrame(dt, gx, gy, gPx, foamCfg) {
    const { n, px, py, vx, vy, pvx, pvy, foam, air, dens, density, dist, cb, ctx, cty, NX } = this;
    this._distance();
    const irest = 1 / this.rest;
    const ihx = 1 / this.hx;
    const ihy = 1 / this.hy;
    const imp = this.impacts;
    // Foam near the air lasts; under it, the bubbles rise out and it clears faster.
    const keepTop = Math.exp(-dt / foamCfg.tau);
    const keepDeep = Math.exp(-dt / (0.35 * foamCfg.tau));
    const lo = foamCfg.lo; const span = 1 / (foamCfg.hi - foamCfg.lo);
    const gain = foamCfg.gain;
    const land = foamCfg.land;
    const ia = 1 / (dt * gPx);
    const gdx = gx * dt; const gdy = gy * dt;
    let sum = 0; let sum2 = 0; let max2 = 0;
    // Slam: speed into a wall that was stopped this frame, by particles near that wall.
    const near = 2 * Math.max(this.hx, this.hy);
    const W = this.W; const H = this.H;
    let slam = 0;
    for (let i = 0; i < n; i++) {
      const x = px[i]; const y = py[i];
      if (x < near) slam += stopped(-pvx[i], -vx[i]);
      else if (x > W - near) slam += stopped(pvx[i], vx[i]);
      if (y < near) slam += stopped(-pvy[i], -vy[i]);
      else if (y > H - near) slam += stopped(pvy[i], vy[i]);
    }
    this.slam = slam / n;
    for (let i = 0; i < n; i++) {
      const s2 = vx[i] * vx[i] + vy[i] * vy[i];
      sum += Math.sqrt(s2);
      sum2 += s2;
      if (s2 > max2) max2 = s2;
      // density around the particle: the last P2G's cell-centre field, interpolated
      const b = cb[i]; const tx = ctx[i]; const ty = cty[i];
      const rho = ((1 - tx) * (1 - ty) * density[b] + tx * (1 - ty) * density[b + 1]
        + tx * ty * density[b + NX + 1] + (1 - tx) * ty * density[b + NX]) * irest;
      dens[i] = rho;
      // cells to the nearest air: air only gets into the liquid at its surface
      const depth = dist[((px[i] * ihx + 1) | 0) + ((py[i] * ihy + 1) | 0) * NX];
      const atTop = depth < 3;
      let src = 0;
      if (atTop) {
        // Non-gravitational acceleration, in g: about 1 at rest (the floor holds it up), 0 in
        // flight, many g where the liquid is stopped hard.
        const ax = vx[i] - pvx[i] - gdx;
        const ay = vy[i] - pvy[i] - gdy;
        src = (Math.sqrt(ax * ax + ay * ay) * ia - lo) * span;
        if (src < 0) src = 0; else if (src > 1) src = 1;
        src *= gain;
      }
      if (rho < 0.25) {
        air[i] += dt; // a lone droplet in flight
      } else {
        if (air[i] > 0.1 && rho > 0.5) { // landed in the liquid: a splash entrains air
          const sp = Math.sqrt(pvx[i] * pvx[i] + pvy[i] * pvy[i]);
          imp.n++;
          if (sp > imp.max) imp.max = sp;
          if (land > src) src = land;
        }
        air[i] = 0;
      }
      let f = foam[i] * (atTop ? keepTop : keepDeep) + src;
      if (f > 1) f = 1;
      foam[i] = f;
    }
    this.meanSpeed = sum / n;
    this.rmsSpeed = Math.sqrt(sum2 / n);
    this.maxSpeed = Math.sqrt(max2);
  }

  // Chamfer distance from each cell to the nearest air (in cells), for the renderer's depth
  // shading. Solid cells are not surface: they neither seed zero nor block the distance.
  _distance() {
    const { NX, NY, type, density, dist, nx, ny, depth8 } = this;
    const BIG = 1e3;
    const thr = 0.35 * this.rest;
    for (let c = 0; c < NX * NY; c++) {
      const t = type[c];
      dist[c] = t === SOLID ? BIG : t === FLUID && density[c] > thr ? BIG : 0;
    }
    const D = Math.SQRT2;
    for (let j = 1; j < NY - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const c = i + j * NX;
        let d = dist[c];
        if (d === 0) continue;
        const a = dist[c - 1] + 1; if (a < d) d = a;
        const b = dist[c - NX] + 1; if (b < d) d = b;
        const e = dist[c - NX - 1] + D; if (e < d) d = e;
        const f = dist[c - NX + 1] + D; if (f < d) d = f;
        dist[c] = d;
      }
    }
    for (let j = NY - 2; j >= 1; j--) {
      for (let i = NX - 2; i >= 1; i--) {
        const c = i + j * NX;
        let d = dist[c];
        if (d === 0) continue;
        const a = dist[c + 1] + 1; if (a < d) d = a;
        const b = dist[c + NX] + 1; if (b < d) d = b;
        const e = dist[c + NX + 1] + D; if (e < d) d = e;
        const f = dist[c + NX - 1] + D; if (f < d) d = f;
        dist[c] = d;
      }
    }
    // 16 levels per cell, up to 16 cells deep; the face between liquid and air reads 0.
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let d = dist[i + 1 + (j + 1) * NX] - 0.5;
        if (d < 0) d = 0; else if (d > 15.9) d = 15.9;
        depth8[i + j * nx] = (d * 16) | 0;
      }
    }
  }

  // Fraction of a ring of radius R around (x, y) that is in the liquid (cells at least half
  // full), from the last P2G. For the renderer, to fill a finger's hole when it is under water.
  liquidAround(x, y, R) {
    const { NX, density, hx, hy, nx, ny } = this;
    const thr = 0.5 * this.rest;
    let k = 0;
    for (let a = 0; a < 12; a++) {
      const t = (a * Math.PI) / 6;
      const i = Math.floor((x + Math.cos(t) * R) / hx);
      const j = Math.floor((y + Math.sin(t) * R) / hy);
      if (i < 0 || j < 0 || i >= nx || j >= ny) { k++; continue; } // a wall counts as wet
      if (density[i + 1 + (j + 1) * NX] > thr) k++;
    }
    return k / 12;
  }

  // Fraction of the box's cells at least half full: what the eye reads as the liquid's area.
  fillFraction() {
    const { NX, NY, density } = this;
    const thr = 0.5 * this.rest;
    let k = 0;
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) if (density[i + j * NX] > thr) k++;
    return k / (this.nx * this.ny);
  }

  // Angle (degrees) between the free surface and the perpendicular to (gx, gy): the top of the
  // liquid, binned across the gravity direction, fitted with a line (twice, the second time
  // without bins far off the first line). Bins whose top particle has a wall just above it are
  // not free surface and are left out; null if too little free surface is left to fit. For tests
  // and the debug overlay; not per frame.
  surfaceTilt(gx, gy) {
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-6) return 0;
    const upx = -gx / gl; const upy = -gy / gl; // against gravity
    const sx = -upy; const sy = upx; // across
    const { n, px, py, W, H } = this;
    const bw = 2 * Math.max(this.hx, this.hy);
    let smin = Infinity; let smax = -Infinity;
    for (let c = 0; c < 4; c++) {
      const s = (c & 1 ? W : 0) * sx + (c & 2 ? H : 0) * sy;
      if (s < smin) smin = s; if (s > smax) smax = s;
    }
    const nb = Math.max(2, Math.ceil((smax - smin) / bw));
    if (!this._tiltTop || this._tiltTop.length < nb) {
      this._tiltTop = new Float64Array(nb); this._tiltX = new Float64Array(nb);
      this._tiltY = new Float64Array(nb); this._tiltOk = new Uint8Array(nb);
    }
    const top = this._tiltTop; const tx = this._tiltX; const ty = this._tiltY; const ok = this._tiltOk;
    top.fill(-Infinity, 0, nb);
    for (let i = 0; i < n; i++) {
      // skip lone droplets: they are not the surface
      if (this.dens[i] < 0.4) continue;
      const s = px[i] * sx + py[i] * sy;
      const t = px[i] * upx + py[i] * upy;
      const b = Math.min(nb - 1, ((s - smin) / bw) | 0);
      if (t > top[b]) { top[b] = t; tx[b] = px[i]; ty[b] = py[i]; }
    }
    const margin = 3 * Math.max(this.hx, this.hy);
    for (let b = 0; b < nb; b++) {
      ok[b] = 0;
      if (top[b] === -Infinity) continue;
      const qx = tx[b] + upx * margin; const qy = ty[b] + upy * margin;
      if (qx < 0 || qx > W || qy < 0 || qy > H) continue; // a wall is above: not free surface
      ok[b] = 1;
    }
    let A = 0; let B = 0;
    for (let pass = 0; pass < 2; pass++) {
      let k = 0; let S = 0; let T = 0; let SS = 0; let ST = 0;
      for (let b = 0; b < nb; b++) {
        if (!ok[b]) continue;
        const s = smin + (b + 0.5) * bw; const t = top[b];
        if (pass === 1 && Math.abs(t - (A + B * s)) > 3 * bw) continue;
        k++; S += s; T += t; SS += s * s; ST += s * t;
      }
      const den = k * SS - S * S;
      if (k < 3 || Math.abs(den) < 1e-9) { if (pass === 0) return null; break; } // no free surface
      B = (k * ST - S * T) / den;
      A = (T - B * S) / k;
    }
    return (Math.atan(Math.abs(B)) * 180) / Math.PI;
  }
}
