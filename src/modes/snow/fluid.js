// The globe's liquid: Stam's stable fluids on a coarse collocated grid that spans the box.
// Units: positions sim px, velocities sim px/s. The grid carries a one-cell ghost ring that is
// permanently solid, so neighbour indices never leave the arrays. Solid cells (the ring and the
// scene) hold zero velocity: the walls and the scene are no-slip and drag the liquid with the glass.
// Cost is O(cells) per step, about 2.2k cells at high quality; nothing allocates after construction.

export class Fluid {
  // cells: target number of cells; they are kept close to square whatever the box's aspect.
  constructor(W, H, cells) {
    const h0 = Math.sqrt((W * H) / cells);
    this.nx = Math.max(6, Math.round(W / h0));
    this.ny = Math.max(6, Math.round(H / h0));
    this.W = W;
    this.H = H;
    this.hx = W / this.nx;
    this.hy = H / this.ny;
    this.ihx = 1 / this.hx;
    this.ihy = 1 / this.hy;
    this.stride = this.nx + 2;
    const n = this.stride * (this.ny + 2);
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.u0 = new Float32Array(n);
    this.v0 = new Float32Array(n);
    this.p = new Float32Array(n);
    this.div = new Float32Array(n);
    this.curl = new Float32Array(n);
    // Stream function of the projected flow (psi = 0 in solids), for the flakes: see flow().
    this.psi = new Float32Array(n);
    this.solid = new Uint8Array(n).fill(1);
    // 0 at walls and the scene, 1 well inside the liquid: where the liquid can lag the glass.
    this.prof = new Float32Array(n);
    this.cx = new Float32Array(n); // cell-centre position, sim px
    this.cy = new Float32Array(n);
    // Pressure stencil: per-neighbour weight (0 where the neighbour is solid) and 1 / diagonal.
    this.wE = new Float32Array(n);
    this.wW = new Float32Array(n);
    this.wN = new Float32Array(n);
    this.wS = new Float32Array(n);
    this.invD = new Float32Array(n);
    this.cells = new Int32Array(n); // indices of liquid cells
    this.nCells = 0;
    this.su = 0; // last sample() / flow()
    this.sv = 0;
    this.maxSpeed = 0; // after step(), px/s
    this.meanSq = 0; // mean |u|² over liquid cells, (px/s)²
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const c = (j + 1) * this.stride + i + 1;
        this.cx[c] = (i + 0.5) * this.hx;
        this.cy[c] = (j + 0.5) * this.hy;
      }
    }
  }

  // coverage(x0, y0, x1, y1) -> fraction 0..1 of that rect taken by the scene.
  setSolid(coverage) {
    const { nx, ny, stride, solid } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = (j + 1) * stride + i + 1;
        solid[c] = coverage(i * this.hx, j * this.hy, (i + 1) * this.hx, (j + 1) * this.hy) > 0.55 ? 1 : 0;
      }
    }
    this._fillPockets();
    // Stencil and the list of liquid cells.
    const ax = this.ihx * this.ihx;
    const ay = this.ihy * this.ihy;
    this.nCells = 0;
    for (let c = 0; c < solid.length; c++) {
      this.u[c] = 0; this.v[c] = 0; this.p[c] = 0; this.psi[c] = 0;
      if (solid[c]) { this.invD[c] = 0; continue; }
      this.wE[c] = solid[c + 1] ? 0 : ax;
      this.wW[c] = solid[c - 1] ? 0 : ax;
      this.wS[c] = solid[c + stride] ? 0 : ay;
      this.wN[c] = solid[c - stride] ? 0 : ay;
      const d = this.wE[c] + this.wW[c] + this.wS[c] + this.wN[c];
      this.invD[c] = d > 0 ? 1 / d : 0;
      this.cells[this.nCells++] = c;
    }
    // Distance to the nearest solid, in cells (two-pass chamfer), shaped into the lag profile.
    const dist = this.curl; // scratch
    for (let c = 0; c < solid.length; c++) dist[c] = solid[c] ? 0 : 1e9;
    const d1 = 1, d2 = Math.SQRT2;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const c = j * stride + i;
        if (solid[c]) continue;
        dist[c] = Math.min(dist[c], dist[c - 1] + d1, dist[c - stride] + d1, dist[c - stride - 1] + d2, dist[c - stride + 1] + d2);
      }
    }
    for (let j = ny; j >= 1; j--) {
      for (let i = nx; i >= 1; i--) {
        const c = j * stride + i;
        if (solid[c]) continue;
        dist[c] = Math.min(dist[c], dist[c + 1] + d1, dist[c + stride] + d1, dist[c + stride + 1] + d2, dist[c + stride - 1] + d2);
      }
    }
    for (let c = 0; c < solid.length; c++) {
      const t = Math.min(1, Math.max(0, (dist[c] - 0.5) / 3.5));
      this.prof[c] = solid[c] ? 0 : t * t * (3 - 2 * t);
      dist[c] = 0;
    }
  }

  // The collocated projection is only a true projection where the liquid is at least two cells
  // wide: in a one-cell dead end (between a tree and the wall, say) it pumps energy instead of
  // removing it. So fill liquid cells with three or four solid neighbours until none are left,
  // and fill every pocket not connected to the largest body of liquid.
  _fillPockets() {
    const { solid, stride } = this;
    const n = solid.length;
    for (let changed = true; changed;) {
      changed = false;
      for (let c = stride; c < n - stride; c++) {
        if (solid[c]) continue;
        if (solid[c + 1] + solid[c - 1] + solid[c + stride] + solid[c - stride] >= 3) { solid[c] = 1; changed = true; }
      }
    }
    // Label connected regions (4-neighbour flood fill); keep only the largest.
    const label = this.cells; // scratch, rebuilt by setSolid right after
    label.fill(-1);
    const stack = new Int32Array(n);
    const nb = [1, -1, stride, -stride];
    let best = -1, bestSize = 0, nLabels = 0;
    for (let s = 0; s < n; s++) {
      if (solid[s] || label[s] >= 0) continue;
      const id = nLabels++;
      let top = 0, size = 0;
      stack[top++] = s;
      label[s] = id;
      while (top > 0) {
        const c = stack[--top];
        size++;
        for (const o of nb) {
          const d = c + o;
          if (!solid[d] && label[d] < 0) { label[d] = id; stack[top++] = d; }
        }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }
    for (let c = 0; c < n; c++) if (!solid[c] && label[c] !== best) solid[c] = 1;
  }

  // Bilinear velocity at a sim position into this.su / this.sv (solids and walls count as 0).
  sample(x, y) {
    let gx = x * this.ihx + 0.5; // padded cell coordinates of the cell centres
    let gy = y * this.ihy + 0.5;
    const nx = this.nx, ny = this.ny;
    if (gx < 0.5) gx = 0.5; else if (gx > nx + 0.5) gx = nx + 0.5;
    if (gy < 0.5) gy = 0.5; else if (gy > ny + 0.5) gy = ny + 0.5;
    const i0 = gx | 0, j0 = gy | 0;
    const fx = gx - i0, fy = gy - j0;
    const c = j0 * this.stride + i0;
    const s = this.stride;
    const u = this.u, v = this.v;
    const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), d = (1 - fx) * fy, e = fx * fy;
    this.su = u[c] * a + u[c + 1] * b + u[c + s] * d + u[c + s + 1] * e;
    this.sv = v[c] * a + v[c + 1] * b + v[c + s] * d + v[c + s + 1] * e;
  }

  // ---------------------------------------------------------------- forces (call before step)

  // A uniform acceleration (px/s²) felt by the liquid but not by the glass, shaped by prof:
  // the walls hold the liquid back, so what is left after projection is shear and swirl.
  addLag(ax, ay, dt) {
    const { cells, prof, u, v } = this;
    const kx = ax * dt, ky = ay * dt;
    for (let k = 0; k < this.nCells; k++) {
      const c = cells[k];
      u[c] += kx * prof[c];
      v[c] += ky * prof[c];
    }
  }

  // The glass turned by dOmega rad/s (in the sim frame) more than last step: the liquid keeps
  // still in the world, so in the box it turns the other way round the centre.
  addRotation(dOmega) {
    if (dOmega === 0) return;
    const { cells, prof, u, v, cx, cy } = this;
    const mx = this.W * 0.5, my = this.H * 0.5;
    for (let k = 0; k < this.nCells; k++) {
      const c = cells[k];
      const w = dOmega * prof[c];
      u[c] += w * (cy[c] - my);
      v[c] -= w * (cx[c] - mx);
    }
  }

  // A Gaussian vortex: peak swirl speed V (px/s, sign = sense) at radius R (px) round (x0, y0).
  addVortex(x0, y0, R, V) {
    const { nx, ny, stride, solid, u, v, cx, cy } = this;
    const reach = 2.6 * R;
    const i0 = Math.max(0, Math.floor((x0 - reach) * this.ihx)), i1 = Math.min(nx - 1, Math.floor((x0 + reach) * this.ihx));
    const j0 = Math.max(0, Math.floor((y0 - reach) * this.ihy)), j1 = Math.min(ny - 1, Math.floor((y0 + reach) * this.ihy));
    const iR2 = 1 / (R * R), k = V / R;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = (j + 1) * stride + i + 1;
        if (solid[c]) continue;
        const dx = cx[c] - x0, dy = cy[c] - y0;
        const e = k * Math.exp(0.5 * (1 - (dx * dx + dy * dy) * iR2));
        u[c] -= e * dy;
        v[c] += e * dx;
      }
    }
  }

  // A finger dragged over the glass drags the liquid under it toward its own velocity
  // (only speeding the liquid up along the finger's direction, never braking it).
  stir(x0, y0, pvx, pvy, R, dt) {
    const sp = Math.hypot(pvx, pvy);
    if (sp < 1) return;
    const dxu = pvx / sp, dyu = pvy / sp;
    const { nx, ny, stride, solid, u, v, cx, cy } = this;
    const reach = 2 * R;
    const i0 = Math.max(0, Math.floor((x0 - reach) * this.ihx)), i1 = Math.min(nx - 1, Math.floor((x0 + reach) * this.ihx));
    const j0 = Math.max(0, Math.floor((y0 - reach) * this.ihy)), j1 = Math.min(ny - 1, Math.floor((y0 + reach) * this.ihy));
    const iR2 = 1 / (R * R);
    const rate = 1 - Math.exp(-dt / 0.06);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = (j + 1) * stride + i + 1;
        if (solid[c]) continue;
        const dx = cx[c] - x0, dy = cy[c] - y0;
        const w = Math.exp(-(dx * dx + dy * dy) * iR2) * rate;
        const along = u[c] * dxu + v[c] * dyu;
        if (along >= sp) continue;
        const add = (sp - along) * w;
        u[c] += dxu * add;
        v[c] += dyu * add;
      }
    }
  }

  // ---------------------------------------------------------------- step

  // eps: vorticity confinement strength; decay: e-folding time of the liquid's motion, s.
  step(dt, { eps = 0.6, decay = 2.2, iters = 24, vmax = 1400, psiIters = 12 } = {}) {
    if (eps > 0) this._confine(dt, eps);
    this._advect(dt);
    this._project(iters);
    const { cells, u, v } = this;
    const k = Math.exp(-dt / decay);
    const v2max = vmax * vmax;
    let sum = 0, mx = 0;
    for (let n = 0; n < this.nCells; n++) {
      const c = cells[n];
      let a = u[c] * k, b = v[c] * k;
      let s = a * a + b * b;
      if (!(s <= v2max)) { // also catches NaN
        if (s > v2max) { const f = vmax / Math.sqrt(s); a *= f; b *= f; s = v2max; } else { a = 0; b = 0; s = 0; }
      }
      u[c] = a; v[c] = b;
      sum += s;
      if (s > mx) mx = s;
    }
    this.meanSq = this.nCells ? sum / this.nCells : 0;
    this.maxSpeed = Math.sqrt(mx);
    this._streamFunction(psiIters);
  }

  // psi with -lap(psi) = curl(u) and psi = 0 in every solid cell (the scene is joined to the
  // walls through the ground, so the whole boundary is one streamline). SOR, warm-started.
  _streamFunction(iters) {
    const { cells, stride, u, v, psi, curl } = this;
    const n = this.nCells;
    const ihx2 = 0.5 * this.ihx, ihy2 = 0.5 * this.ihy;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      curl[c] = (v[c + 1] - v[c - 1]) * ihx2 - (u[c + stride] - u[c - stride]) * ihy2;
    }
    const ax = this.ihx * this.ihx, ay = this.ihy * this.ihy, id = 1 / (2 * ax + 2 * ay);
    const om = 1.8;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < n; k++) {
        const c = cells[k];
        const t = (ax * (psi[c + 1] + psi[c - 1]) + ay * (psi[c + stride] + psi[c - stride]) + curl[c]) * id;
        psi[c] += om * (t - psi[c]);
      }
    }
  }

  // The velocity flakes are carried by, into this.su / this.sv: the curl of the bilinear stream
  // function. Inside each cell it is exactly divergence-free and it runs along the solids, so
  // flakes cannot pile up against surfaces the way they do in the plain interpolated velocity
  // (which, between the last liquid cell and a solid one, always has a part flowing into it).
  flow(x, y) {
    let gx = x * this.ihx + 0.5;
    let gy = y * this.ihy + 0.5;
    const nx = this.nx, ny = this.ny;
    if (gx < 0.5) gx = 0.5; else if (gx > nx + 0.5) gx = nx + 0.5;
    if (gy < 0.5) gy = 0.5; else if (gy > ny + 0.5) gy = ny + 0.5;
    const i0 = gx | 0, j0 = gy | 0;
    const fx = gx - i0, fy = gy - j0;
    const c = j0 * this.stride + i0;
    const s = this.stride;
    const psi = this.psi;
    const p00 = psi[c], p10 = psi[c + 1], p01 = psi[c + s], p11 = psi[c + s + 1];
    this.su = ((p01 - p00) * (1 - fx) + (p11 - p10) * fx) * this.ihy;
    this.sv = -((p10 - p00) * (1 - fy) + (p11 - p01) * fy) * this.ihx;
  }

  _confine(dt, eps) {
    const { cells, stride, u, v, curl } = this;
    const n = this.nCells;
    const ihx2 = 0.5 * this.ihx, ihy2 = 0.5 * this.ihy;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      curl[c] = (v[c + 1] - v[c - 1]) * ihx2 - (u[c + stride] - u[c - stride]) * ihy2;
    }
    const f0 = eps * 0.5 * (this.hx + this.hy) * dt;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      const w = curl[c];
      const gx = (Math.abs(curl[c + 1]) - Math.abs(curl[c - 1])) * ihx2;
      const gy = (Math.abs(curl[c + stride]) - Math.abs(curl[c - stride])) * ihy2;
      const len = Math.sqrt(gx * gx + gy * gy) + 1e-5;
      const f = (f0 * w) / len;
      u[c] += f * gy;
      v[c] -= f * gx;
    }
  }

  _advect(dt) {
    const { cells, stride, u, v, u0, v0, nx, ny } = this;
    u0.set(u);
    v0.set(v);
    const kx = dt * this.ihx, ky = dt * this.ihy;
    for (let k = 0; k < this.nCells; k++) {
      const c = cells[k];
      const ci = c % stride, cj = (c - ci) / stride;
      let x = ci - u0[c] * kx, y = cj - v0[c] * ky;
      if (x < 0.5) x = 0.5; else if (x > nx + 0.5) x = nx + 0.5;
      if (y < 0.5) y = 0.5; else if (y > ny + 0.5) y = ny + 0.5;
      const i0 = x | 0, j0 = y | 0;
      const fx = x - i0, fy = y - j0;
      const s = j0 * stride + i0;
      const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), d = (1 - fx) * fy, e = fx * fy;
      u[c] = u0[s] * a + u0[s + 1] * b + u0[s + stride] * d + u0[s + stride + 1] * e;
      v[c] = v0[s] * a + v0[s + 1] * b + v0[s + stride] * d + v0[s + stride + 1] * e;
    }
  }

  // Make the velocity divergence-free: solve ∇²p = ∇·u by SOR (warm-started from last step's p),
  // then u -= ∇p. Solid neighbours contribute zero velocity and mirror the pressure (Neumann).
  _project(iters) {
    const { cells, stride, u, v, p, div, solid, wE, wW, wN, wS, invD } = this;
    const n = this.nCells;
    const ihx2 = 0.5 * this.ihx, ihy2 = 0.5 * this.ihy;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      div[c] = (u[c + 1] - u[c - 1]) * ihx2 + (v[c + stride] - v[c - stride]) * ihy2;
    }
    const om = 1.75;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < n; k++) {
        const c = cells[k];
        const s = wE[c] * p[c + 1] + wW[c] * p[c - 1] + wS[c] * p[c + stride] + wN[c] * p[c - stride];
        p[c] += om * ((s - div[c]) * invD[c] - p[c]);
      }
    }
    // A closed box fixes p only up to a constant; keep it near zero so float32 stays precise.
    let mean = 0;
    for (let k = 0; k < n; k++) mean += p[cells[k]];
    mean = n ? mean / n : 0;
    for (let k = 0; k < n; k++) p[cells[k]] -= mean;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      const pc = p[c];
      const pE = solid[c + 1] ? pc : p[c + 1];
      const pW = solid[c - 1] ? pc : p[c - 1];
      const pS = solid[c + stride] ? pc : p[c + stride];
      const pN = solid[c - stride] ? pc : p[c - stride];
      u[c] -= (pE - pW) * ihx2;
      v[c] -= (pS - pN) * ihy2;
    }
  }

  // Liquid velocity into another grid (resize): sample this one at the other's cell centres.
  copyInto(o) {
    for (let k = 0; k < o.nCells; k++) {
      const c = o.cells[k];
      this.sample((o.cx[c] / o.W) * this.W, (o.cy[c] / o.H) * this.H);
      o.u[c] = this.su * (o.W / this.W);
      o.v[c] = this.sv * (o.H / this.H);
    }
  }
}
