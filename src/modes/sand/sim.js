// Dry sand as position-based discs in a 2D box (Macklin et al. 2014, "Unified Particle Physics for
// Real-Time Applications", and Macklin et al. 2019, "Small Steps in Physics Simulation"): several
// substeps a frame, one Gauss-Seidel sweep of contact projections each. A contact pushes two
// overlapping discs apart; friction then removes their relative tangential motion over the
// substep, all of it while it is below MU_S times the penetration (static), else MU_K times it
// (kinetic). Discs never roll, so they behave like angular grains and piles stand.
//
// Weight of a deep pile: the sweep visits cells from the bottom of the pile up (along gravity)
// and a contact moves the upper grain more than the lower one (shock propagation, Guendelman et
// al. 2003, done continuously by the contact's angle to gravity). Each grain then settles on
// grains that are already in place, so a pile 70 grains deep is held up in one sweep.
//
// At rest: a grain whose displacement over a substep is below a small fraction of the gravity
// step is put back where it was and stopped (Macklin's particle sleeping). That removes creep
// and jitter, and it is a little extra static friction.
//
// Units: CSS px and seconds, sim frame (x right, y down). DOM-free, so it runs in Node for tests.

export const PX_PER_M = 3000; // world scale: the 852 px tall phone box is a 28 cm bottle

// Tuning (docs/modes/sand.md says why each has its value). Exported so tests can vary them.
export const P = {
  MU_S: 0.75, // grain-grain static friction (penetration-relative)
  MU_K: 0.55, // grain-grain kinetic friction
  MU_WALL_S: 0.7, // walls (box sides): static
  MU_WALL_K: 0.5, // walls: kinetic
  MU_GLASS: 0.32, // back glass, normal force |g.z|: a flat phone holds sand up to 3.1 m/s² in-plane
  STACK: 1, // shock propagation: 1 = the lower grain of a vertical contact does not move
  STACK_G: 3, // in-plane gravity (m/s²) at which STACK reaches full strength
  POP: 25, // px/s: speed contacts may add beyond the predicted speed (a backstop)
  FIX_MAX: 0.3, // px: most of an overlap left from earlier substeps removed per substep, per contact
  SLOP: 0.08, // overlap left alone, in smallest-grain radii (Box2D's linear slop): no jitter in jams
  SLEEP: 0.15, // freeze threshold, as a fraction of the substep's gravity displacement g h²
  STEP_G: 0.45, // px: most displacement gravity may add in one substep (sets the substep count)
  STEP_V: 0.75, // most travel per substep, in smallest-grain radii (sets substeps; the cap is 2x)
  MAX_SUB: 10,
  MIN_SUB: 3,
};
const MAX_FINGER_V = 3000; // px/s
export const V_MOVING = 20; // px/s: "moving" for stats and sound (7 mm/s)

export class SandSim {
  // cap: most grains; rMin, rMax: smallest and largest radius (rMax sets the hash cell)
  constructor(cap, rMin, rMax) {
    this.cap = cap;
    this.n = 0;
    const F = () => new Float64Array(cap);
    this.x = F(); this.y = F();
    this.px = F(); this.py = F(); // position at the start of the substep
    this.vx = F(); this.vy = F();
    this.r = F();
    this.penX = F(); this.penY = F(); // wall penetration this substep, for wall friction
    this.fx = F(); this.fy = F(); // displacement from removing old overlap: moves, but is no speed
    this.sorted = new Int32Array(cap); // grain indices grouped by hash cell
    this.cellOf = new Int32Array(cap);
    this.cellX = new Int32Array(cap);
    this.cellY = new Int32Array(cap);
    this.order = new Int32Array(cap); // grain indices by height along gravity, lowest first
    this.rank = new Int32Array(cap);
    this.key = new Int32Array(cap);
    this.bucket = null;
    this.rMin = rMin;
    this.rMax = rMax;
    this.cell = 2 * rMax; // hash cell: any overlapping pair is in the same or adjacent cells
    this.W = 1; this.H = 1;
    this.gw = 1; this.gh = 1;
    this.cellStart = new Int32Array(2);
    this.fingerR = 22; // px
    this.fingers = []; // {id, x0, y0, x1, y1, vx, vy}: where each finger was and is this frame
    this.nSub = P.MIN_SUB;
    this.vMax = 0; // fastest grain after the last step, px/s
    this.wallHit = 0; // normal speed walls took this step beyond resting contact, summed, px/s
  }

  setBox(W, H) {
    this.W = W; this.H = H;
    this.gw = Math.max(1, Math.ceil(W / this.cell));
    this.gh = Math.max(1, Math.ceil(H / this.cell));
    const cells = this.gw * this.gh;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
  }

  // Fit the contents to a new box: scale positions, then push the overlaps that makes apart
  // without giving anything speed.
  rescale(W, H) {
    const sx = W / this.W, sy = H / this.H;
    this.setBox(W, H);
    if (!this.n) return;
    for (let i = 0; i < this.n; i++) { this.x[i] *= sx; this.y[i] *= sy; this.vx[i] = 0; this.vy[i] = 0; }
    const small = Math.abs(sx - 1) < 0.05 && Math.abs(sy - 1) < 0.05;
    this.relax(small ? 4 : 40);
  }

  add(x, y, r, vx = 0, vy = 0) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.r[i] = r; this.vx[i] = vx; this.vy[i] = vy;
    this.px[i] = x; this.py[i] = y;
    return i;
  }

  // Remove overlaps by plain projection: no gravity, no friction, velocities untouched.
  relax(iters) {
    const g0 = { x: 0, y: 0, z: 0 };
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < this.n; i++) { this.px[i] = this.x[i]; this.py[i] = this.y[i]; }
      this.clampWalls(false, 0);
      this.buildHash();
      this.solveContacts(g0, false);
      this.clampWalls(false, 0);
    }
  }

  // Fingers this frame: [{id, x, y, vx, vy}] in sim px and px/s. Each is swept from where it was
  // last frame to where it is now over the substeps, so a fast finger cannot jump over grains.
  setFingers(list) {
    const f = this.fingers;
    const old = f.length ? f.slice() : null;
    f.length = 0;
    if (!list) return;
    for (const p of list) {
      let o = null;
      if (old) for (const q of old) if (q.id === p.id) o = q;
      let vx = p.vx || 0, vy = p.vy || 0;
      const s = Math.hypot(vx, vy);
      if (s > MAX_FINGER_V) { vx *= MAX_FINGER_V / s; vy *= MAX_FINGER_V / s; }
      f.push({ id: p.id, x0: o ? o.x1 : p.x, y0: o ? o.y1 : p.y, x1: p.x, y1: p.y, vx, vy });
    }
  }

  // g: effective gravity in m/s², sim frame (z toward the back glass).
  step(dt, g) {
    this.wallHit = 0;
    if (!this.n || !(dt > 0)) return;
    const { STEP_G, STEP_V, MIN_SUB, MAX_SUB } = P;
    const gl = Math.hypot(g.x, g.y) * PX_PER_M;
    // Enough substeps that gravity adds at most STEP_G of displacement per substep and the fastest
    // grain travels at most STEP_V radii; a few more while a finger is in.
    const nG = Math.sqrt((gl * dt * dt) / STEP_G);
    const nV = ((this.vMax + gl * dt) * dt) / (STEP_V * this.rMin);
    let nSub = Math.ceil(Math.max(nG, nV, MIN_SUB) - 1e-6);
    if (this.fingers.length) nSub = Math.max(nSub, 5);
    nSub = Math.min(nSub, MAX_SUB);
    this.nSub = nSub;
    const h = dt / nSub;
    let vMax = 0;
    for (let s = 0; s < nSub; s++) vMax = this.substep(h, g, (s + 1) / nSub);
    this.vMax = vMax;
  }

  substep(h, g, u) {
    const { n, x, y, px, py, vx, vy, penX, penY } = this;
    const { MU_GLASS, STEP_V, SLEEP, MU_WALL_S, MU_WALL_K, POP } = P;
    const { fx, fy } = this;
    const gx = g.x * PX_PER_M, gy = g.y * PX_PER_M;
    const glass = MU_GLASS * Math.abs(g.z) * PX_PER_M * h; // speed the back glass takes per substep
    const vCap = (2 * STEP_V * this.rMin) / h;
    const vCap2 = vCap * vCap;
    const gStep = Math.hypot(gx, gy) * h * h; // px gravity adds per substep

    // Predict: gravity, back-glass friction, the speed cap.
    for (let i = 0; i < n; i++) {
      let a = vx[i] + gx * h, b = vy[i] + gy * h;
      if (glass > 0) {
        const s = Math.sqrt(a * a + b * b);
        if (s <= glass) { a = 0; b = 0; } else { const k = 1 - glass / s; a *= k; b *= k; }
      }
      const s2 = a * a + b * b;
      if (s2 > vCap2) { const k = vCap / Math.sqrt(s2); a *= k; b *= k; }
      vx[i] = a; vy[i] = b;
      px[i] = x[i]; py[i] = y[i];
      x[i] += a * h; y[i] += b * h;
      penX[i] = 0; penY[i] = 0;
      fx[i] = 0; fy[i] = 0;
    }
    // Into the box first, so a pile builds against a wall from the grains touching it.
    this.clampWalls(true, 2 * gStep);
    this.buildHash();
    this.solveContacts(g, true);
    this.pushFingers(u, h);
    // Walls again (contacts push into them), then wall friction, sleeping and velocities.
    this.clampWalls(true, 2 * gStep);

    const inv = 1 / h;
    const eps = SLEEP * gStep, eps2 = eps * eps;
    let vMax2 = 0;
    for (let i = 0; i < n; i++) {
      let xi = x[i], yi = y[i];
      // where the grain would be had it not moved, after the overlap fix
      const bx = px[i] + fx[i], by = py[i] + fy[i];
      const wx = penX[i], wy = penY[i];
      // Coulomb friction of the walls on the substep's tangential motion
      if (wx > 0) {
        const d = yi - by;
        if (d <= MU_WALL_S * wx && d >= -MU_WALL_S * wx) yi = by; else yi -= Math.sign(d) * MU_WALL_K * wx;
      }
      if (wy > 0) {
        const d = xi - bx;
        if (d <= MU_WALL_S * wy && d >= -MU_WALL_S * wy) xi = bx; else xi -= Math.sign(d) * MU_WALL_K * wy;
      }
      // Barely moved at all: put it back and stop it (no creep).
      const tx = xi - px[i], ty = yi - py[i];
      if (tx * tx + ty * ty < eps2) { x[i] = px[i]; y[i] = py[i]; vx[i] = 0; vy[i] = 0; continue; }
      x[i] = xi; y[i] = yi;
      let nvx = (xi - bx) * inv, nvy = (yi - by) * inv;
      // The overlap fix may cancel speed toward the grains it pushed this one out of (what one
      // sweep left undone last substep), never add speed away from them.
      const ffx = fx[i], ffy = fy[i], fl2 = ffx * ffx + ffy * ffy;
      if (fl2 > 1e-12) {
        const fl = Math.sqrt(fl2), ux = ffx / fl, uy = ffy / fl;
        const a = nvx * ux + nvy * uy;
        if (a < 0) {
          let a2 = a + fl * inv;
          if (a2 > 0) a2 = 0;
          nvx += (a2 - a) * ux; nvy += (a2 - a) * uy;
        }
      }
      // Contacts may slow and turn a grain but add little speed: a grain pushed out of an
      // overlap does not fly off.
      const ovx = vx[i], ovy = vy[i];
      const pv = Math.sqrt(ovx * ovx + ovy * ovy) + POP;
      let s2 = nvx * nvx + nvy * nvy;
      if (s2 > pv * pv) { const k = pv / Math.sqrt(s2); nvx *= k; nvy *= k; s2 = pv * pv; }
      vx[i] = nvx; vy[i] = nvy;
      if (s2 > vMax2) vMax2 = s2;
    }
    return Math.sqrt(vMax2);
  }

  // Keep every grain inside [r, W - r] x [r, H - r] and record how far each was pushed (wall
  // friction). Pushes beyond rest (more than `rest` px) count as wall hits, for sound.
  clampWalls(record, rest) {
    const { n, x, y, r, W, H, penX, penY } = this;
    let hit = 0;
    for (let i = 0; i < n; i++) {
      const ri = r[i];
      let xi = x[i], yi = y[i];
      let p = 0;
      if (xi < ri) { p = ri - xi; xi = ri; if (record) penX[i] += p; }
      else if (xi > W - ri) { p = xi - (W - ri); xi = W - ri; if (record) penX[i] += p; }
      if (p > rest) hit += p - rest;
      p = 0;
      if (yi < ri) { p = ri - yi; yi = ri; if (record) penY[i] += p; }
      else if (yi > H - ri) { p = yi - (H - ri); yi = H - ri; if (record) penY[i] += p; }
      if (p > rest) hit += p - rest;
      x[i] = xi; y[i] = yi;
    }
    if (record) this.wallHit += hit;
  }

  buildHash() {
    const { n, x, y, gw, gh, cellStart, sorted, cellOf, cellX, cellY } = this;
    const cells = gw * gh;
    const ih = 1 / this.cell;
    cellStart.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      let cx = (x[i] * ih) | 0, cy = (y[i] * ih) | 0;
      if (cx < 0) cx = 0; else if (cx >= gw) cx = gw - 1;
      if (cy < 0) cy = 0; else if (cy >= gh) cy = gh - 1;
      const c = cy * gw + cx;
      cellOf[i] = c; cellX[i] = cx; cellY[i] = cy;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
    // cellStart[c + 1] is now the end of cell c. Filling back to front leaves it at the start of
    // cell c with each cell's grains in index order; then shift the table down by one.
    for (let i = n - 1; i >= 0; i--) sorted[--cellStart[cellOf[i] + 1]] = i;
    for (let c = 0; c < cells; c++) cellStart[c] = cellStart[c + 1];
    cellStart[cells] = n;
  }

  // One Gauss-Seidel sweep over all contacts, grains visited in order of height along gravity,
  // lowest first (a bucket sort per substep). A grain is solved against the neighbours visited
  // before it, which are below it or level with it, so it settles on supports already in place;
  // each pair is met once.
  //
  // With `dynamic`, a contact splits its correction in two. The penetration the pair gained this
  // substep is undone and becomes velocity, as in plain PBD; friction acts on it. The overlap the
  // pair already had (one sweep leaves a little deep in a pile) is removed, at most FIX_MAX a
  // substep and down to SLOP, as a plain move recorded in fx, fy that the velocity update leaves
  // out. Turned into speed, that overlap would make the lopsided shock-propagation weights pump
  // grains upward and the pile would boil (Macklin's pre-stabilisation, folded into the sweep).
  // Without `dynamic` (relax), every overlap is removed outright.
  solveContacts(g, dynamic) {
    const { n, x, y, px, py, r, gw, gh, cellStart, sorted, cellX, cellY, fx, fy, order, rank } = this;
    const fixMax = P.FIX_MAX, slop = P.SLOP * this.rMin;
    const gx = g.x, gy = g.y;
    const gl = Math.hypot(gx, gy);
    const upx = gl > 1e-9 ? -gx / gl : 0, upy = gl > 1e-9 ? -gy / gl : 0;
    const S = 0.5 * P.STACK * Math.min(1, gl / P.STACK_G);
    const muS = P.MU_S, muK = P.MU_K;
    this.sortByHeight(upx, upy);

    for (let t = 0; t < n; t++) {
      const i = order[t];
      let xi = x[i], yi = y[i];
      const ri = r[i], pxi = px[i], pyi = py[i];
      const cx = cellX[i], cy = cellY[i];
      const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < gw - 1 ? cx + 1 : gw - 1;
      const y0 = cy > 0 ? cy - 1 : 0, y1 = cy < gh - 1 ? cy + 1 : gh - 1;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * gw;
        for (let kk = cellStart[row + x0], e = cellStart[row + x1 + 1]; kk < e; kk++) {
          const j = sorted[kk];
          if (rank[j] >= t) continue; // not visited yet (or i itself): met from its side
          let xj = x[j], yj = y[j];
          const dx = xi - xj, dy = yi - yj;
          const rr = ri + r[j];
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr) continue;
          let nx, ny, d;
          if (d2 > 1e-10) { d = Math.sqrt(d2); nx = dx / d; ny = dy / d; }
          else { d = 0; nx = upx || 1; ny = upy; } // coincident: put the later one on top
          let pen = rr - d;
          // share of the correction taken by i (the upper one): all of it for a steep contact
          let wi = S * (nx * upx + ny * upy);
          wi = wi > 0.5 ? 1 : wi < -0.5 ? 0 : 0.5 + wi;
          const wj = 1 - wi;
          if (dynamic) {
            // overlap of the pair where they would be without this substep's motion
            const ex = pxi + fx[i] - px[j] - fx[j], ey = pyi + fy[i] - py[j] - fy[j];
            const old = rr - Math.sqrt(ex * ex + ey * ey);
            if (old > 0) {
              let fix = (old < pen ? old : pen) - slop;
              fix = fix < 0 ? 0 : fix > fixMax ? fixMax : fix;
              pen -= old;
              const fxx = nx * fix, fyy = ny * fix;
              xi += fxx * wi; yi += fyy * wi; xj -= fxx * wj; yj -= fyy * wj;
              fx[i] += fxx * wi; fy[i] += fyy * wi; fx[j] -= fxx * wj; fy[j] -= fyy * wj;
              if (pen <= 0) { x[j] = xj; y[j] = yj; continue; }
            }
          }
          xi += nx * pen * wi; yi += ny * pen * wi;
          xj -= nx * pen * wj; yj -= ny * pen * wj;
          if (dynamic) {
            const rdx = (xi - pxi - fx[i]) - (xj - px[j] - fx[j]);
            const rdy = (yi - pyi - fy[i]) - (yj - py[j] - fy[j]);
            const dn = rdx * nx + rdy * ny;
            const tx = rdx - dn * nx, ty = rdy - dn * ny;
            const tl2 = tx * tx + ty * ty;
            if (tl2 > 1e-14) {
              const sp = muS * pen;
              let kf = 1;
              if (tl2 > sp * sp) { kf = (muK * pen) / Math.sqrt(tl2); if (kf > 1) kf = 1; }
              xi -= tx * kf * wi; yi -= ty * kf * wi;
              xj += tx * kf * wj; yj += ty * kf * wj;
            }
          }
          x[j] = xj; y[j] = yj;
        }
      }
      x[i] = xi; y[i] = yi;
    }
  }

  // order: grains lowest first along gravity (up = against it), in 0.25 px height buckets;
  // rank: each grain's place in it. No gravity in the plane: index order.
  sortByHeight(upx, upy) {
    const { n, x, y, order, rank } = this;
    if (upx === 0 && upy === 0) {
      for (let i = 0; i < n; i++) { order[i] = i; rank[i] = i; }
      return;
    }
    const Q = 4; // buckets per px
    // height of the box corners bounds every grain's height
    const hs = [0, upx * this.W, upy * this.H, upx * this.W + upy * this.H];
    const hMin = Math.min(...hs) - 1, hMax = Math.max(...hs) + 1;
    const nb = Math.ceil((hMax - hMin) * Q) + 1;
    if (!this.bucket || this.bucket.length < nb + 1) this.bucket = new Int32Array(nb + 1);
    const bucket = this.bucket, key = this.key;
    bucket.fill(0, 0, nb + 1);
    for (let i = 0; i < n; i++) {
      let k = ((x[i] * upx + y[i] * upy - hMin) * Q) | 0;
      if (k < 0) k = 0; else if (k >= nb) k = nb - 1;
      key[i] = k;
      bucket[k + 1]++;
    }
    for (let k = 0; k < nb; k++) bucket[k + 1] += bucket[k];
    for (let i = 0; i < n; i++) { const t = bucket[key[i]]++; order[t] = i; rank[i] = t; }
  }

  // Fingers are kinematic discs swept along their path over the frame (u: 0..1 through it):
  // grains are pushed out of them and dragged part of the way toward their motion.
  pushFingers(u, h) {
    const f = this.fingers;
    if (!f.length) return;
    const { n, x, y, px, py, r } = this;
    const R = this.fingerR;
    const R2 = (R + this.rMax) * (R + this.rMax);
    for (const q of f) {
      const fx = q.x0 + (q.x1 - q.x0) * u, fy = q.y0 + (q.y1 - q.y0) * u;
      for (let i = 0; i < n; i++) {
        const dx = x[i] - fx, dy = y[i] - fy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        const Ri = R + r[i];
        if (d2 >= Ri * Ri) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const k = (Ri - d) / d;
        x[i] += dx * k; y[i] += dy * k;
        x[i] += (q.vx * h - (x[i] - px[i])) * 0.3;
        y[i] += (q.vy * h - (y[i] - py[i])) * 0.3;
      }
    }
  }

  // Slope of the pile's free surface against the gravity-perpendicular, degrees: surface height
  // in 8 px columns across gravity, line fits over 64 px windows, the mean of the steepest third.
  // Meaningful once the pile has settled.
  reposeAngle(g) {
    const { n, x, y } = this;
    const gl = Math.hypot(g.x, g.y);
    if (gl < 1e-6 || n < 50) return 0;
    const dx = g.x / gl, dy = g.y / gl; // down
    const tx = -dy, ty = dx; // across
    let uMin = Infinity, uMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = x[i] * tx + y[i] * ty;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
    }
    const BIN = 8;
    const nb = Math.min(512, Math.max(1, Math.ceil((uMax - uMin) / BIN)));
    if (!this.topBuf || this.topBuf.length < nb) this.topBuf = new Float64Array(512);
    const top = this.topBuf;
    top.fill(-Infinity, 0, nb);
    for (let i = 0; i < n; i++) {
      const u = x[i] * tx + y[i] * ty;
      const hgt = -(x[i] * dx + y[i] * dy); // height against gravity
      const b = Math.min(nb - 1, ((u - uMin) / BIN) | 0);
      if (hgt > top[b]) top[b] = hgt;
    }
    const WIN = 8; // bins per fit
    const angles = [];
    for (let b0 = 1; b0 + WIN < nb - 1; b0 += 2) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (let b = b0; b < b0 + WIN; b++) {
        if (!Number.isFinite(top[b])) continue;
        const u = b * BIN;
        sx += u; sy += top[b]; sxx += u * u; sxy += u * top[b]; m++;
      }
      if (m < WIN - 1) continue;
      const den = m * sxx - sx * sx;
      if (den <= 0) continue;
      angles.push(Math.abs(Math.atan((m * sxy - sx * sy) / den)) * 57.29578);
    }
    if (!angles.length) return 0;
    angles.sort((p, q) => q - p);
    const k = Math.max(1, Math.round(angles.length / 3));
    let s = 0;
    for (let i = 0; i < k; i++) s += angles[i];
    return s / k;
  }
}
