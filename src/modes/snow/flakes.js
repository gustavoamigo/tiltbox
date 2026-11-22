// Snow and glitter flakes. Airborne flakes are carried by the liquid (strong drag toward its local
// velocity: the resolved flow's stream-function velocity plus the sub-grid turbulence) and sink
// slowly along the in-plane gravity at their terminal velocity, fluttering sideways as flat flakes
// do. Resting flakes sit on a fine occupancy grid (2 px cells, one flake per cell) together with
// the scene and a one-cell ring for the glass walls:
//   - a flake lands when it bumps into something "below" it (the 8-neighbour nearest to the
//     smoothed gravity) and the liquid is calm enough; it topples off a free diagonal first unless
//     it sticks (so piles keep to about 45°);
//   - it wakes when that support goes (the globe tipped, the flake under it left) or when the
//     liquid over it churns fast enough to pick it up, and then it is flung clear of the pile;
//   - while the liquid churns too hard for anything to settle, the flow cannot push flakes into
//     surfaces and eddies sweep them off, so they do not gather in films and nooks.
// Positions are sim px, velocities sim px/s, gravity m/s². Nothing allocates per step.

const G = 9.81;
const CELL = 2; // rest-grid cell, sim px: a flake lying flat, packed (it is drawn larger)
const G_HOLD = 2.0; // in-plane g below this (phone flat): resting flakes stay put on the back glass
const HYST = (10 * Math.PI) / 180; // "down" changes only past the 22.5° bisector by this much
const U_LIFT = 60; // liquid speed (px/s) that starts picking resting flakes up ...
const U_LAND = 45; // ... and below which a flake can settle (hysteresis)
const LIFT_RATE = 5; // 1/s per unit of excess speed ratio
const TAU = [0.07, 0.1]; // drag time toward the liquid velocity, s: snow, glitter (denser)
const LAUNCH = 800; // px/s: a flake flung off the pile by a full shake ...
const LAUNCH_REF = 250; // ... which is this much turbulence (rms px/s)
const FREE_T = 0.35; // s of free flight after being flung
const TAU_FREE = 0.35; // drag time during it, s
const EJECT = 0.9; // churning flakes are swept off surfaces at this share of the turbulence
const STICK = 0.12; // chance a landing flake stays put although a diagonal below is free
const SLIDE_V = 45; // px/s, a flake rolling off a pile
const MAX_SUB = 40; // VMAX / 30 fps in steps of under a cell
const VMAX = 1600; // px/s
const AIR0 = 0.16; // share of flakes still falling in the starting state: a gentle snowfall

// The 8 neighbours, by angle from straight down (+y) toward +x, 45° apart.
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [1, 1, 0, -1, -1, -1, 0, 1];

export class Flakes {
  constructor(n, glitterFrac, rng) {
    this.n = n;
    this.rng = rng;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.rad = new Float32Array(n); // px
    this.ws = new Float32Array(n); // terminal sinking speed at 1 g, px/s
    this.ph = new Float32Array(n); // flutter phase
    this.phw = new Float32Array(n); // flutter rate, rad/s
    this.spin = new Float32Array(n); // glitter turn angle
    this.spinw = new Float32Array(n); // rad/s while airborne
    this.free = new Float32Array(n); // s of free flight left after being flung off the pile
    this.facet = new Float32Array(n); // glitter facet orientation
    this.depth = new Float32Array(n); // 0 back glass .. 1 front glass (drawing only)
    this.tone = new Float32Array(n); // smoothed exposure of a resting flake, for shading
    this.kind = new Uint8Array(n); // 0 snow, 1..4 glitter colour
    this.cell = new Int32Array(n).fill(-1); // rest cell, -1 while airborne
    this.resting = 0;
    this.kDown = 0;
    this.W = 0;
    this.H = 0;
    this.off = new Int32Array(8);
    for (let i = 0; i < n; i++) {
      this.ph[i] = rng() * Math.PI * 2;
      this.phw[i] = 1.2 + 2.2 * rng();
      this.depth[i] = rng();
      this.tone[i] = 1;
      if (rng() < glitterFrac) {
        this.kind[i] = 1 + Math.floor(rng() * 4);
        this.rad[i] = 1.0 + 1.0 * rng();
        this.ws[i] = 30 + 22 * rng();
        this.facet[i] = rng() * Math.PI * 2;
        this.spinw[i] = (2.5 + 6 * rng()) * (rng() < 0.5 ? -1 : 1);
      } else {
        this.rad[i] = 1.2 + 2.1 * Math.pow(rng(), 1.4);
        // Bigger flakes sink faster; one in 25 is nearly neutrally buoyant and drifts for minutes.
        this.ws[i] = rng() < 0.04 ? 4 + 5 * rng() : 6 + 8 * this.rad[i] + 7 * rng();
      }
    }
  }

  // A new box: build the rest grid. solidAt(x, y) -> true inside the scene.
  setBox(W, H, solidAt) {
    this.W = W;
    this.H = H;
    const RW = Math.max(8, Math.round(W / CELL));
    const RH = Math.max(8, Math.round(H / CELL));
    this.RW = RW;
    this.RH = RH;
    this.cw = W / RW;
    this.ch = H / RH;
    this.icw = 1 / this.cw;
    this.ich = 1 / this.ch;
    // 0 free, 1 solid (scene or the wall ring), 2 a resting flake
    const st = (this.st = new Uint8Array(RW * RH));
    for (let j = 0; j < RH; j++) {
      for (let i = 0; i < RW; i++) {
        const ring = i === 0 || j === 0 || i === RW - 1 || j === RH - 1;
        st[j * RW + i] = ring || solidAt((i + 0.5) * this.cw, (j + 0.5) * this.ch) ? 1 : 0;
      }
    }
    this.solidOnly = st.slice();
    for (let k = 0; k < 8; k++) this.off[k] = DY[k] * RW + DX[k];
    this.xmin = this.cw * 1.001;
    this.xmax = W - this.cw * 1.001;
    this.ymin = this.ch * 1.001;
    this.ymax = H - this.ch * 1.001;
  }

  cellAt(x, y) {
    let i = (x * this.icw) | 0, j = (y * this.ich) | 0;
    if (i < 0) i = 0; else if (i >= this.RW) i = this.RW - 1;
    if (j < 0) j = 0; else if (j >= this.RH) j = this.RH - 1;
    return j * this.RW + i;
  }

  // The starting state: snow fallen straight down onto the scene, a few flakes still in the air.
  fill() {
    const { n, rng } = this;
    this.kDown = 0;
    this.st.set(this.solidOnly);
    this.resting = 0;
    this.cell.fill(-1);
    const nAir = Math.round(n * AIR0);
    for (let i = 0; i < n; i++) {
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.spin[i] = rng() * Math.PI * 2;
      this.x[i] = this.xmin + rng() * (this.xmax - this.xmin);
      if (i < n - nAir) {
        this.y[i] = this.ymin;
        if (this._deposit(i)) continue;
      }
      this._placeAirborne(i);
    }
  }

  // After setBox() for a new size: scale everyone into the new box and let the snow that was
  // resting fall onto the new scene from where it now is. Keeps the contents, never resets them.
  refit(oldW, oldH) {
    const sx = this.W / oldW, sy = this.H / oldH;
    const wasResting = this.cell;
    this.resting = 0;
    for (let i = 0; i < this.n; i++) {
      this.x[i] = Math.min(this.xmax, Math.max(this.xmin, this.x[i] * sx));
      this.y[i] = Math.min(this.ymax, Math.max(this.ymin, this.y[i] * sy));
    }
    for (let i = 0; i < this.n; i++) {
      if (wasResting[i] < 0) continue;
      wasResting[i] = -1;
      if (!this._deposit(i)) this._placeAirborne(i);
    }
    for (let i = 0; i < this.n; i++) {
      if (this.cell[i] >= 0) continue;
      if (this.st[this.cellAt(this.x[i], this.y[i])] !== 0) this._climbOut(i);
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
  }

  // Let flake i fall from where it is along "down" to the first support, slide off free
  // diagonals the way a landing flake would, and rest there. False if there is no room.
  _deposit(i) {
    const st = this.st, off = this.off, rng = this.rng;
    let c = this.cellAt(this.x[i], this.y[i]);
    const kd = this.kDown;
    const up = off[(kd + 4) & 7];
    for (let t = 0; st[c] !== 0; t++) { // start inside something: climb out against gravity
      if (t > this.RW + this.RH) return false;
      const nc = c + up;
      if (nc < 0 || nc >= st.length) return false;
      c = nc;
    }
    const down = off[kd];
    for (let guard = 0; guard < 400; guard++) {
      while (st[c + down] === 0) c += down;
      const k1 = rng() < 0.5 ? (kd + 1) & 7 : (kd + 7) & 7;
      const k2 = k1 === ((kd + 1) & 7) ? (kd + 7) & 7 : (kd + 1) & 7;
      const s = this._slideTo(c, kd, k1) || this._slideTo(c, kd, k2);
      if (s && rng() > STICK) { c = s; continue; }
      break;
    }
    this._rest(i, c, kd);
    return true;
  }

  // Cell reached by sliding from c in direction k (a neighbour of down kd), or 0 if blocked.
  _slideTo(c, kd, k) {
    const st = this.st, off = this.off;
    const t = c + off[k];
    if (st[t] !== 0) return 0;
    if ((kd & 1) === 0) { // down is axial, so k is diagonal: the side cell must be open too
      const side = k === ((kd + 1) & 7) ? (kd + 2) & 7 : (kd + 6) & 7;
      if (st[c + off[side]] !== 0) return 0;
    }
    return t;
  }

  _rest(i, c, kd) {
    this.st[c] = 2;
    this.cell[i] = c;
    this.resting++;
    this.vx[i] = 0;
    this.vy[i] = 0;
    // Sit in the part of the cell nearest the support, so piles have no gaps.
    const ci = c % this.RW, cj = (c - ci) / this.RW;
    if (DX[kd] !== 0) this.x[i] = (ci + 0.5 + 0.3 * DX[kd]) * this.cw;
    else this.x[i] = Math.min((ci + 0.95) * this.cw, Math.max((ci + 0.05) * this.cw, this.x[i]));
    if (DY[kd] !== 0) this.y[i] = (cj + 0.5 + 0.3 * DY[kd]) * this.ch;
    else this.y[i] = Math.min((cj + 0.95) * this.ch, Math.max((cj + 0.05) * this.ch, this.y[i]));
  }

  _wake(i) {
    this.st[this.cell[i]] = 0;
    this.cell[i] = -1;
    this.resting--;
  }

  _placeAirborne(i) {
    const { rng } = this;
    for (let t = 0; t < 60; t++) {
      const x = this.xmin + rng() * (this.xmax - this.xmin);
      const y = this.ymin + rng() * (this.ymax - this.ymin) * 0.85;
      if (this.st[this.cellAt(x, y)] === 0) { this.x[i] = x; this.y[i] = y; return; }
    }
    this.x[i] = this.W * 0.5;
    this.y[i] = this.ymin;
    this._climbOut(i);
  }

  // An airborne flake inside something (resize, a neighbour landed in its cell): move it out
  // against gravity, or anywhere free.
  _climbOut(i) {
    const st = this.st;
    const up = this.off[(this.kDown + 4) & 7];
    let c = this.cellAt(this.x[i], this.y[i]);
    for (let t = 0; t < this.RW + this.RH; t++) {
      if (st[c] === 0) {
        const ci = c % this.RW, cj = (c - ci) / this.RW;
        this.x[i] = (ci + 0.5) * this.cw;
        this.y[i] = (cj + 0.5) * this.ch;
        return;
      }
      const nc = c + up;
      if (nc < 0 || nc >= st.length) break;
      c = nc;
    }
    for (let c2 = 0; c2 < st.length; c2++) {
      if (st[c2] === 0) {
        const ci = c2 % this.RW, cj = (c2 - ci) / this.RW;
        this.x[i] = (ci + 0.5) * this.cw;
        this.y[i] = (cj + 0.5) * this.ch;
        return;
      }
    }
  }

  // Which of the 8 neighbours is "down", with hysteresis so the snow does not chatter or avalanche
  // at the bisectors: it switches only once gravity is 32.5° away from the current one.
  _updateDown(gx, gy, gpl) {
    if (gpl < G_HOLD) return;
    const th = Math.atan2(gx, gy);
    const cur = (this.kDown * Math.PI) / 4;
    let d = th - cur;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    if (Math.abs(d) > Math.PI / 8 + HYST) this.kDown = ((Math.round(th / (Math.PI / 4)) % 8) + 8) % 8;
  }

  // One step. gx, gy: in-plane effective gravity (m/s², sim frame), which airborne flakes sink
  // along; tx, ty: the same smoothed over a fraction of a second (the tilt), which decides what
  // resting snow leans on: a shake's sideways swings last a few hundredths of a second and must
  // not topple every pile sideways (the snow would wake deep inside the nooks of the scene and
  // be trapped there). fluid: the resolved liquid; turb: the sub-grid turbulence (its rms level
  // also stirs resting snow and keeps flakes from settling while the globe churns).
  step(dt, gx, gy, tx0, ty0, fluid, turb) {
    const n = this.n, rng = this.rng, st = this.st, off = this.off;
    const X = this.x, Y = this.y, VX = this.vx, VY = this.vy, CELLS = this.cell;
    const gpl = Math.hypot(gx, gy);
    const tpl = Math.hypot(tx0, ty0);
    this._updateDown(tx0, ty0, tpl);
    const hold = tpl >= G_HOLD;
    const kd = this.kDown;
    const oDown = off[kd], oUp = off[(kd + 4) & 7];
    const sink = 1 / G; // terminal velocity ∝ in-plane g (Stokes drag)
    const ux = gpl > 1e-4 ? gx / gpl : 0, uy = gpl > 1e-4 ? gy / gpl : 1;
    const flut = 0.55 * Math.min(1, gpl / G);
    const kT0 = Math.exp(-dt / TAU[0]), kT1 = Math.exp(-dt / TAU[1]), kFree = Math.exp(-dt / TAU_FREE);
    const upn = Math.hypot(DX[(kd + 4) & 7], DY[(kd + 4) & 7]);
    const upx = DX[(kd + 4) & 7] / upn, upy = DY[(kd + 4) & 7] / upn;
    const tl2 = turb.level * turb.level;
    const eject = EJECT * turb.level;
    const liftOn = fluid.maxSpeed * fluid.maxSpeed + tl2 > U_LIFT * U_LIFT;
    const uLift2 = U_LIFT * U_LIFT, uLand2 = U_LAND * U_LAND;
    const icw = this.icw, ich = this.ich, RW = this.RW, RH = this.RH;
    const xmin = this.xmin, xmax = this.xmax, ymin = this.ymin, ymax = this.ymax;
    const cellLimit = 0.8 / Math.max(icw, ich); // px per substep: under a cell, so nothing tunnels
    let ke = 0;

    for (let i = 0; i < n; i++) {
      const rc = CELLS[i];
      if (rc >= 0) {
        if (hold && st[rc + oDown] === 0) { this._wake(i); continue; }
        if (liftOn && st[rc + oUp] === 0) {
          fluid.sample(X[i], Y[i]);
          const s2 = fluid.su * fluid.su + fluid.sv * fluid.sv + tl2;
          if (s2 > uLift2 && rng() < (Math.sqrt(s2 / uLift2) - 1) * LIFT_RATE * dt) {
            this._wake(i);
            // Flung off the pile: up and to either side, faster the harder the globe churns, on
            // a short free flight (weak drag) that clears the nooks of the scene before the
            // turbulence takes over.
            const a = (rng() - 0.5) * 1.6;
            const ca = Math.cos(a), sa = Math.sin(a);
            const sp = LAUNCH * Math.min(1, turb.level / LAUNCH_REF) * (0.5 + 0.5 * rng());
            VX[i] = fluid.su + sp * (upx * ca - upy * sa);
            VY[i] = fluid.sv + sp * (upx * sa + upy * ca);
            this.free[i] = FREE_T * (0.5 + rng());
          }
        }
        continue;
      }

      // ---- airborne
      let x = X[i], y = Y[i];
      fluid.flow(x, y);
      const su = fluid.su, sv = fluid.sv;
      const churn = su * su + sv * sv + tl2 >= uLand2;
      const gl = this.kind[i] !== 0;
      const ws = this.ws[i] * sink;
      let ph = this.ph[i] + this.phw[i] * dt;
      if (ph > 6.2832) ph -= 6.2832;
      this.ph[i] = ph;
      if (gl) this.spin[i] += this.spinw[i] * dt;
      const f = flut * this.ws[i] * Math.sin(ph);
      // A flake whose cell was just taken by a neighbour landing (or buried under several) climbs
      // out against gravity to the first free cell, the top of the pile.
      let c = ((y * ich) | 0) * RW + ((x * icw) | 0);
      if (st[c] !== 0) {
        X[i] = x; Y[i] = y;
        this._climbOut(i);
        x = X[i]; y = Y[i];
        c = ((y * ich) | 0) * RW + ((x * icw) | 0);
      }

      // The liquid's own motion, resolved (fluid) and sub-grid (turb). Neither can flow into a
      // surface: next to a blocked cell the resolved flow loses its normal part and the turbulent
      // kick is mirrored (method of images). Without this the coarse grid's flow, interpolated
      // toward solids, presses flakes onto every surface and they pile up in streaks.
      let fu = su, fv = sv;
      if (tl2 > 0) {
        turb.sample(x, y);
        fu += st[c + (turb.tu > 0 ? 1 : -1)] !== 0 ? -turb.tu : turb.tu;
        fv += st[c + (turb.tv > 0 ? RW : -RW)] !== 0 ? -turb.tv : turb.tv;
      }
      if (st[c + (fu > 0 ? 1 : -1)] !== 0) fu = 0;
      if (st[c + (fv > 0 ? RW : -RW)] !== 0) fv = 0;
      // While the globe churns too hard for anything to settle, eddies sweep flakes off whatever
      // they touch: a kick along the surface normal (away from the blocked neighbours).
      if (churn) {
        let nx8 = 0, ny8 = 0;
        for (let k = 0; k < 8; k++) if (st[c + off[k]] !== 0) { nx8 -= DX[k]; ny8 -= DY[k]; }
        if (nx8 !== 0 || ny8 !== 0) {
          const e = eject / Math.sqrt(nx8 * nx8 + ny8 * ny8);
          fu += nx8 * e;
          fv += ny8 * e;
        }
      }
      // Sinking and fluttering are the flake's own motion through the liquid: they may press it
      // onto the snow, which is how it lands.
      const tx = fu + gx * ws - uy * f, ty = fv + gy * ws + ux * f;
      let k = gl ? kT1 : kT0;
      if (this.free[i] > 0) { this.free[i] -= dt; k = kFree; }
      let vx = tx + (VX[i] - tx) * k;
      let vy = ty + (VY[i] - ty) * k;
      const v2 = vx * vx + vy * vy;
      if (!(v2 <= VMAX * VMAX)) {
        const s = v2 > 0 && Number.isFinite(v2) ? VMAX / Math.sqrt(v2) : 0;
        vx *= s; vy *= s;
      }

      // Move in substeps of under one cell; on contact slide along the free axis. The glass walls
      // are the rest grid's solid ring, so they stop a flake the same way the scene does.
      const mx = vx * dt, my = vy * dt;
      const m = Math.max(Math.abs(mx), Math.abs(my));
      const ns = m <= cellLimit ? 1 : Math.min(MAX_SUB, Math.ceil(m / cellLimit));
      let sx = mx / ns, sy = my / ns;
      let hit = false;
      for (let s = 0; s < ns; s++) {
        const nx = x + sx, ny = y + sy;
        const ix = (nx * icw) | 0, iy = (ny * ich) | 0;
        if (st[iy * RW + ix] === 0) { x = nx; y = ny; continue; }
        hit = true;
        const ox = (x * icw) | 0, oy = (y * ich) | 0;
        if (sx !== 0 && st[oy * RW + ix] === 0) { x = nx; sy = 0; vy = 0; continue; }
        if (sy !== 0 && st[iy * RW + ox] === 0) { y = ny; sx = 0; vx = 0; continue; }
        vx = 0; vy = 0;
        break;
      }
      if (x < xmin) x = xmin; else if (x > xmax) x = xmax; // never needed; a guard
      if (y < ymin) y = ymin; else if (y > ymax) y = ymax;

      // Landing: below U_LAND of agitation always; up to 3 U_LAND sometimes (a random threshold
      // per contact), so snow starts settling while the churn dies down instead of all at once.
      if (hit && su * su + sv * sv + tl2 < uLand2 * (1 + 8 * rng())) {
        c = ((y * ich) | 0) * RW + ((x * icw) | 0);
        if (!hold) {
          if (st[c] === 0) { X[i] = x; Y[i] = y; this._rest(i, c, kd); continue; }
        } else if (st[c + oDown] !== 0 && st[c] === 0) {
          const k1 = rng() < 0.5 ? (kd + 1) & 7 : (kd + 7) & 7;
          const k2 = k1 === ((kd + 1) & 7) ? (kd + 7) & 7 : (kd + 1) & 7;
          let ks = -1;
          if (this._slideTo(c, kd, k1)) ks = k1; else if (this._slideTo(c, kd, k2)) ks = k2;
          if (ks >= 0 && rng() > STICK) {
            // Topple: step one cell down the free diagonal now (a nudge would be undone by the
            // drag before it got there, and the flake would land on the same spot and re-roll
            // STICK until it stuck, growing porous towers). It falls on from there next step.
            const t = c + off[ks];
            const ti = t % RW;
            x = (ti + 0.5) / icw;
            y = ((t - ti) / RW + 0.5) / ich;
            const norm = DX[ks] !== 0 && DY[ks] !== 0 ? Math.SQRT1_2 : 1;
            vx = DX[ks] * SLIDE_V * norm;
            vy = DY[ks] * SLIDE_V * norm;
          } else {
            X[i] = x; Y[i] = y;
            this._rest(i, c, kd);
            continue;
          }
        }
      }
      X[i] = x; Y[i] = y; VX[i] = vx; VY[i] = vy;
      ke += vx * vx + vy * vy;
    }
    this.ke = (0.5 * ke) / n; // mean ½v² over all flakes, (px/s)²
  }

  // Per-flake drawing data, 8 floats each: x, y, size (diameter px), shade, kind, angle, soft, spark.
  // lambda: the light's phase for the glitter facets (follows the phone's tilt).
  writeInstances(buf, lambda) {
    const n = this.n, st = this.st, CELLS = this.cell;
    const oUp = this.off[(this.kDown + 4) & 7];
    let o = 0;
    for (let i = 0; i < n; i++) {
      const rc = CELLS[i];
      const kd = this.kind[i];
      const r = this.rad[i];
      const dep = this.depth[i];
      buf[o] = this.x[i];
      buf[o + 1] = this.y[i];
      if (kd === 0) {
        let tone = this.tone[i];
        if (rc >= 0) tone += ((st[rc + oUp] === 0 ? 1 : 0) - tone) * 0.12;
        else tone += (1 - tone) * 0.2;
        this.tone[i] = tone;
        if (rc >= 0) {
          buf[o + 2] = 2 * r * 1.25 + 1.2;
          buf[o + 3] = 0.6 + 0.4 * tone;
          buf[o + 6] = 0.45;
        } else {
          const near = dep > 0.88 ? (dep - 0.88) / 0.12 : 0; // a few flakes right at the front glass: big and soft
          buf[o + 2] = 2 * r * (0.75 + 0.55 * dep + 1.3 * near);
          buf[o + 3] = (0.72 + 0.28 * dep) * (1 - 0.45 * near);
          buf[o + 6] = 0.35 + 0.5 * near;
        }
        buf[o + 4] = 0;
        buf[o + 5] = 0;
        buf[o + 7] = 0;
      } else {
        const s = 0.5 + 0.5 * Math.cos(this.facet[i] + this.spin[i] - lambda);
        const s2 = s * s, s4 = s2 * s2, s8 = s4 * s4, s16 = s8 * s8;
        buf[o + 2] = 2 * r * 1.3 + 0.6;
        buf[o + 3] = 0.55 + 0.45 * dep;
        buf[o + 4] = kd;
        buf[o + 5] = this.spin[i] * 0.5 + this.facet[i];
        buf[o + 6] = 0;
        buf[o + 7] = s16 * s8;
      }
      o += 8;
    }
    return n;
  }

  countBad() {
    let nan = false, outside = 0;
    const W = this.W, H = this.H;
    for (let i = 0; i < this.n; i++) {
      const x = this.x[i], y = this.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(this.vx[i]) || !Number.isFinite(this.vy[i])) nan = true;
      else if (x < 0 || x > W || y < 0 || y > H) outside++;
    }
    return { nan, outside };
  }
}
