// Dry sand as grains on a fine grid (at most one grain per cell) that carry a velocity: a
// cellular automaton for piles plus ballistic motion for everything that falls or flies.
//
// Flying grains: each substep a grain gains gravity, loses speed to the back glass (Coulomb,
// normal force |g.z|) and travels along its velocity cell by cell until something blocks it. A
// blocked move is an inelastic collision: the grain loses its speed into the obstacle and, by
// Coulomb friction, up to MU times that much of its sideways speed; a loose grain it hits gets a
// share of the push, and a hard hit scatters it a little, so sand slammed about breaks into spray.
//
// Resting grains: a grain is supported when the cell below it is a wall or a grain that is itself
// at rest ("below" is one of the eight grid directions, picked per grain and substep between the
// two nearest to gravity in proportion to the angle). Cells are visited from the bottom up, so the
// grain below has been settled before the one above asks: a pile whose floor drops away falls as
// one block, not layer by layer. A supported grain on the surface measures the local slope from
// the free cells within NR cells of it and compares it with real angles: steeper than REPOSE and
// it slides to the free neighbour cell most nearly downhill; once sliding it keeps going until the
// slope is below REPOSE_FLOW. Both angles are against gravity, not the grid, so piles look the
// same at any tilt. Grains just under a too-steep surface slide with it (an avalanche is a slab).
//
// Rest is exact: a grain that cannot move falls asleep and costs nothing until a neighbour moves
// or gravity turns. No creep, no jitter.
//
// Units: CSS px and seconds in the sim frame (x right, y down); velocities in px/s. Cells are
// sx × sy px (about `cell`, fitted so the grid covers the box). The occupancy grid has a border of
// wall cells PAD deep, so neighbour lookups need no bounds checks. DOM-free: runs in Node for tests.

export const PX_PER_M = 3000; // world scale: the 852 px tall phone box is a 28 cm bottle

// Tuning; docs/modes/sand.md says why each has its value. Exported so tests can vary them.
export const P = {
  // Slope thresholds as the grid sees them (its surfaces come in steps: 1:2 is 26.6°, 2:3 is
  // 33.7°, 1:1 is 45°). These give heaps of 32-34° and avalanches that stop near 35°.
  REPOSE: 42, // degrees: a resting surface steeper than this starts to slide
  REPOSE_FLOW: 37, // degrees: a sliding grain stops once the slope under it is below this
  MU: 0.6, // friction on a blocked move (grain-grain and walls)
  MU_GLASS: 0.32, // back glass: a flat phone holds sand up to 0.32·9.81 = 3.1 m/s² in-plane
  SHARE: 0.4, // part of a collision's normal speed passed to a loose grain that was hit
  V_SLIDE: 200, // px/s: slower than this, a supported grain is resting or sliding, not flying
  SLIDE_G: 0.5, // a sliding grain gains this fraction of g per substep along its slide
  SLAB: 6, // cells: grains this close under a slope steeper than repose slide with it
  NR: 3, // cells: radius of the window the surface slope is measured over
  ACTIVE: 6, // substeps a grain counts as sliding after it last moved
  STIR: 2, // substeps a grain next to a sliding one counts as sliding
  PUSH: 90, // cells: how far a finger looks for room to shove a grain into
  SCATTER: 0.08, // random sideways kick on a hard collision, as a fraction of the speed lost
  V_SCATTER: 400, // px/s: collisions harder than this scatter
  V_MAX: 3000, // px/s cap (1 m/s)
  WAKE_DEG: 1.5, // gravity turning this much wakes the surface to look at its slope again
  SUB_DT: 1 / 180, // s, longest substep
  SUB_DT_FEW: 1 / 480, // s, longest substep while fewer than FEW of the grains are awake
  FEW: 0.12,
};
export const V_MOVING = 30; // px/s: "moving", for stats and sound

const EMPTY = -1, WALL = -2, PAD = 3; // PAD >= NR

// xorshift32, module-level so the hot loops can inline it; only picks directions and kicks.
let rs = 0x9e3779b9 | 0;
function rnd() {
  rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
  return (rs >>> 0) / 4294967296;
}
// The eight grid directions, index k at angle k·45° from +x (y down).
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DL = [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2]; // 1 / length

export class SandGrid {
  constructor(cap, cell) {
    this.cap = cap;
    this.cell = cell;
    this.n = 0;
    this.cx = new Int32Array(cap); // cell of each grain, 0..gw-1, 0..gh-1
    this.cy = new Int32Array(cap);
    this.vx = new Float32Array(cap); // px/s
    this.vy = new Float32Array(cap);
    this.ox = new Float32Array(cap); // travel toward the next cell, in cells (-0.5, 0.5)
    this.oy = new Float32Array(cap);
    this.act = new Uint8Array(cap); // substeps left "sliding"
    this.awake = new Uint8Array(cap);
    this.stamp = new Uint32Array(cap); // last substep the grain was updated
    this.held = new Uint32Array(cap); // last substep the grain was at rest (holds up others)
    this.tick = 0;
    this.W = 1; this.H = 1;
    this.gw = 0; this.gh = 0;
    this.stride = 0;
    this.sx = cell; this.sy = cell;
    this.occ = new Int32Array(0); // grain index per padded cell, EMPTY or WALL
    this.rowAwake = new Int32Array(0); // awake grains per grid row / column: skip quiet lines
    this.colAwake = new Int32Array(0);
    this.rowLo = new Int32Array(0); this.rowHi = new Int32Array(0); // where in a row they are
    this.colLo = new Int32Array(0); this.colHi = new Int32Array(0); // (bounds only grow until empty)
    this.nAwake = 0;
    this.fingerR = 24; // px: a fingertip is about 9 mm across
    this.fingers = [];
    this.wakeG = { x: 0, y: 0, z: 0 }; // gravity when the surface last looked at its slopes
    this.hard = 0; // speed lost in collisions harder than V_SCATTER this step, summed, px/s (sound)
    this.moved = 0; // grains that changed cell this step
    this.ctx = { h: 0, Gx: 0, Gy: 0, glass: 0, inPlane: false, ux: 0, uy: 1, cosS: 1, cosF: 1, sinS: 0, slideDv: 0 };
  }

  // Padded index of cell (x, y).
  idx(x, y) { return (y + PAD) * this.stride + x + PAD; }

  // Fit the grid to a box W x H px. If its size in cells changes, the sand is stacked afresh
  // against the wall gravity `g` points at: each line of cells across that wall keeps about the
  // grains it had (so the heap keeps its profile) in the order they had (so the layers survive).
  setBox(W, H, g) {
    const gw = Math.max(1, Math.round(W / this.cell)), gh = Math.max(1, Math.round(H / this.cell));
    this.W = W; this.H = H; this.sx = W / gw; this.sy = H / gh;
    if (gw === this.gw && gh === this.gh) return;
    const ogw = this.gw, ogh = this.gh;
    this.gw = gw; this.gh = gh;
    this.stride = gw + 2 * PAD;
    this.occ = new Int32Array(this.stride * (gh + 2 * PAD)).fill(WALL);
    for (let y = 0; y < gh; y++) this.occ.fill(EMPTY, this.idx(0, y), this.idx(gw, y));
    this.rowAwake = new Int32Array(gh);
    this.colAwake = new Int32Array(gw);
    this.rowLo = new Int32Array(gh).fill(gw); this.rowHi = new Int32Array(gh).fill(-1);
    this.colLo = new Int32Array(gw).fill(gh); this.colHi = new Int32Array(gw).fill(-1);
    this.nAwake = 0;
    if (this.n) this.restack(ogw, ogh, g);
  }

  restack(ogw, ogh, g) {
    const n = this.n;
    const { cx, cy } = this;
    const vert = !g || Math.abs(g.y) >= Math.abs(g.x);
    const toHigh = vert ? !g || g.y >= 0 : g.x >= 0; // stack from the high-index wall
    const L = vert ? this.gw : this.gh, D = vert ? this.gh : this.gw; // lines, cells per line
    const oL = vert ? ogw : ogh, oD = vert ? ogh : ogw;
    // Sort grains by new line, then by old distance from the wall (counting sort on one key).
    const keys = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const a = vert ? cx[i] : cy[i], b = vert ? cy[i] : cx[i];
      // a random spot across the old line, so a widened box gets no empty lines between
      const line = Math.min(L - 1, Math.floor(((a + rnd()) * L) / oL));
      const dist = toHigh ? oD - 1 - b : b;
      keys[i] = line * oD + Math.min(oD - 1, Math.max(0, dist));
    }
    const nk = L * oD;
    const start = new Int32Array(nk + 1);
    for (let i = 0; i < n; i++) start[keys[i] + 1]++;
    for (let k = 0; k < nk; k++) start[k + 1] += start[k];
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[start[keys[i]]++] = i;
    const nx = new Int32Array(n).fill(-1), ny = new Int32Array(n);
    const fill = new Int32Array(L); // cells used per line
    for (let t = 0; t < n; t++) {
      const i = order[t];
      let line = (keys[i] / oD) | 0;
      for (let tries = 0; fill[line] >= D && tries < L; tries++) line = (line + 1) % L; // spill over
      if (fill[line] >= D) continue; // no room at all
      const d = fill[line]++;
      const along = toHigh ? D - 1 - d : d;
      nx[i] = vert ? line : along; ny[i] = vert ? along : line;
    }
    this.n = 0;
    for (let i = 0; i < n; i++) {
      if (nx[i] < 0) break; // the box is too small for the rest
      this.place(i, nx[i], ny[i]);
    }
  }

  clear() {
    for (let y = 0; y < this.gh; y++) this.occ.fill(EMPTY, this.idx(0, y), this.idx(this.gw, y));
    this.n = 0; this.rowAwake.fill(0); this.colAwake.fill(0); this.nAwake = 0;
    this.rowLo.fill(this.gw); this.rowHi.fill(-1); this.colLo.fill(this.gh); this.colHi.fill(-1);
  }

  // Put a grain in cell (x, y) if it is free; returns its index or -1.
  add(x, y) {
    if (this.n >= this.cap || x < 0 || y < 0 || x >= this.gw || y >= this.gh) return -1;
    if (this.occ[this.idx(x, y)] !== EMPTY) return -1;
    const i = this.n;
    this.place(i, x, y);
    return i;
  }

  // Put grain i (the next index) at free cell (x, y), still and awake.
  place(i, x, y) {
    this.n = i + 1;
    this.cx[i] = x; this.cy[i] = y; this.occ[this.idx(x, y)] = i;
    this.vx[i] = 0; this.vy[i] = 0; this.ox[i] = 0; this.oy[i] = 0; this.act[i] = 0;
    this.awake[i] = 0;
    this.wake(i);
  }

  wake(i) {
    if (this.awake[i]) return;
    this.awake[i] = 1;
    this.nAwake++;
    this.enter(this.cx[i], this.cy[i]);
  }

  sleep(i) {
    if (!this.awake[i]) return;
    this.awake[i] = 0;
    this.nAwake--;
    this.leave(this.cx[i], this.cy[i]);
    this.vx[i] = 0; this.vy[i] = 0; this.act[i] = 0; this.ox[i] = 0; this.oy[i] = 0;
  }

  // An awake grain arrives at / leaves cell (x, y): keep the per-line counts and spans.
  enter(x, y) {
    this.rowAwake[y]++; this.colAwake[x]++;
    if (x < this.rowLo[y]) this.rowLo[y] = x;
    if (x > this.rowHi[y]) this.rowHi[y] = x;
    if (y < this.colLo[x]) this.colLo[x] = y;
    if (y > this.colHi[x]) this.colHi[x] = y;
  }

  leave(x, y) {
    if (--this.rowAwake[y] === 0) { this.rowLo[y] = this.gw; this.rowHi[y] = -1; }
    if (--this.colAwake[x] === 0) { this.colLo[x] = this.gh; this.colHi[x] = -1; }
  }

  // Wake every grain with a free cell next to it.
  wakeSurface() {
    const { n, occ, awake, cx, cy, stride } = this;
    for (let i = 0; i < n; i++) {
      if (awake[i]) continue;
      const c = (cy[i] + PAD) * stride + cx[i] + PAD;
      if (occ[c - stride - 1] === EMPTY || occ[c - stride] === EMPTY || occ[c - stride + 1] === EMPTY ||
          occ[c - 1] === EMPTY || occ[c + 1] === EMPTY ||
          occ[c + stride - 1] === EMPTY || occ[c + stride] === EMPTY || occ[c + stride + 1] === EMPTY) this.wake(i);
    }
  }

  // Wake the sleeping grains within r cells of padded cell c. `stir`: they were jostled by a
  // grain sliding past, so for a few substeps they hold only at the flow angle (a sliding layer
  // drags the one beneath it along).
  wakeAround(c, r, stir) {
    const { occ, awake, act, stride } = this;
    for (let dy = -r; dy <= r; dy++) {
      const row = c + dy * stride;
      for (let dx = -r; dx <= r; dx++) {
        const j = occ[row + dx];
        if (j < 0) continue;
        if (!awake[j]) this.wake(j);
        if (stir > act[j]) act[j] = stir;
      }
    }
  }

  // Fingers this frame: [{id, x, y, vx, vy}] in sim px and px/s. Each remembers where it was
  // last frame, to be swept from there.
  setFingers(list) {
    const old = this.fingers;
    const now = [];
    if (list) {
      for (const p of list) {
        const o = old.find((q) => q.id === p.id);
        let vx = p.vx || 0, vy = p.vy || 0;
        const s = Math.sqrt(vx * vx + vy * vy), vm = 2500;
        if (s > vm) { vx *= vm / s; vy *= vm / s; }
        now.push({ id: p.id, x0: o ? o.x : p.x, y0: o ? o.y : p.y, x: p.x, y: p.y, vx, vy });
      }
    }
    this.fingers = now;
  }

  // g: effective gravity in m/s², sim frame (z toward the back glass).
  // Substeps of at most SUB_DT; when only a few grains are awake (an avalanche, a trickle) of
  // SUB_DT_FEW, since the pile rules move a grain one cell per substep and they are cheap then.
  step(dt, g) {
    this.hard = 0;
    this.moved = 0;
    if (!this.n || !(dt > 0)) return;
    // Gravity turned since the surface last checked its slopes, or the back glass let go: the
    // surface looks again. The rest of the pile need not: a grain whose support falls away is
    // woken by it before the sweep reaches it, so a pile still falls as one.
    const w = this.wakeG;
    const turned = Math.atan2(Math.abs(g.x * w.y - g.y * w.x), g.x * w.x + g.y * w.y) * 57.3;
    const held = (gg) => P.MU_GLASS * Math.abs(gg.z) >= Math.sqrt(gg.x * gg.x + gg.y * gg.y);
    if (turned > P.WAKE_DEG || held(g) !== held(w)) {
      this.wakeSurface();
      w.x = g.x; w.y = g.y; w.z = g.z;
    }
    let t = 0;
    for (let k = 0; k < 64 && t < dt - 1e-9; k++) {
      const few = this.nAwake < P.FEW * this.n;
      const nLeft = Math.ceil((dt - t) / (few ? P.SUB_DT_FEW : P.SUB_DT) - 1e-6);
      const h = (dt - t) / nLeft;
      t += h;
      this.substep(h, g, t / dt);
    }
  }

  // u: how far through the frame this substep ends (0..1], for sweeping the fingers.
  substep(h, g, u = 1) {
    const { gw, gh, occ, stamp, awake, rowAwake, colAwake, stride, ctx } = this;
    const tick = ++this.tick;
    const Gx = g.x * PX_PER_M, Gy = g.y * PX_PER_M;
    const Gl = Math.sqrt(Gx * Gx + Gy * Gy);
    // the two grid directions around gravity, and the chance of the second
    let dA = 2, dB = 2, pB = 0;
    if (Gl > 1e-6) {
      let a = Math.atan2(Gy, Gx) / (Math.PI / 4);
      if (a < 0) a += 8;
      dA = Math.floor(a) & 7; dB = (dA + 1) & 7; pB = a - Math.floor(a);
    }
    const glass = P.MU_GLASS * Math.abs(g.z) * PX_PER_M * h; // speed the glass takes per substep
    ctx.h = h; ctx.Gx = Gx; ctx.Gy = Gy; ctx.glass = glass;
    ctx.inPlane = Gl * h > glass; // can gravity overcome the back glass at all?
    ctx.ux = Gl > 1e-6 ? Gx / Gl : 0; ctx.uy = Gl > 1e-6 ? Gy / Gl : 1; // down
    ctx.cosS = Math.cos((P.REPOSE * Math.PI) / 180);
    ctx.cosF = Math.cos((P.REPOSE_FLOW * Math.PI) / 180);
    ctx.sinS = Math.sin((P.REPOSE * Math.PI) / 180);
    ctx.slideDv = P.SLIDE_G * Gl * h;
    this.applyFingers(u, ctx);
    if (!this.nAwake) return;

    // Visit cells from the leading edge along gravity, so a column falls as one and a grain
    // moves into the space the one ahead of it just left.
    const rows = Math.abs(Gy) >= Math.abs(Gx);
    const majN = rows ? gh : gw, minN = rows ? gw : gh;
    const majS = rows ? stride : 1, minS = rows ? 1 : stride;
    const lineAwake = rows ? rowAwake : colAwake;
    const lineLo = rows ? this.rowLo : this.colLo, lineHi = rows ? this.rowHi : this.colHi;
    const gMaj = rows ? Gy : Gx, gMin = rows ? Gx : Gy;
    const majFwd = gMaj < 0; // gravity toward low indices: start at 0
    let minFwd = gMin < 0;
    if (Math.abs(gMin) < 0.15 * Gl) minFwd = (tick & 1) === 0; // no clear side: alternate
    const c00 = PAD * stride + PAD;
    for (let a = 0; a < majN; a++) {
      const ma = majFwd ? a : majN - 1 - a;
      if (lineAwake[ma] === 0) continue;
      const base = c00 + ma * majS;
      const lo = lineLo[ma], hi = lineHi[ma];
      for (let b = lo; b <= hi; b++) {
        const mi = minFwd ? b : lo + hi - b;
        const c = base + mi * minS;
        const i = occ[c];
        if (i < 0 || !awake[i] || stamp[i] === tick) continue;
        stamp[i] = tick;
        this.update(i, c, pB > 0 && rnd() < pB ? dB : dA, ctx);
      }
    }
  }

  // Grain i in padded cell c0; d: "below" this substep.
  update(i, c0, d, ctx) {
    const { occ, vx, vy, ox, oy, act, stride } = this;
    let vxi = vx[i], vyi = vy[i];
    // The back glass holds everything that is not already moving (a phone lying flat).
    if (!ctx.inPlane && vxi === 0 && vyi === 0) { this.sleep(i); return; }
    const below = occ[c0 + DY[d] * stride + DX[d]];
    const supported = below === WALL || (below >= 0 && (!this.awake[below] || this.held[below] === this.tick));
    if (supported && vxi * vxi + vyi * vyi < P.V_SLIDE * P.V_SLIDE) {
      this.held[i] = this.tick;
      this.rest(i, c0, ctx, d);
      return;
    }

    // Falling or flying. A grain that was at rest wakes the grains resting on it (the cells
    // above it, against gravity); the sweep reaches them later in this substep, so they start
    // to fall together with it and a whole pile drops as one.
    if (vxi === 0 && vyi === 0) {
      const u = (d + 4) & 7, a = (d + 3) & 7, b = (d + 5) & 7;
      let j = occ[c0 + DY[u] * stride + DX[u]];
      if (j >= 0 && !this.awake[j]) this.wake(j);
      j = occ[c0 + DY[a] * stride + DX[a]];
      if (j >= 0 && !this.awake[j]) this.wake(j);
      j = occ[c0 + DY[b] * stride + DX[b]];
      if (j >= 0 && !this.awake[j]) this.wake(j);
    }
    const h = ctx.h;
    vxi += ctx.Gx * h; vyi += ctx.Gy * h;
    let s2 = vxi * vxi + vyi * vyi;
    const glass = ctx.glass;
    if (glass > 0) {
      const s = Math.sqrt(s2);
      if (s <= glass) { vxi = 0; vyi = 0; s2 = 0; } else { const k = 1 - glass / s; vxi *= k; vyi *= k; s2 *= k * k; }
    }
    const vm = P.V_MAX;
    if (s2 > vm * vm) { const k = vm / Math.sqrt(s2); vxi *= k; vyi *= k; }
    let oxi = ox[i] + (vxi * h) / this.sx, oyi = oy[i] + (vyi * h) / this.sy;
    const MU = P.MU, SHARE = P.SHARE;
    let c = c0, lost = 0;
    for (let k = 0; k < 16; k++) {
      const mx = oxi >= 0.5 ? 1 : oxi <= -0.5 ? -1 : 0;
      const my = oyi >= 0.5 ? 1 : oyi <= -0.5 ? -1 : 0;
      if (mx === 0 && my === 0) break;
      const sy = my * stride;
      // The full step, then its larger and its smaller axis part. The path is only read; the
      // grain is written once, where it ends up.
      if (occ[c + sy + mx] === EMPTY) { c += sy + mx; oxi -= mx; oyi -= my; continue; }
      if (mx !== 0 && my !== 0) {
        const xFirst = (oxi < 0 ? -oxi : oxi) >= (oyi < 0 ? -oyi : oyi);
        if (xFirst && occ[c + mx] === EMPTY) { c += mx; oxi -= mx; continue; }
        if (occ[c + sy] === EMPTY) { c += sy; oyi -= my; continue; }
        if (!xFirst && occ[c + mx] === EMPTY) { c += mx; oxi -= mx; continue; }
      }
      // Blocked: an inelastic collision along each blocked axis.
      if (mx !== 0) {
        const j = occ[c + mx];
        const ujx = j >= 0 ? vx[j] : 0, ujy = j >= 0 ? vy[j] : 0;
        const vn = (vxi - ujx) * mx;
        if (vn > 0) {
          vxi -= vn * mx;
          const vt = vyi - ujy, f = MU * vn;
          vyi = vt <= f && vt >= -f ? ujy : vyi - (vt > 0 ? f : -f);
          if (j >= 0 && occ[c + 2 * mx] === EMPTY) { vx[j] += vn * mx * SHARE; this.wake(j); }
          lost += vn;
        }
        oxi = mx > 0 ? 0.49 : -0.49;
      }
      if (my !== 0) {
        const j = occ[c + sy];
        if (j !== EMPTY) {
          const ujx = j >= 0 ? vx[j] : 0, ujy = j >= 0 ? vy[j] : 0;
          const vn = (vyi - ujy) * my;
          if (vn > 0) {
            vyi -= vn * my;
            const vt = vxi - ujx, f = MU * vn;
            vxi = vt <= f && vt >= -f ? ujx : vxi - (vt > 0 ? f : -f);
            if (j >= 0 && occ[c + 2 * sy] === EMPTY) { vy[j] += vn * my * SHARE; this.wake(j); }
            lost += vn;
          }
          oyi = my > 0 ? 0.49 : -0.49;
        }
      }
    }
    if (c !== c0) this.move(i, c0, c, false);
    if (lost > 0) {
      // a hard hit scatters the grain a little, so a slab of sand thrown about breaks into spray
      if (lost > P.V_SCATTER) {
        this.hard += lost;
        const k = P.SCATTER * (lost - P.V_SCATTER);
        vxi += (rnd() - 0.5) * k; vyi += (rnd() - 0.5) * k;
      }
    }
    vx[i] = vxi; vy[i] = vyi; ox[i] = oxi; oy[i] = oyi;
    if (c !== c0) act[i] = P.ACTIVE;
  }

  // A supported grain that is not flying (c: its padded cell, d: "below"): stay, or slide one
  // cell down a slope steeper than the repose angle (the flow angle while it is already
  // sliding). It falls asleep when it cannot move.
  rest(i, c, ctx, d) {
    const { occ, vx, vy, ox, oy, act, stride } = this;
    ox[i] *= 0.6; oy[i] *= 0.6; // settle onto the cell
    if (!ctx.inPlane) { this.sleep(i); return; } // the back glass holds it
    const ux = ctx.ux, uy = ctx.uy;
    let best = -1;
    if (occ[c - stride - 1] !== EMPTY && occ[c - stride] !== EMPTY && occ[c - stride + 1] !== EMPTY &&
        occ[c - 1] !== EMPTY && occ[c + 1] !== EMPTY &&
        occ[c + stride - 1] !== EMPTY && occ[c + stride] !== EMPTY && occ[c + stride + 1] !== EMPTY) {
      // Inside the pile. Within SLAB cells of a surface steeper than repose it is part of the
      // slab that slides off (an avalanche is several grains deep): it moves along the slope
      // when the grain ahead has made room. Deeper, nothing can move it.
      const up = (d + 4) & 7, step = DY[up] * stride + DX[up];
      let s = c, k = 0;
      while (k < P.SLAB && occ[s + step] >= 0) { s += step; k++; }
      if (k < P.SLAB && occ[s + step] === EMPTY) {
        const j = occ[s];
        best = this.slope(s, c, ux, uy, act[j] > 0 || act[i] > 0 ? ctx.cosF : ctx.cosS);
      }
      if (best < 0) { this.sleep(i); return; }
    } else {
      // A free neighbour cell lying more than the repose angle below level (against gravity,
      // not the grid): it goes there. This topples spikes and overhangs, which the slope misses.
      let bestS = ctx.sinS;
      for (let e = 0; e < 8; e++) {
        if (occ[c + DY[e] * stride + DX[e]] !== EMPTY) continue;
        const down = (DX[e] * ux + DY[e] * uy) * DL[e] + 0.05 * rnd();
        if (down > bestS) { bestS = down; best = e; }
      }
      if (best < 0) best = this.slope(c, c, ux, uy, act[i] > 0 ? ctx.cosF : ctx.cosS);
    }
    if (best >= 0) {
      this.move(i, c, c + DY[best] * stride + DX[best], true);
      // It slides: its speed grows by about what gravity gives along a slope, so past V_SLIDE
      // it is in flight over the surface, losing speed to it by friction where it touches.
      let s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) + ctx.slideDv;
      if (s < 90) s = 90;
      vx[i] = DX[best] * DL[best] * s; vy[i] = DY[best] * DL[best] * s;
      act[i] = P.ACTIVE;
      return;
    }
    // Stays put this substep.
    vx[i] = 0; vy[i] = 0;
    if (act[i] > 0) act[i]--;
    else this.sleep(i);
  }

  // The surface slope at padded cell cs: if steeper than acos(cosMax) against gravity (ux, uy),
  // the direction (0..7) of the free neighbour of cell c most nearly downhill along it, else -1.
  slope(cs, c, ux, uy, cosMax) {
    const { occ, stride } = this;
    // Free cells within NR (a disc; walls count as sand) point away from the sand: the sum of
    // their offsets is the surface normal.
    const R = P.NR, R2 = R * R + R;
    let nx = 0, ny = 0;
    for (let dy = -R; dy <= R; dy++) {
      const row = cs + dy * stride;
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R2 || occ[row + dx] !== EMPTY) continue;
        nx += dx; ny += dy;
      }
    }
    const nl2 = nx * nx + ny * ny;
    if (nl2 <= 0.25) return -1;
    const nl = Math.sqrt(nl2);
    nx /= nl; ny /= nl;
    const gn = nx * ux + ny * uy; // -cos(slope)
    if (-gn >= cosMax) return -1;
    // downhill along the surface: gravity minus its normal part
    const tx = ux - gn * nx, ty = uy - gn * ny;
    // the free neighbour cell most nearly downhill, never one that climbs much
    let best = -1, bestS = 0.2;
    for (let e = 0; e < 8; e++) {
      if (occ[c + DY[e] * stride + DX[e]] !== EMPTY) continue;
      const ex = DX[e] * DL[e], ey = DY[e] * DL[e];
      const down = ex * ux + ey * uy;
      if (down < -0.35) continue;
      const sc = ex * tx + ey * ty + 0.5 * down + 0.15 * rnd();
      if (sc > bestS) { bestS = sc; best = e; }
    }
    return best;
  }

  // Move grain i from padded cell c0 to the free cell c1 and wake it; nothing else.
  shift(i, c0, c1) {
    const { occ, stride } = this;
    occ[c0] = EMPTY;
    occ[c1] = i;
    const x0 = this.cx[i], y0 = this.cy[i];
    const y1 = ((c1 / stride) | 0) - PAD, x1 = c1 - (y1 + PAD) * stride - PAD;
    this.cx[i] = x1; this.cy[i] = y1;
    if (this.awake[i]) { this.leave(x0, y0); this.enter(x1, y1); } else this.wake(i);
    this.moved++;
  }

  // Move grain i from padded cell c0 to the free cell c1. `wide`: a slide, which changes the
  // slope its neighbours see, so everything within 2 cells of both cells wakes; a grain in flight
  // only wakes the 8 around the cell it left (one of them may have rested on it).
  move(i, c0, c1, wide) {
    const { occ, stride } = this;
    occ[c0] = EMPTY;
    occ[c1] = i;
    const x0 = this.cx[i], y0 = this.cy[i];
    const y1 = ((c1 / stride) | 0) - PAD, x1 = c1 - (y1 + PAD) * stride - PAD;
    this.cx[i] = x1; this.cy[i] = y1;
    if (this.awake[i]) { this.leave(x0, y0); this.enter(x1, y1); }
    this.moved++;
    if (wide) { this.wakeAround(c0, 2, P.STIR); this.wakeAround(c1, 2, P.STIR); } else this.wakeAround(c0, 1, 0);
  }

  // A finger is a stick through the sand, swept from where it was last frame to where it is now
  // (u: how far through the frame). Each grain under it is shoved out along a line of cells: the
  // most nearly outward direction (leaning "up") that reaches a free cell within PUSH cells. The
  // whole line shifts by one cell into that free cell, so deep in the pile the sand above the
  // finger rises, near the surface the finger digs a trench that slumps back behind it, and the
  // grains it shoves take some of its speed (a flick throws sand).
  applyFingers(u, ctx) {
    const F = this.fingers;
    if (!F.length) return;
    const { gw, gh, occ, vx, vy, stride, sx, sy } = this;
    const R = this.fingerR, maxK = P.PUSH;
    const list = this.pushList || (this.pushList = []);
    for (const f of F) {
      const fx = f.x0 + (f.x - f.x0) * u, fy = f.y0 + (f.y - f.y0) * u;
      const x0 = Math.max(0, Math.floor((fx - R) / sx)), x1 = Math.min(gw - 1, Math.floor((fx + R) / sx));
      const y0 = Math.max(0, Math.floor((fy - R) / sy)), y1 = Math.min(gh - 1, Math.floor((fy + R) / sy));
      // grains under the finger, outermost first, so each line shifts out cleanly
      list.length = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5) * sx - fx, dy = (y + 0.5) * sy - fy;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R && occ[this.idx(x, y)] >= 0) list.push(d2, x, y);
        }
      }
      const m = list.length / 3;
      const order = this.pushOrder && this.pushOrder.length >= m ? this.pushOrder : (this.pushOrder = new Int32Array(Math.max(64, m * 2)));
      for (let k = 0; k < m; k++) order[k] = k;
      order.subarray(0, m).sort((a, b) => list[3 * b] - list[3 * a]);
      for (let t = 0; t < m; t++) {
        const k = order[t], x = list[3 * k + 1], y = list[3 * k + 2];
        const c = this.idx(x, y);
        if (occ[c] < 0) continue;
        let dx = (x + 0.5) * sx - fx, dy = (y + 0.5) * sy - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 1e-3) { dx /= d; dy /= d; } else { dx = -ctx.ux; dy = -ctx.uy; }
        // the eight directions, most outward first, "up" breaking ties
        let tried = 0;
        for (let pass = 0; pass < 8; pass++) {
          let e = -1, best = -9;
          for (let q = 0; q < 8; q++) {
            if (tried & (1 << q)) continue;
            const sc = (DX[q] * dx + DY[q] * dy) * DL[q] - 0.6 * (DX[q] * ctx.ux + DY[q] * ctx.uy) * DL[q];
            if (sc > best) { best = sc; e = q; }
          }
          tried |= 1 << e;
          const step = DY[e] * stride + DX[e];
          let kk = 1;
          while (kk <= maxK && occ[c + kk * step] >= 0) kk++;
          if (kk > maxK || occ[c + kk * step] !== EMPTY) continue;
          // shift the line out by one cell, farthest grain first; the grains near the finger take
          // its speed, and every grain of the line wakes to look at its new neighbourhood
          for (let j = kk - 1; j >= 0; j--) {
            const from = c + j * step, g = occ[from];
            this.shift(g, from, from + step);
            if (j < 3) {
              vx[g] += (f.vx - vx[g]) * 0.5 + DX[e] * DL[e] * 120;
              vy[g] += (f.vy - vy[g]) * 0.5 + DY[e] * DL[e] * 120;
            }
            this.act[g] = P.ACTIVE;
          }
          this.wakeAround(c + kk * step, 2, P.STIR);
          this.wakeAround(c, 2, P.STIR);
          break;
        }
      }
    }
  }

  // Slope of the pile's free surface against the gravity-perpendicular, degrees: the surface
  // height in 8 px columns across gravity (grains within 4 cells of a wall left out), line fits
  // over 64 px windows, the 70th percentile of their angles (flat floor and the curve into a
  // wall count little). Meaningful once the sand has settled.
  reposeAngle(g) {
    const n = this.n, gl = Math.sqrt(g.x * g.x + g.y * g.y);
    if (gl < 1e-6 || n < 50) return 0;
    const dx = g.x / gl, dy = g.y / gl, tx = -dy, ty = dx;
    const m = 4, { gw, gh, cx, cy } = this;
    const BIN = 8, nb = Math.ceil(Math.sqrt(this.W * this.W + this.H * this.H) / BIN) + 2;
    if (!this.topBuf || this.topBuf.length < nb) this.topBuf = new Float64Array(nb);
    const top = this.topBuf;
    top.fill(-Infinity, 0, nb);
    const u0 = Math.min(0, this.W * tx, this.H * ty, this.W * tx + this.H * ty);
    for (let i = 0; i < n; i++) {
      if (cx[i] < m || cy[i] < m || cx[i] >= gw - m || cy[i] >= gh - m) continue;
      const X = this.posX(i), Y = this.posY(i);
      const b = ((X * tx + Y * ty - u0) / BIN) | 0;
      const hgt = -(X * dx + Y * dy);
      if (hgt > top[b]) top[b] = hgt;
    }
    const angles = this.angBuf || (this.angBuf = []);
    angles.length = 0;
    for (let b0 = 0; b0 + 8 <= nb; b0 += 2) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
      for (let b = b0; b < b0 + 8; b++) {
        if (top[b] === -Infinity) continue;
        const u = b * BIN;
        sx += u; sy += top[b]; sxx += u * u; sxy += u * top[b]; k++;
      }
      if (k < 7) continue;
      const den = k * sxx - sx * sx;
      if (den > 0) angles.push(Math.abs(Math.atan((k * sxy - sx * sy) / den)) * 57.29578);
    }
    if (!angles.length) return 0;
    angles.sort((p, q) => p - q);
    return angles[Math.min(angles.length - 1, Math.floor(angles.length * 0.7))];
  }

  // Occupancy as one byte per cell (255 grain, 0 empty), row by row from the top, for drawing.
  occupancy(out) {
    const { gw, gh, occ, stride } = this;
    for (let y = 0; y < gh; y++) {
      const row = (y + PAD) * stride + PAD, o = y * gw;
      for (let x = 0; x < gw; x++) out[o + x] = occ[row + x] >= 0 ? 255 : 0;
    }
    return out;
  }

  // Occupancy of cell (x, y): a grain index, or -1.
  at(x, y) {
    const j = this.occ[this.idx(x, y)];
    return j >= 0 ? j : -1;
  }

  // Sim px position of grain i: its cell plus its travel toward the next, the travel shown only
  // along an axis it is moving on (a grain pressed against another sits in its own cell).
  posX(i) {
    const v = this.vx[i], f = v > 60 || v < -60 ? 1 : (v < 0 ? -v : v) / 60;
    return (this.cx[i] + 0.5 + this.ox[i] * f) * this.sx;
  }

  posY(i) {
    const v = this.vy[i], f = v > 60 || v < -60 ? 1 : (v < 0 ? -v : v) / 60;
    return (this.cy[i] + 0.5 + this.oy[i] * f) * this.sy;
  }
}
