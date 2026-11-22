// Rigid-ball engine for a thin glass box: one layer of spheres seen from the front.
//
// Bodies are discs in the screen plane (sim px, y down) with full 3D spin. The in-plane
// contacts (ball-ball, ball-wall, ball-finger) act on (vx, vy, wz) like a 2D engine, plus a
// "twist" friction row that stops spin about in-plane axes. The back (or front) glass is a
// per-body friction contact pressed by |g.z|: it couples (vx, vy) with (wx, wy), so a ball
// pressed against the glass rolls on it, with rolling and spinning resistance.
//
// Each frame runs substeps at a fixed rate (mat.substepHz). Contacts are found every K
// substeps with speculative margins (a contact lets its pair close exactly the gap, no more);
// K adapts to the fastest ball, so nothing travels further than a fraction of the smallest
// radius between collision passes. Each substep:
//   1. gravity, damping, speed limits;
//   2. warm start (resting contacts carry their impulse over; impacts do not);
//   3. velocity Gauss-Seidel sweeps over hard contacts (normal, friction, twist, rolling
//      resistance), contacts ordered bottom-up along gravity; then the glass rows;
//   4. shock propagation (see _shockVelocity): one bottom-up and one top-down sweep in which
//      each ball, all its supports final, takes the least velocity change that stops it
//      closing on them. This is what stops a pile landing on the floor in one substep;
//   5. positions;
//   6. position projection (_project, _projectShock): overlap removed geometrically, without
//      touching velocities, so piles never sink into themselves under load.
// Restitution is applied once per collision pass. Anything still overlapping at the frame end
// gets position-only clean-up passes: the drawn state is what is measured (maxOverlap).
//
// When every ball has been slow for a while the box sleeps: nothing moves at all until gravity
// changes, a finger comes near, or the box is resized.
//
// Units: px, s. Gravity arrives in m/s² and is scaled by mat.pxPerM. Masses are relative
// (the mean ball has mass about 1): only ratios matter to the solver. docs/modes/balls.md has
// the reasoning and the measurements.

const WALLS = 4; // other-body ids 0..3: left, right, top, bottom
export const MAX_FINGERS = 4; // other-body ids 4..7
const OTHERS = WALLS + MAX_FINGERS;
const WS = 12; // warm-start slots per body (contacts where it is the first body)
export const TOP_IMPACTS = 6; // loudest impacts reported per frame
const LOCAL = 12; // most supports one ball's shock solve looks at

export class BallWorld {
  // radii: relative sizes (1 = the base size); mat: material constants (see presets.js)
  constructor(radii, mat) {
    const n = radii.length;
    this.n = n;
    this.mat = mat;
    const f = () => new Float64Array(n);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f();
    this.wx = f(); this.wy = f(); this.wz = f();
    this.r = f(); this.rel = f();
    this.m = f(); this.invM = f(); this.invI = f();
    this.dpx = f(); this.dpy = f(); // displacement since the last collision pass
    this.pMove = f(); this.pReach = 0; // how far projection moved each ball this pass, and the most
    this.q = new Float64Array(n * 4); // orientation quaternions (x, y, z, w), local -> sim
    this.gPx = f(); this.gPy = f(); this.gRx = f(); this.gRy = f(); this.gS = f(); // glass impulses
    this.slowT = f(); // seconds spent below the sleep speed
    this.order = new Int32Array(n); // balls sorted along gravity, lowest first (solver order)
    this.rank = new Int32Array(n);
    this.key = f();
    this.W = 1; this.H = 1;
    this.baseR = 1; this.rMin = 1; this.rMax = 1;
    this.vmax = mat.maxSpeed; // px/s: speed cap for this box (resize)
    for (let i = 0; i < n; i++) { this.rel[i] = radii[i]; this.q[i * 4 + 3] = 1; this.order[i] = i; }

    // Walls and fingers: static or kinematic, infinite mass. For a finger, (ox, oy) is where it
    // is now; it moves by (oStepX, oStepY) over the current frame, at velocity (ovx, ovy).
    this.ox = new Float64Array(OTHERS); this.oy = new Float64Array(OTHERS);
    this.ovx = new Float64Array(OTHERS); this.ovy = new Float64Array(OTHERS);
    this.odpx = new Float64Array(OTHERS); this.odpy = new Float64Array(OTHERS);
    this.oStepX = new Float64Array(OTHERS); this.oStepY = new Float64Array(OTHERS);
    this.fOn = new Uint8Array(MAX_FINGERS);
    this.fId = new Float64Array(MAX_FINGERS);
    this.fR = mat.fingerRadius;

    // Contacts. b < n: another ball; b >= n: other body (b - n).
    const cap = n * 14 + 64;
    this.cap = cap;
    this.nc = 0;
    this.ca = new Int32Array(cap); this.cb = new Int32Array(cap);
    this.cfinger = new Uint8Array(cap);
    const fc = () => new Float64Array(cap);
    this.cnx = fc(); this.cny = fc(); this.cs0 = fc(); this.crel = fc();
    this.cmn = fc(); this.cmt = fc(); this.cmz = fc(); this.cmr = fc();
    this.cPn = fc(); this.cPt = fc(); this.cPz = fc(); this.cPr = fc(); this.cMax = fc();
    this.cmu = fc(); this.ce = fc(); this.crr = fc(); this.cra = fc(); this.crb = fc();
    this.cLim = fc(); // most normal impulse per substep (fingers are not infinitely strong)

    this.wsB = new Int32Array(n * WS); this.wsN = new Uint8Array(n);
    this.wsPn = new Float64Array(n * WS); this.wsPt = new Float64Array(n * WS);
    this.wsPz = new Float64Array(n * WS); this.wsPr = new Float64Array(n * WS);

    this.cellOf = new Int32Array(n); this.cellStart = new Int32Array(64); this.cellItems = new Int32Array(n);
    this.cursor = new Int32Array(64);
    this.supStart = new Int32Array(n + 1); this.supCur = new Int32Array(n); this.supList = new Int32Array(this.cap);
    this.lmx = new Float64Array(LOCAL); this.lmy = new Float64Array(LOCAL); this.le = new Float64Array(LOCAL);
    this.lout = new Float64Array(2);
    this.cFrom = new Int32Array(n); this.cTo = new Int32Array(n);

    this.fsoft = { biasRate: 0, massScale: 1, impulseScale: 0 }; // the finger's soft contact
    this.side = 1;
    this.passIters = mat.velIters; this.passProj = mat.projectIters;
    this.asleep = false;
    this.gSleep = { x: 0, y: 0, z: 0 };
    this.relaxG = { x: 0, y: 1, z: 0 }; // last gravity seen (px/s²): the support order for relax()
    this.repairs = 0; // non-finite states caught and reset (should stay 0)
    this.dropped = 0; // contacts dropped for lack of capacity (should stay 0)
    this.passes = 0; // collision passes in the last step
    this.peakOverlap = 0; // deepest ball-ball penetration seen at a frame end since the last read
    this.lastOverlap = 0;
    this.worstOverlap = 0; // ...and since the last spawn
    // Impacts this frame, loudest first: intensity 0..1, the smaller radius, wall or ball.
    this.impN = 0;
    this.impI = new Float64Array(TOP_IMPACTS);
    this.impR = new Float64Array(TOP_IMPACTS);
    this.impWall = new Uint8Array(TOP_IMPACTS);
  }

  // The box is W x H sim px. Radii follow the box area so the fill fraction stays the same;
  // positions are scaled into the new box (never reset).
  resize(W, H) {
    const mat = this.mat, n = this.n;
    const oldW = this.W, oldH = this.H;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.rel[i] * this.rel[i];
    this.baseR = Math.sqrt((mat.fill * W * H) / (Math.PI * sum));
    let mSum = 0;
    for (let i = 0; i < n; i++) {
      this.r[i] = this.rel[i] * this.baseR;
      this.m[i] = Math.pow(this.rel[i], mat.massExp);
      mSum += this.m[i];
    }
    const mMean = mSum / n;
    this.rMax = 0; this.rMin = Infinity;
    for (let i = 0; i < n; i++) {
      this.m[i] /= mMean;
      this.invM[i] = 1 / this.m[i];
      this.invI[i] = 1 / (mat.inertiaK * this.m[i] * this.r[i] * this.r[i]);
      this.rMax = Math.max(this.rMax, this.r[i]);
      this.rMin = Math.min(this.rMin, this.r[i]);
    }
    // Speed cap: at most subTravel·rMin per substep at the nominal rate, and never above maxSpeed.
    this.vmax = Math.min(mat.maxSpeed, mat.subTravel * this.rMin * mat.substepHz);
    const sx = W / oldW, sy = H / oldH;
    this.W = W; this.H = H;
    for (let i = 0; i < n; i++) {
      this.x[i] = clamp(this.x[i] * sx, this.r[i], W - this.r[i]);
      this.y[i] = clamp(this.y[i] * sy, this.r[i], H - this.r[i]);
    }
    this.wsN.fill(0);
    this.wake();
    this.relax();
  }

  // Positions only: push overlapping balls apart until none overlaps (or 60 rounds). After a
  // resize squeezes the contents, so the box never shows them inside each other.
  relax() {
    const g = this.relaxG;
    for (let round = 0; round < 60; round++) {
      this._collide(0, g.x, g.y, 0);
      this._buildSupports();
      for (let it = 0; it < 4; it++) this._project();
      this._projectShock();
      this._guard();
      this.lastOverlap = this._measureOverlap();
      if (this.lastOverlap < 0.01) break;
    }
    this.peakOverlap = this.lastOverlap;
    this.nc = 0;
    this.wsN.fill(0);
  }

  // Scatter the balls over the box without overlap, nearly at rest: they fall and pile up,
  // which is what the first frames show ("poured in").
  spawn(rand) {
    const n = this.n, W = this.W, H = this.H;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.r[b] - this.r[a]);
    const top = 0.03 * H, bottom = 0.97 * H;
    for (let k = 0; k < n; k++) {
      const i = idx[k], r = this.r[i];
      let x = 0, y = 0, ok = false;
      for (let t = 0; t < 600 && !ok; t++) {
        x = r + rand() * (W - 2 * r);
        y = top + r + rand() * Math.max(1, bottom - top - 2 * r);
        ok = true;
        for (let m = 0; m < k; m++) {
          const j = idx[m];
          const dx = x - this.x[j], dy = y - this.y[j], rr = r + this.r[j] + 1;
          if (dx * dx + dy * dy < rr * rr) { ok = false; break; }
        }
      }
      this.x[i] = clamp(x, r, W - r);
      this.y[i] = clamp(y, r, H - r);
      this.vx[i] = (rand() - 0.5) * 80; this.vy[i] = (rand() - 0.5) * 80;
      this.wx[i] = (rand() - 0.5) * 6; this.wy[i] = (rand() - 0.5) * 6; this.wz[i] = (rand() - 0.5) * 6;
      randomQuat(rand, this.q, i * 4);
    }
    this.wsN.fill(0);
    this.gPx.fill(0); this.gPy.fill(0); this.gRx.fill(0); this.gRy.fill(0); this.gS.fill(0);
    this.nc = 0;
    this.wake();
    this.worstOverlap = 0;
  }

  wake() {
    this.asleep = false;
    this.slowT.fill(0);
  }

  // Fingers: [{id, x, y}] in sim px. A finger is a kinematic disc that slides to the pointer
  // over the frame; its velocity is that motion (not the pointer's reported velocity, so it
  // never pushes harder than it moves). A new finger appears where it lands.
  setFingers(list, dt) {
    const vmax = this.mat.fingerMaxSpeed;
    for (let k = 0; k < MAX_FINGERS; k++) {
      const o = WALLS + k;
      const p = k < list.length ? list[k] : null;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { this.fOn[k] = 0; continue; }
      const fresh = !this.fOn[k] || this.fId[k] !== p.id;
      this.fOn[k] = 1;
      this.fId[k] = p.id;
      if (fresh) {
        this.ox[o] = p.x; this.oy[o] = p.y;
        this.oStepX[o] = 0; this.oStepY[o] = 0; this.ovx[o] = 0; this.ovy[o] = 0;
        continue;
      }
      let dx = p.x - this.ox[o], dy = p.y - this.oy[o];
      const d = Math.hypot(dx, dy), lim = vmax * dt;
      if (d > lim) { dx *= lim / d; dy *= lim / d; }
      this.oStepX[o] = dx; this.oStepY[o] = dy;
      this.ovx[o] = dx / dt; this.ovy[o] = dy / dt;
    }
  }

  // Advance by dt seconds under gravity g (m/s², sim frame). gWake is what decides waking
  // (default g): the mode passes the true gravity there when g has its shake exaggerated, so
  // hand tremor, exaggerated along with the shake, still cannot wake a sleeping box.
  step(dt, g, gWake = g) {
    this.impN = 0;
    this.passes = 0;
    const mat = this.mat;
    if (this.asleep) {
      const d = Math.hypot(gWake.x - this.gSleep.x, gWake.y - this.gSleep.y, gWake.z - this.gSleep.z);
      if (d > mat.wakeG || this._fingerNearBall()) this.wake();
      else { this._moveFingers(1); this._noteOverlap(this._measureOverlap()); return; }
    }
    const pxm = mat.pxPerM;
    const gx = g.x * pxm, gy = g.y * pxm;
    const gAbs = Math.hypot(gx, gy);
    this.relaxG.x = gx; this.relaxG.y = gy;
    const side = g.z < 0 ? -1 : 1; // which glass the balls are pressed against
    if (side !== this.side) {
      this.side = side;
      this.gPx.fill(0); this.gPy.fill(0); this.gRx.fill(0); this.gRy.fill(0); this.gS.fill(0);
    }
    const press = (Math.abs(g.z) + mat.glassBase) * pxm; // normal acceleration on the glass, px/s²

    const S = Math.max(2, Math.min(mat.maxSubsteps, Math.round(dt * mat.substepHz)));
    const hs = dt / S;
    this._setSoftness(hs);
    for (let o = 0; o < OTHERS; o++) { this.odpx[o] = 0; this.odpy[o] = 0; }

    let done = 0;
    while (done < S) {
      // How many substeps until the next collision pass: no ball (or finger) may travel more
      // than travel·rMin in between, so a ball knocked into motion mid-pass is still caught
      // by the speculative margin of its neighbours.
      const v = this._fastest();
      const reach = mat.travel * this.rMin;
      let K = mat.maxInterval;
      const perSub = (v + gAbs * hs) * hs;
      if (perSub * K > reach) K = Math.max(1, Math.floor(reach / Math.max(perSub, 1e-9)));
      if (K > S - done) K = S - done;
      const horizon = K * hs;
      this._collide(horizon, gx, gy, Math.min(v, this.vmax) + gAbs * horizon);
      this._buildSupports();
      this._chooseIterations();
      this.passes++;
      // Projection moves balls too: once any has been moved further than the margin allows
      // for, collide again before the next substep.
      let k = 0;
      while (k < K) {
        this._substep(hs, gx, gy, side, press, 1 / S);
        k++;
        if (this._projectionSpent()) break;
      }
      K = k;
      this._storeImpulses();
      this._restitution();
      this._collectImpacts();
      this._guard();
      done += K;
    }
    this._moveFingers(0);
    this._integrateOrientation(dt);
    this._sleep(dt, gWake);
    // What is drawn is the state at the frame end: if a ball ran out of projection allowance
    // in the last pass and still overlaps, clean up with position-only passes: a few for a
    // small overlap, more for a deep one (a whole pile slammed into a wall by a hard shake).
    let worst = this._measureOverlap();
    for (let r = 0; (r < mat.cleanupRounds && worst > mat.cleanupAbove) || (r < mat.cleanupDeepRounds && worst > mat.cleanupDeep); r++) {
      this._collide(0, gx, gy, 0);
      this._buildSupports();
      for (let it = 0; it < mat.projectIters; it++) this._project();
      this._projectShock();
      this._guard();
      worst = this._measureOverlap();
    }
    this._noteOverlap(worst);
  }

  _noteOverlap(worst) {
    this.lastOverlap = worst;
    if (worst > this.peakOverlap) this.peakOverlap = worst;
    if (worst > this.worstOverlap) this.worstOverlap = worst;
  }

  // Violent passes (something closing fast: a pile landing, a ball batted into the pile) get
  // extra sweeps; the impulse has further to travel than one sweep takes it. Quiet passes,
  // which are most of them, keep the base counts.
  _chooseIterations() {
    const mat = this.mat;
    let fast = 0;
    for (let c = 0; c < this.nc; c++) if (-this.crel[c] > fast) fast = -this.crel[c];
    const extra = Math.min(mat.maxExtraIters, Math.floor(fast / (mat.extraIterSpeed * mat.pxPerM)));
    this.passIters = mat.velIters + extra;
    this.passProj = mat.projectIters + extra;
  }

  _setSoftness(hs) {
    soften(this.fsoft, Math.min(this.mat.fingerHz, 0.25 / hs), this.mat.fingerZeta, hs);
  }

  _fastest() {
    let v2 = 0;
    for (let i = 0; i < this.n; i++) {
      const s = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
      if (s > v2) v2 = s;
    }
    let v = Math.sqrt(v2);
    for (let k = 0; k < MAX_FINGERS; k++) {
      if (!this.fOn[k]) continue;
      const o = WALLS + k;
      v = Math.max(v, Math.hypot(this.ovx[o], this.ovy[o]));
    }
    return v;
  }

  // Fingers finish the frame where the pointer is (the substeps swept them part way).
  _moveFingers(parked) {
    for (let k = 0; k < MAX_FINGERS; k++) {
      if (!this.fOn[k]) continue;
      const o = WALLS + k;
      if (parked) { this.ox[o] += this.oStepX[o]; this.oy[o] += this.oStepY[o]; } else {
        this.ox[o] += this.odpx[o]; this.oy[o] += this.odpy[o];
      }
      this.oStepX[o] = 0; this.oStepY[o] = 0; this.odpx[o] = 0; this.odpy[o] = 0;
      if (parked) { this.ovx[o] = 0; this.ovy[o] = 0; }
    }
  }

  _fingerNearBall() {
    for (let k = 0; k < MAX_FINGERS; k++) {
      if (!this.fOn[k]) continue;
      const o = WALLS + k;
      const fx = this.ox[o] + this.oStepX[o], fy = this.oy[o] + this.oStepY[o];
      const reach = this.fR + Math.hypot(this.oStepX[o], this.oStepY[o]) + 2;
      for (let i = 0; i < this.n; i++) {
        const dx = this.x[i] - fx, dy = this.y[i] - fy, rr = this.r[i] + reach;
        if (dx * dx + dy * dy < rr * rr) return true;
      }
    }
    return false;
  }

  _substep(hs, gx, gy, side, press, frac) {
    const n = this.n, mat = this.mat;
    const linK = 1 / (1 + hs * mat.linDamp), angK = 1 / (1 + hs * mat.angDamp);
    // Speed limits go before the solve, so the solver's answer (which keeps contacts apart)
    // is what moves the balls.
    const vmax = this.vmax, wmax = 1.5 * vmax;
    for (let i = 0; i < n; i++) {
      let vx = (this.vx[i] + gx * hs) * linK, vy = (this.vy[i] + gy * hs) * linK;
      const v2 = vx * vx + vy * vy;
      if (v2 > vmax * vmax) { const k = vmax / Math.sqrt(v2); vx *= k; vy *= k; }
      this.vx[i] = vx; this.vy[i] = vy;
      this.wx[i] *= angK; this.wy[i] *= angK; this.wz[i] *= angK;
      const wl = this.r[i] * Math.hypot(this.wx[i], this.wy[i], this.wz[i]);
      if (wl > wmax) { const k = wmax / wl; this.wx[i] *= k; this.wy[i] *= k; this.wz[i] *= k; }
    }
    this._warmStart(side);
    const invH = 1 / hs;
    for (let it = 0; it < this.passIters; it++) this._solve(invH);
    this._solveGlass(side, press * hs);
    this._shockVelocity(invH);
    for (let i = 0; i < n; i++) {
      // the solve can speed a ball up (restitution, shock): the margins assume vmax
      let vx = this.vx[i], vy = this.vy[i];
      const v2 = vx * vx + vy * vy;
      if (v2 > vmax * vmax) { const k = vmax / Math.sqrt(v2); vx *= k; vy *= k; this.vx[i] = vx; this.vy[i] = vy; }
      this.x[i] += vx * hs; this.y[i] += vy * hs;
      this.dpx[i] += vx * hs; this.dpy[i] += vy * hs;
    }
    for (let k = 0; k < MAX_FINGERS; k++) {
      if (!this.fOn[k]) continue;
      const o = WALLS + k;
      this.odpx[o] += this.oStepX[o] * frac; this.odpy[o] += this.oStepY[o] * frac;
    }
    for (let it = 0; it < this.passProj; it++) this._project();
    this._projectShock();
    this._forgetImpacts();
  }

  // Warm starting carries a contact's last impulse into the next substep: right for a resting
  // load, wrong for an impact, whose impulse, applied again, would throw the pair (and
  // everything touching it) back apart harder than one sweep can undo. Contacts that were
  // closing faster than the bounce threshold at the pass start afresh every substep.
  _forgetImpacts() {
    const thr = -this.mat.restThreshold * this.mat.pxPerM;
    for (let c = 0; c < this.nc; c++) {
      if (this.crel[c] < thr) { this.cPn[c] = 0; this.cPt[c] = 0; this.cPz[c] = 0; this.cPr[c] = 0; }
    }
  }

  _projectionSpent() {
    const pm = this.pMove, lim = 0.999 * this.pReach;
    for (let i = 0; i < this.n; i++) if (pm[i] >= lim) return true;
    return false;
  }

  // Shock propagation (after Guendelman et al. 2003), velocity half. The ordinary sweep needs
  // one pass per layer to stop a pile landing on the floor, and contacts that share a ball
  // undo each other. This sweep visits the balls in support order (see _collide: along
  // gravity, or toward the wall a moving pile is about to hit); when a ball is reached,
  // everything under it (its supports: lower balls and walls) is final, so it alone gives:
  // its velocity takes the smallest change that stops it closing on any support. One sweep
  // leaves no contact in a pile closing. Where that is impossible (a ball driven into a wall
  // by what is under it) the ball is left to the ordinary sweep. Normal only, and not
  // accumulated into the warm start: a residual clean-up (two balls meeting in the air are
  // already solved exactly by the ordinary sweep).
  _shockVelocity(invH) {
    for (let k = 0; k < this.n; k++) this._shockVel(this.order[k], invH, true);
    for (let k = this.n - 1; k >= 0; k--) this._shockVel(this.order[k], invH, false);
  }

  // One ball's shock solve. up: against its supports (lower balls, walls); otherwise against
  // what it supports (upper balls, walls): the top-down sweep, which lets a chain jammed
  // against the far wall push back into the room the pile has (one direction alone piles all
  // of a chain's overlap on its last ball).
  _shockVel(i, invH, up) {
    const n = this.n, vx = this.vx, vy = this.vy, dpx = this.dpx, dpy = this.dpy;
    const mx = this.lmx, my = this.lmy, e = this.le;
    let m = 0, any = false;
    const t0 = up ? this.supStart[i] : this.cFrom[i], t1 = up ? this.supStart[i + 1] : this.cTo[i];
    for (let t = t0; t < t1 && m < LOCAL; t++) {
      const c = up ? this.supList[t] : t;
      if (this.cfinger[c]) continue;
      const b = this.cb[c];
      let ax = this.cnx[c], ay = this.cny[c], s, lim;
      if (b >= n) { // a wall, normal toward it: -v_i·n >= -bias
        s = this.cs0[c] - dpx[i] * ax - dpy[i] * ay;
        ax = -ax; ay = -ay; lim = 0;
      } else if (up) { // supported by ball a: (v_i - v_a)·n >= -bias
        const a = this.ca[c];
        s = this.cs0[c] + (dpx[i] - dpx[a]) * ax + (dpy[i] - dpy[a]) * ay;
        lim = vx[a] * ax + vy[a] * ay;
      } else { // supporting ball b: (v_b - v_i)·n >= -bias
        s = this.cs0[c] + (dpx[b] - dpx[i]) * ax + (dpy[b] - dpy[i]) * ay;
        ax = -ax; ay = -ay; lim = vx[b] * ax + vy[b] * ay;
      }
      if (s > 0) lim -= s * invH;
      mx[m] = ax; my[m] = ay; e[m] = lim - (vx[i] * ax + vy[i] * ay);
      if (e[m] > 1e-6) any = true;
      m++;
    }
    if (!any || !minNorm(m, mx, my, e, this.lout, 1e-3)) return;
    vx[i] += this.lout[0]; vy[i] += this.lout[1];
  }

  // Shock propagation, position half: the same bottom-up sweep for overlap. Each ball takes
  // the smallest move out of all its supports (within its projection allowance), so a pile
  // pushed into itself comes back out in one sweep. (A top-down pass, as for velocities, made
  // things worse here: it pushes a ball wedged against a wall back into what holds it.)
  _projectShock() {
    const n = this.n, reach = this.pReach, pm = this.pMove;
    const slop = this.mat.projectSlop, x = this.x, y = this.y, dpx = this.dpx, dpy = this.dpy;
    const mx = this.lmx, my = this.lmy, e = this.le;
    for (let k = 0; k < n; k++) {
      const i = this.order[k];
      if (pm[i] >= reach) continue;
      let m = 0, any = false;
      for (let t = this.supStart[i], t1 = this.supStart[i + 1]; t < t1 && m < LOCAL; t++) {
        const c = this.supList[t], b = this.cb[c];
        let ax = this.cnx[c], ay = this.cny[c], s;
        if (b >= n) { s = this.cs0[c] - dpx[i] * ax - dpy[i] * ay; ax = -ax; ay = -ay; } else {
          const a = this.ca[c];
          s = this.cs0[c] + (dpx[i] - dpx[a]) * ax + (dpy[i] - dpy[a]) * ay;
        }
        mx[m] = ax; my[m] = ay; e[m] = -slop - s;
        if (e[m] > 1e-6) any = true;
        m++;
      }
      if (!any || !minNorm(m, mx, my, e, this.lout, 1e-4)) continue;
      let dx = this.lout[0], dy = this.lout[1];
      const d = Math.hypot(dx, dy);
      if (d > reach - pm[i]) { const f = (reach - pm[i]) / d; dx *= f; dy *= f; }
      x[i] += dx; y[i] += dy; dpx[i] += dx; dpy[i] += dy;
      pm[i] += Math.hypot(dx, dy);
    }
  }

  // Position projection (non-linear Gauss-Seidel): move overlapping balls apart along the
  // contact normal, by inverse mass, without touching velocities. The velocity solve leaves
  // some overlap after violent impacts and lets piles creep into themselves under load (the
  // bottom row of a 12-layer pile carries ~60 ball weights sideways); this takes it out
  // geometrically, whatever the load, and adds no energy. A ball moves at most pReach by
  // projection between collision passes (then it holds still), so the speculative margin,
  // which includes pReach, still covers every pair it can reach. Fingers are skipped: a finger
  // may overlap the balls it cannot move.
  _project() {
    const n = this.n, mat = this.mat;
    const beta = mat.projectBeta, slop = mat.projectSlop, maxC = mat.projectMax * this.rMin;
    const x = this.x, y = this.y, dpx = this.dpx, dpy = this.dpy, invM = this.invM;
    const pm = this.pMove, reach = this.pReach;
    for (let c = 0; c < this.nc; c++) {
      if (this.cfinger[c]) continue;
      const a = this.ca[c], b = this.cb[c];
      const nx = this.cnx[c], ny = this.cny[c];
      const dyn = b < n;
      const s = this.cs0[c] + ((dyn ? dpx[b] : 0) - dpx[a]) * nx + ((dyn ? dpy[b] : 0) - dpy[a]) * ny;
      if (s >= -slop) continue;
      let C = -(s + slop) * beta;
      if (C > maxC) C = maxC;
      const wa = pm[a] >= reach ? 0 : invM[a];
      const wb = dyn && pm[b] < reach ? invM[b] : 0;
      if (wa + wb === 0) continue;
      const k = C / (wa + wb);
      if (wa > 0) {
        const d = Math.min(k * wa, reach - pm[a]);
        x[a] -= nx * d; y[a] -= ny * d; dpx[a] -= nx * d; dpy[a] -= ny * d;
        pm[a] += d;
      }
      if (wb > 0) {
        const d = Math.min(k * wb, reach - pm[b]);
        x[b] += nx * d; y[b] += ny * d; dpx[b] += nx * d; dpy[b] += ny * d;
        pm[b] += d;
      }
    }
  }

  // Broadphase (uniform grid) and contact creation with speculative margins. horizon: time
  // until the next pass; vReach: the fastest any ball may move before then.
  _collide(horizon, gx, gy, vReach) {
    const n = this.n, mat = this.mat;
    const x = this.x, y = this.y, vx = this.vx, vy = this.vy, r = this.r;
    const W = this.W, H = this.H;
    // Any pair that could close within the horizon gets a contact, including pairs at rest
    // that a third ball may knock together mid-pass (hence twice the fastest speed).
    this.pReach = mat.projectReach * this.rMin;
    const margin = mat.speculative + 2 * vReach * horizon + this.pReach;
    this.nc = 0;
    for (let i = 0; i < n; i++) { this.dpx[i] = 0; this.dpy[i] = 0; this.pMove[i] = 0; }

    // Support order: lowest first along d = g·τ + mean velocity. At rest that is gravity; a
    // pile flying at a wall puts the balls nearest that wall first, whatever gravity does.
    // The ordinary sweep also runs in this order (support propagates up a pile in one sweep).
    let mvx = 0, mvy = 0;
    for (let i = 0; i < n; i++) { mvx += vx[i]; mvy += vy[i]; }
    const dX = gx * mat.shockTau + mvx / n, dY = gy * mat.shockTau + mvy / n;
    const order = this.order, key = this.key, rank = this.rank;
    for (let i = 0; i < n; i++) key[i] = -(x[i] * dX + y[i] * dY);
    for (let k = 1; k < n; k++) { // insertion sort: nearly sorted from the last pass
      const v = order[k], kv = key[v];
      let j = k - 1;
      while (j >= 0 && key[order[j]] > kv) { order[j + 1] = order[j]; j--; }
      order[j + 1] = v;
    }
    for (let k = 0; k < n; k++) rank[order[k]] = k;

    const cell = 2 * this.rMax + margin;
    const gw = Math.max(1, Math.ceil(W / cell)), gh = Math.max(1, Math.ceil(H / cell));
    const nCells = gw * gh;
    if (this.cellStart.length < nCells + 1) { this.cellStart = new Int32Array(nCells * 2 + 8); this.cursor = new Int32Array(nCells * 2 + 8); }
    const start = this.cellStart, items = this.cellItems, cellOf = this.cellOf, cursor = this.cursor;
    start.fill(0, 0, nCells + 1);
    for (let i = 0; i < n; i++) {
      const cx = clamp(Math.floor(x[i] / cell), 0, gw - 1), cy = clamp(Math.floor(y[i] / cell), 0, gh - 1);
      const c = cy * gw + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
    for (let c = 0; c < nCells; c++) cursor[c] = start[c];
    for (let i = 0; i < n; i++) items[cursor[cellOf[i]]++] = i;

    const hg = 0.5 * horizon * horizon;
    const wallM = mat.speculative + vReach * horizon + this.pReach;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      this.cFrom[i] = this.nc; // contacts where i is the lower ball (and its walls) are [cFrom, cTo)
      const ri = r[i], xi = x[i], yi = y[i], vxi = vx[i], vyi = vy[i];
      // walls: normal from the ball toward the wall; relative normal velocity of wall minus ball
      if (xi - ri < wallM + Math.max(0, -gx) * hg) this._addContact(i, n + 0, -1, 0, xi - ri, vxi);
      if (W - xi - ri < wallM + Math.max(0, gx) * hg) this._addContact(i, n + 1, 1, 0, W - xi - ri, -vxi);
      if (yi - ri < wallM + Math.max(0, -gy) * hg) this._addContact(i, n + 2, 0, -1, yi - ri, vyi);
      if (H - yi - ri < wallM + Math.max(0, gy) * hg) this._addContact(i, n + 3, 0, 1, H - yi - ri, -vyi);

      for (let f = 0; f < MAX_FINGERS; f++) {
        if (!this.fOn[f]) continue;
        const o = WALLS + f;
        const dx = this.ox[o] - xi, dy = this.oy[o] - yi;
        const d = Math.hypot(dx, dy);
        const gap = d - ri - this.fR;
        if (gap > Math.hypot(this.oStepX[o], this.oStepY[o]) + margin) continue;
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : 1;
        const vn = (this.ovx[o] - vxi) * nx + (this.ovy[o] - vyi) * ny;
        this._addContact(i, n + o, nx, ny, gap, vn);
      }

      const c = cellOf[i];
      const cx = c % gw, cy = (c - cx) / gw;
      const y0 = Math.max(0, cy - 1), y1 = Math.min(gh - 1, cy + 1);
      const x0 = Math.max(0, cx - 1), x1 = Math.min(gw - 1, cx + 1);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const cc = yy * gw + xx;
          for (let t = start[cc], te = start[cc + 1]; t < te; t++) {
            const j = items[t];
            if (rank[j] <= k) continue; // each pair once, from its lower ball
            const dx = x[j] - xi, dy = y[j] - yi;
            const R = ri + r[j];
            const lim = R + margin;
            const d2 = dx * dx + dy * dy;
            if (d2 > lim * lim) continue;
            const d = Math.sqrt(d2);
            const nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : 1;
            const vn = (vx[j] - vxi) * nx + (vy[j] - vyi) * ny;
            this._addContact(i, j, nx, ny, d - R, vn);
          }
        }
      }
      this.cTo[i] = this.nc;
    }
  }

  // Each ball's supports, for the shock sweeps: contacts where it is the upper ball, and its
  // walls. Fingers are not supports (they are soft and limited).
  _buildSupports() {
    const n = this.n, sup = this.supStart, cur = this.supCur;
    if (this.supList.length < this.nc) this.supList = new Int32Array(this.cap);
    const list = this.supList;
    sup.fill(0);
    for (let c = 0; c < this.nc; c++) {
      if (this.cfinger[c]) continue;
      const b = this.cb[c];
      sup[(b < n ? b : this.ca[c]) + 1]++;
    }
    for (let i = 0; i < n; i++) sup[i + 1] += sup[i];
    for (let i = 0; i < n; i++) cur[i] = sup[i];
    for (let c = 0; c < this.nc; c++) {
      if (this.cfinger[c]) continue;
      const b = this.cb[c];
      list[cur[b < n ? b : this.ca[c]]++] = c;
    }
  }

  _addContact(a, b, nx, ny, s0, vn) {
    if (this.nc >= this.cap) { this.dropped++; return; }
    const c = this.nc++;
    const n = this.n, mat = this.mat;
    const ra = this.r[a];
    const invMa = this.invM[a], invIa = this.invI[a];
    let rb = 0, invMb = 0, invIb = 0, mu, e, rr, lim = Infinity, finger = 0;
    if (b < n) {
      rb = this.r[b]; invMb = this.invM[b]; invIb = this.invI[b];
      mu = mat.friction; e = mat.restitution;
      rr = mat.rollRes * Math.min(ra, rb);
    } else if (b - n < WALLS) {
      mu = mat.wallFriction; e = mat.wallRestitution; rr = mat.rollRes * ra;
    } else {
      mu = mat.fingerFriction; e = mat.fingerRestitution; rr = 0; finger = 1;
      lim = this.m[a] * mat.fingerAccel * mat.pxPerM / mat.substepHz;
    }
    this.ca[c] = a; this.cb[c] = b; this.cfinger[c] = finger;
    this.cnx[c] = nx; this.cny[c] = ny; this.cs0[c] = s0; this.crel[c] = vn;
    this.cra[c] = ra; this.crb[c] = rb; // a static body's arm does not matter
    this.cmn[c] = 1 / (invMa + invMb);
    const rb2 = rb * rb * invIb;
    this.cmt[c] = 1 / (invMa + invMb + ra * ra * invIa + rb2);
    this.cmz[c] = 1 / (ra * ra * invIa + rb2);
    this.cmr[c] = 1 / (invIa + invIb);
    this.cmu[c] = mu; this.ce[c] = e; this.crr[c] = rr; this.cLim[c] = lim;
    this.cMax[c] = 0;
    // warm start from the same pair last pass
    let pn = 0, pt = 0, pz = 0, pr = 0;
    const base = a * WS, cnt = this.wsN[a];
    for (let k = 0; k < cnt; k++) {
      if (this.wsB[base + k] === b) { pn = this.wsPn[base + k]; pt = this.wsPt[base + k]; pz = this.wsPz[base + k]; pr = this.wsPr[base + k]; break; }
    }
    this.cPn[c] = Math.min(pn, lim); this.cPt[c] = pt; this.cPz[c] = pz; this.cPr[c] = pr;
  }

  _warmStart(side) {
    const n = this.n;
    const vx = this.vx, vy = this.vy, wx = this.wx, wy = this.wy, wz = this.wz, invM = this.invM, invI = this.invI;
    for (let c = 0; c < this.nc; c++) {
      const a = this.ca[c], b = this.cb[c];
      const nx = this.cnx[c], ny = this.cny[c];
      const pn = this.cPn[c], pt = this.cPt[c], pz = this.cPz[c], pr = this.cPr[c];
      const px = pn * nx - pt * ny, py = pn * ny + pt * nx; // t = (-ny, nx)
      const ra = this.cra[c];
      vx[a] -= px * invM[a]; vy[a] -= py * invM[a];
      wz[a] -= (pt * ra + pr) * invI[a];
      wx[a] -= ra * pz * ny * invI[a]; wy[a] += ra * pz * nx * invI[a];
      if (b < n) {
        const rb = this.crb[c];
        vx[b] += px * invM[b]; vy[b] += py * invM[b];
        wz[b] += (pr - pt * rb) * invI[b];
        wx[b] -= rb * pz * ny * invI[b]; wy[b] += rb * pz * nx * invI[b];
      }
    }
    for (let i = 0; i < n; i++) {
      const r = this.r[i], iM = invM[i], iI = invI[i];
      const px = this.gPx[i], py = this.gPy[i];
      vx[i] += px * iM; vy[i] += py * iM;
      wx[i] += (-side * r * py + this.gRx[i]) * iI;
      wy[i] += (side * r * px + this.gRy[i]) * iI;
      wz[i] += this.gS[i] * iI;
    }
  }

  // One Gauss-Seidel pass over the contacts: normal, friction with spin, twist, rolling
  // resistance. Ball and wall contacts are hard: they only stop approach (vn >= 0) and leave
  // overlap to _project. The finger is a soft (Box2D v3 style) and force-limited contact: it
  // pushes balls out of its way at a bounded rate and gives way to a jammed pile.
  _solve(invH) {
    const n = this.n, mat = this.mat;
    const vx = this.vx, vy = this.vy, wx = this.wx, wy = this.wy, wz = this.wz, invM = this.invM, invI = this.invI;
    const dpx = this.dpx, dpy = this.dpy;
    const maxPush = mat.maxPush;
    const fsoft = this.fsoft;
    for (let c = 0; c < this.nc; c++) {
      const a = this.ca[c], b = this.cb[c];
      const nx = this.cnx[c], ny = this.cny[c], tx = -ny, ty = nx;
      const ra = this.cra[c], rb = this.crb[c];
      const iMa = invM[a], iIa = invI[a];
      let vbx, vby, wbx = 0, wby = 0, wbz = 0, dbx, dby, iMb = 0, iIb = 0;
      const dyn = b < n;
      if (dyn) { vbx = vx[b]; vby = vy[b]; wbx = wx[b]; wby = wy[b]; wbz = wz[b]; dbx = dpx[b]; dby = dpy[b]; iMb = invM[b]; iIb = invI[b]; } else {
        const o = b - n; vbx = this.ovx[o]; vby = this.ovy[o]; dbx = this.odpx[o]; dby = this.odpy[o];
      }
      let vax = vx[a], vay = vy[a], wax = wx[a], way = wy[a], waz = wz[a];

      // normal: separation now, from the separation at the pass and the motion since
      const s = this.cs0[c] + (dbx - dpx[a]) * nx + (dby - dpy[a]) * ny;
      let bias = 0, mScale = 1, iScale = 0;
      if (s > 0) bias = s * invH; // speculative: may close the gap, no more
      else if (this.cfinger[c]) {
        bias = Math.max(fsoft.biasRate * s, -maxPush); mScale = fsoft.massScale; iScale = fsoft.impulseScale;
      }
      const vn = (vbx - vax) * nx + (vby - vay) * ny;
      let imp = -this.cmn[c] * mScale * (vn + bias) - iScale * this.cPn[c];
      const pn = clamp(this.cPn[c] + imp, 0, this.cLim[c]);
      imp = pn - this.cPn[c];
      this.cPn[c] = pn;
      if (pn > this.cMax[c]) this.cMax[c] = pn;
      vax -= imp * nx * iMa; vay -= imp * ny * iMa; vbx += imp * nx * iMb; vby += imp * ny * iMb;

      // in-plane friction, with spin about z
      const lim = this.cmu[c] * pn;
      const vt = (vbx - vax) * tx + (vby - vay) * ty - wbz * rb - waz * ra;
      let it = -this.cmt[c] * vt;
      const pt = clamp(this.cPt[c] + it, -lim, lim);
      it = pt - this.cPt[c];
      this.cPt[c] = pt;
      vax -= it * tx * iMa; vay -= it * ty * iMa; vbx += it * tx * iMb; vby += it * ty * iMb;
      waz -= it * ra * iIa; wbz -= it * rb * iIb;

      // twist: friction along z at the contact, against spin about in-plane axes
      const vz = -rb * (wbx * ny - wby * nx) - ra * (wax * ny - way * nx);
      let iz = -this.cmz[c] * vz;
      const pz = clamp(this.cPz[c] + iz, -lim, lim);
      iz = pz - this.cPz[c];
      this.cPz[c] = pz;
      wax -= ra * iz * ny * iIa; way += ra * iz * nx * iIa;
      wbx -= rb * iz * ny * iIb; wby += rb * iz * nx * iIb;

      // rolling resistance about z
      const rl = this.crr[c] * pn;
      if (rl > 0) {
        let ir = -this.cmr[c] * (wbz - waz);
        const pr = clamp(this.cPr[c] + ir, -rl, rl);
        ir = pr - this.cPr[c];
        this.cPr[c] = pr;
        waz -= ir * iIa; wbz += ir * iIb;
      }

      vx[a] = vax; vy[a] = vay; wx[a] = wax; wy[a] = way; wz[a] = waz;
      if (dyn) { vx[b] = vbx; vy[b] = vby; wx[b] = wbx; wy[b] = wby; wz[b] = wbz; }
    }

  }

  // The glass: friction at the point pressed against it, rolling and spinning resistance.
  // Once per substep (it couples each ball only with itself). pressH: normal impulse per unit
  // mass this substep.
  _solveGlass(side, pressH) {
    const n = this.n, mat = this.mat;
    const vx = this.vx, vy = this.vy, wx = this.wx, wy = this.wy, wz = this.wz, invM = this.invM, invI = this.invI;
    const mu = mat.glassFriction, crr = mat.glassRollRes, cs = mat.glassSpin;
    for (let i = 0; i < n; i++) {
      const r = this.r[i], m = this.m[i], iM = invM[i], iI = invI[i];
      const N = m * pressH; // normal impulse this substep
      const I = 1 / iI;
      let px = this.gPx[i], py = this.gPy[i];
      const ux = vx[i] + side * wy[i] * r, uy = vy[i] - side * wx[i] * r;
      const mg = 1 / (iM + r * r * iI);
      let nx = px - mg * ux, ny = py - mg * uy;
      const lim = mu * N, l2 = nx * nx + ny * ny;
      if (l2 > lim * lim) { const k = lim / Math.sqrt(l2); nx *= k; ny *= k; }
      const dx = nx - px, dy = ny - py;
      this.gPx[i] = nx; this.gPy[i] = ny;
      vx[i] += dx * iM; vy[i] += dy * iM;
      wx[i] -= side * r * dy * iI; wy[i] += side * r * dx * iI;

      // rolling resistance: an angular impulse against (wx, wy), at most crr * r * N
      px = this.gRx[i]; py = this.gRy[i];
      nx = px - I * wx[i]; ny = py - I * wy[i];
      const rlim = crr * r * N, r2 = nx * nx + ny * ny;
      if (r2 > rlim * rlim) { const k = rlim / Math.sqrt(r2); nx *= k; ny *= k; }
      wx[i] += (nx - px) * iI; wy[i] += (ny - py) * iI;
      this.gRx[i] = nx; this.gRy[i] = ny;

      // spinning (drilling) resistance about z
      const slim = cs * r * N;
      const sp = clamp(this.gS[i] - I * wz[i], -slim, slim);
      wz[i] += (sp - this.gS[i]) * iI;
      this.gS[i] = sp;
    }
  }

  // Bounce: contacts that were closing fast at the pass and did push get their normal speed
  // reversed, times restitution. Not added to the warm-start impulse (that is the resting
  // load, which a bounce must not carry into the next pass).
  _restitution() {
    const n = this.n, mat = this.mat;
    const thr = mat.restThreshold * mat.pxPerM;
    const vx = this.vx, vy = this.vy, invM = this.invM;
    for (let c = 0; c < this.nc; c++) {
      const rel = this.crel[c];
      if (rel > -thr || this.cMax[c] === 0) continue;
      const a = this.ca[c], b = this.cb[c];
      const nx = this.cnx[c], ny = this.cny[c];
      const dyn = b < n;
      const vbx = dyn ? vx[b] : this.ovx[b - n], vby = dyn ? vy[b] : this.ovy[b - n];
      const vn = (vbx - vx[a]) * nx + (vby - vy[a]) * ny;
      const target = -this.ce[c] * rel;
      if (vn >= target) continue;
      const imp = -this.cmn[c] * (vn - target);
      vx[a] -= imp * nx * invM[a]; vy[a] -= imp * ny * invM[a];
      if (dyn) { vx[b] += imp * nx * invM[b]; vy[b] += imp * ny * invM[b]; }
    }
  }

  _storeImpulses() {
    this.wsN.fill(0);
    for (let c = 0; c < this.nc; c++) {
      const a = this.ca[c];
      const k = this.wsN[a];
      if (k >= WS) continue;
      const s = a * WS + k;
      this.wsB[s] = this.cb[c];
      this.wsPn[s] = this.cPn[c]; this.wsPt[s] = this.cPt[c]; this.wsPz[s] = this.cPz[c]; this.wsPr[s] = this.cPr[c];
      this.wsN[a] = k + 1;
    }
  }

  // Impacts: contacts that were closing fast at the pass and did touch.
  _collectImpacts() {
    const mat = this.mat, n = this.n;
    const v0 = mat.soundMin * mat.pxPerM, v1 = mat.soundFull * mat.pxPerM;
    for (let c = 0; c < this.nc; c++) {
      const sp = -this.crel[c];
      if (sp < v0 || this.cMax[c] === 0) continue;
      const a = this.ca[c], b = this.cb[c];
      if (this.cfinger[c]) continue; // the finger is silent
      const wall = b >= n;
      // heavier hits are louder: scale by the reduced mass, relative to two mean balls
      const mr = wall ? this.m[a] : (2 * this.m[a] * this.m[b]) / (this.m[a] + this.m[b]);
      let I = Math.min(1, (sp - v0) / (v1 - v0)) * Math.min(1.4, Math.pow(mr, 0.3));
      I = Math.min(1, Math.sqrt(Math.max(0, I)));
      const rr = wall ? this.r[a] : Math.min(this.r[a], this.r[b]);
      this._pushImpact(I, rr, wall);
    }
  }

  _pushImpact(I, r, wall) {
    let k = this.impN;
    if (k < TOP_IMPACTS) this.impN++;
    else if (I <= this.impI[TOP_IMPACTS - 1]) return;
    else k = TOP_IMPACTS - 1;
    while (k > 0 && this.impI[k - 1] < I) {
      this.impI[k] = this.impI[k - 1]; this.impR[k] = this.impR[k - 1]; this.impWall[k] = this.impWall[k - 1];
      k--;
    }
    this.impI[k] = I; this.impR[k] = r; this.impWall[k] = wall ? 1 : 0;
  }

  // Last line of defence after each pass: finite state, inside the walls. The contacts did
  // the real work; this only catches what they could not (it should not fire in practice).
  _guard() {
    const n = this.n, W = this.W, H = this.H;
    for (let i = 0; i < n; i++) {
      const r = this.r[i];
      let x = this.x[i], y = this.y[i];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(this.vx[i]) && Number.isFinite(this.vy[i]) &&
        Number.isFinite(this.wx[i]) && Number.isFinite(this.wy[i]) && Number.isFinite(this.wz[i]))) {
        this._repair(i);
        continue;
      }
      if (x < r) { x = r; if (this.vx[i] < 0) this.vx[i] = 0; } else if (x > W - r) { x = W - r; if (this.vx[i] > 0) this.vx[i] = 0; }
      if (y < r) { y = r; if (this.vy[i] < 0) this.vy[i] = 0; } else if (y > H - r) { y = H - r; if (this.vy[i] > 0) this.vy[i] = 0; }
      this.x[i] = x; this.y[i] = y;
    }
  }

  _repair(i) {
    this.repairs++;
    this.x[i] = this.W * 0.5; this.y[i] = this.r[i];
    this.vx[i] = 0; this.vy[i] = 0; this.wx[i] = 0; this.wy[i] = 0; this.wz[i] = 0;
    this.gPx[i] = 0; this.gPy[i] = 0; this.gRx[i] = 0; this.gRy[i] = 0; this.gS[i] = 0;
    this.wsN[i] = 0;
    const o = i * 4;
    this.q[o] = 0; this.q[o + 1] = 0; this.q[o + 2] = 0; this.q[o + 3] = 1;
  }

  _integrateOrientation(dt) {
    const q = this.q;
    for (let i = 0; i < this.n; i++) {
      const ax = this.wx[i], ay = this.wy[i], az = this.wz[i];
      const w = Math.hypot(ax, ay, az);
      if (w * dt < 1e-7) continue;
      const half = 0.5 * w * dt, s = Math.sin(half) / w, c = Math.cos(half);
      const dx = ax * s, dy = ay * s, dz = az * s, dw = c; // dq, applied on the left (world frame)
      const o = i * 4;
      const qx = q[o], qy = q[o + 1], qz = q[o + 2], qw = q[o + 3];
      let nx = dw * qx + dx * qw + dy * qz - dz * qy;
      let ny = dw * qy - dx * qz + dy * qw + dz * qx;
      let nz = dw * qz + dx * qy - dy * qx + dz * qw;
      let nw = dw * qw - dx * qx - dy * qy - dz * qz;
      const l = 1 / Math.hypot(nx, ny, nz, nw);
      nx *= l; ny *= l; nz *= l; nw *= l;
      if (!Number.isFinite(l)) { nx = 0; ny = 0; nz = 0; nw = 1; }
      q[o] = nx; q[o + 1] = ny; q[o + 2] = nz; q[o + 3] = nw;
    }
  }

  // Sleep when every ball has been slow for mat.sleepTime: then nothing moves at all.
  _sleep(dt, g) {
    const mat = this.mat;
    const vs = mat.sleepSpeed, vs2 = vs * vs;
    let all = true;
    for (let i = 0; i < this.n; i++) {
      const r = this.r[i];
      const v2 = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
      const w2 = (this.wx[i] * this.wx[i] + this.wy[i] * this.wy[i] + this.wz[i] * this.wz[i]) * r * r;
      if (v2 < vs2 && w2 < vs2) this.slowT[i] += dt; else this.slowT[i] = 0;
      if (this.slowT[i] < mat.sleepTime) all = false;
    }
    if (all && !this._fingerNearBall()) {
      this.asleep = true;
      this.vx.fill(0); this.vy.fill(0); this.wx.fill(0); this.wy.fill(0); this.wz.fill(0);
      this.gSleep.x = g.x; this.gSleep.y = g.y; this.gSleep.z = g.z;
    }
  }

  // Deepest ball-ball penetration at this frame's end, as a fraction of the smaller radius,
  // over every pair (its own grid: the last pass's contacts may miss a pair that met since).
  _measureOverlap() {
    const n = this.n, x = this.x, y = this.y, r = this.r;
    const cell = 2 * this.rMax + 1;
    const gw = Math.max(1, Math.ceil(this.W / cell)), gh = Math.max(1, Math.ceil(this.H / cell));
    const nCells = gw * gh;
    if (this.cellStart.length < nCells + 1) { this.cellStart = new Int32Array(nCells * 2 + 8); this.cursor = new Int32Array(nCells * 2 + 8); }
    const start = this.cellStart, items = this.cellItems, cellOf = this.cellOf, cursor = this.cursor;
    start.fill(0, 0, nCells + 1);
    for (let i = 0; i < n; i++) {
      const c = clamp(Math.floor(y[i] / cell), 0, gh - 1) * gw + clamp(Math.floor(x[i] / cell), 0, gw - 1);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
    for (let c = 0; c < nCells; c++) cursor[c] = start[c];
    for (let i = 0; i < n; i++) items[cursor[cellOf[i]]++] = i;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i], cx = c % gw, cy = (c - cx) / gw;
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(gh - 1, cy + 1); yy++) {
        for (let xx = Math.max(0, cx - 1); xx <= Math.min(gw - 1, cx + 1); xx++) {
          const cc = yy * gw + xx;
          for (let t = start[cc], te = start[cc + 1]; t < te; t++) {
            const j = items[t];
            if (j <= i) continue;
            const R = r[i] + r[j];
            const dx = x[j] - x[i], dy = y[j] - y[i], d2 = dx * dx + dy * dy;
            if (d2 >= R * R) continue;
            const pen = (R - Math.sqrt(d2)) / Math.min(r[i], r[j]);
            if (pen > worst) worst = pen;
          }
        }
      }
    }
    return worst;
  }

  // Cheap numbers for stats(). maxOverlap: the deepest penetration at any frame end since the
  // last call, as a fraction of the smaller radius (so a test sampling every 30 frames still
  // sees every frame).
  measure() {
    const n = this.n, W = this.W, H = this.H, pxm = this.mat.pxPerM;
    let nan = false, outside = 0, ke = 0, vmax = 0;
    for (let i = 0; i < n; i++) {
      const x = this.x[i], y = this.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(this.vx[i]) || !Number.isFinite(this.vy[i])) { nan = true; continue; }
      if (x < 0 || x > W || y < 0 || y > H) outside++;
      const v2 = (this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i]) / (pxm * pxm);
      ke += 0.5 * this.m[i] * v2;
      vmax = Math.max(vmax, Math.sqrt(v2));
    }
    const maxOverlap = this.peakOverlap;
    this.peakOverlap = this.lastOverlap;
    return { nan, outside, kinetic: ke, maxSpeed: vmax, maxOverlap, worstOverlap: this.worstOverlap, contacts: this.nc, passes: this.passes, repairs: this.repairs, dropped: this.dropped };
  }
}

// Box2D v3 soft constraint coefficients for stiffness hz, damping ratio zeta, substep h.
function soften(out, hz, zeta, h) {
  const omega = 2 * Math.PI * hz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  out.biasRate = omega / a1;
  out.massScale = a2 * a3;
  out.impulseScale = a3;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function randomQuat(rand, q, o) {
  // uniform random rotation (Shoemake)
  const u1 = rand(), u2 = rand() * 2 * Math.PI, u3 = rand() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  q[o] = a * Math.sin(u2); q[o + 1] = a * Math.cos(u2); q[o + 2] = b * Math.sin(u3); q[o + 3] = b * Math.cos(u3);
}

// Smallest d (in 2D) with m_j·d >= e_j for all j (|m_j| = 1): a ball's least velocity change or
// move that satisfies all its supports. The optimum has at most two active constraints, so
// try each single and each pair and keep the smallest feasible. False if none is feasible, or
// if the answer is more than 3x the worst violation: that is a ball wedged between supports
// that nearly face each other, which only a squeeze-out at a silly speed would satisfy.
function minNorm(m, mx, my, e, out, tol) {
  let emax = 0;
  for (let j = 0; j < m; j++) if (e[j] > emax) emax = e[j];
  let best = 9 * emax * emax + tol, bx = 0, by = 0, found = false;
  for (let j = 0; j < m; j++) {
    if (e[j] <= 0) continue;
    const dx = e[j] * mx[j], dy = e[j] * my[j], q = dx * dx + dy * dy;
    if (q < best && feasible(m, mx, my, e, dx, dy, tol)) { best = q; bx = dx; by = dy; found = true; }
  }
  for (let j = 0; j < m; j++) {
    for (let k = j + 1; k < m; k++) {
      if (e[j] <= 0 && e[k] <= 0) continue;
      const det = mx[j] * my[k] - my[j] * mx[k];
      if (Math.abs(det) < 1e-6) continue;
      const dx = (e[j] * my[k] - e[k] * my[j]) / det, dy = (mx[j] * e[k] - mx[k] * e[j]) / det;
      const q = dx * dx + dy * dy;
      if (q < best && feasible(m, mx, my, e, dx, dy, tol)) { best = q; bx = dx; by = dy; found = true; }
    }
  }
  if (!found) return false;
  out[0] = bx; out[1] = by;
  return true;
}

function feasible(m, mx, my, e, dx, dy, tol) {
  for (let k = 0; k < m; k++) if (mx[k] * dx + my[k] * dy < e[k] - tol) return false;
  return true;
}
