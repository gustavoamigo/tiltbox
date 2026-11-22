// Sub-grid turbulence: the swirls a shake makes that are too small (and too three-dimensional) for
// the coarse liquid grid. A divergence-free random field, so neighbouring flakes move together in
// eddies instead of jittering apart: the curl of a stream function psi * F, where psi is a sum of
// a few drifting plane waves and F a factor that falls to zero at the four glass walls. Because
// psi * F is zero along the walls, the flow turns along the glass instead of pressing flakes onto
// it (a field that ignores the walls leaves a film of flakes stuck to them).
// Its strength (level, rms px/s away from the walls) is set by the mode from how hard the globe is
// shaken. Cost: a sin and a cos per mode per sample, four exps for the walls; no allocation.

const MODES = 6;

export class Turbulence {
  constructor(rng) {
    this.rng = rng;
    this.kx = new Float32Array(MODES); // wave vector, rad/px
    this.ky = new Float32Array(MODES);
    this.th = new Float32Array(MODES); // direction of the wave vector
    this.k = new Float32Array(MODES); // |wave vector|
    this.ph = new Float32Array(MODES); // phase
    this.w = new Float32Array(MODES); // phase speed factor
    this.amp = 0; // per-mode velocity amplitude, px/s
    this.level = 0;
    this.W = 400;
    this.H = 800;
    this.iL = 1 / 60; // 1 / width of the wall layer, 1/px
    this.tu = 0; // last sample()
    this.tv = 0;
    for (let m = 0; m < MODES; m++) {
      this.th[m] = rng() * Math.PI * 2;
      this.ph[m] = rng() * Math.PI * 2;
      this.w[m] = (0.6 + 0.8 * rng()) * (rng() < 0.5 ? -1 : 1);
    }
    this.setBox(400, 800);
  }

  // Wavelengths from 0.8 to 2.6 times the box's short side: eddies from a quarter of it to larger
  // than it, so a churning globe mixes snow from the floor right up to the top. The wall layer is
  // about one eddy radius wide, so turning along the glass does not speed the flow up much.
  setBox(W, H) {
    this.W = W;
    this.H = H;
    const size = Math.min(W, H);
    for (let m = 0; m < MODES; m++) {
      const lambda = size * (0.8 + (1.8 * m) / (MODES - 1));
      this.k[m] = (2 * Math.PI) / lambda;
    }
    this.iL = 1 / (0.15 * size);
    this._dirs();
  }

  _dirs() {
    for (let m = 0; m < MODES; m++) {
      this.kx[m] = this.k[m] * Math.cos(this.th[m]);
      this.ky[m] = this.k[m] * Math.sin(this.th[m]);
    }
  }

  // level: rms speed wanted, px/s.
  update(dt, level) {
    this.level = level;
    // Sum of MODES waves of amplitude A has rms A * sqrt(MODES / 2).
    this.amp = level * Math.sqrt(2 / MODES);
    if (level <= 0) return;
    const rng = this.rng;
    const turn = Math.sqrt(dt) * 0.9; // directions wander, so no band lasts
    for (let m = 0; m < MODES; m++) {
      this.th[m] += (rng() - 0.5) * 2 * turn;
      // A wave travels about one eddy size per turnover: speed ~ level.
      this.ph[m] += this.w[m] * this.k[m] * (8 + 0.5 * level) * dt;
      if (this.ph[m] > 1e4 || this.ph[m] < -1e4) this.ph[m] %= 2 * Math.PI;
    }
    this._dirs();
  }

  // Velocity of the field at (x, y) into this.tu / this.tv.
  sample(x, y) {
    // psi = sum sin(k.x + ph) / |k|; its gradient is sum cos(k.x + ph) * k / |k|.
    let psi = 0, px = 0, py = 0;
    const { kx, ky, k, ph } = this;
    for (let m = 0; m < MODES; m++) {
      const a = kx[m] * x + ky[m] * y + ph[m];
      const ik = 1 / k[m];
      const c = Math.cos(a);
      psi += Math.sin(a) * ik;
      px += kx[m] * c * ik;
      py += ky[m] * c * ik;
    }
    // F = fx(x) fy(y), each 1 - e^(-d/L) from both walls, and their derivatives.
    const iL = this.iL;
    const ex0 = Math.exp(-x * iL), ex1 = Math.exp(-(this.W - x) * iL);
    const ey0 = Math.exp(-y * iL), ey1 = Math.exp(-(this.H - y) * iL);
    const fx = Math.max(0, 1 - ex0 - ex1), fy = Math.max(0, 1 - ey0 - ey1);
    const dfx = (ex0 - ex1) * iL, dfy = (ey0 - ey1) * iL;
    // u = d(psi F)/dy, v = -d(psi F)/dx
    const a = this.amp;
    this.tu = a * fx * (fy * py + psi * dfy);
    this.tv = -a * fy * (fx * px + psi * dfx);
  }
}
