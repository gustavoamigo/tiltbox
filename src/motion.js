// Effective gravity felt by the contents of the box, in the simulation frame, in m/s²:
//   x right, y down (toward the device's bottom edge), z into the screen (toward the back glass).
//
// A phone's accelerometer reports proper acceleration f = a - g in the device frame (x right,
// y up, z out of the screen): lying face up, f = (0, 0, +9.81). The contents of a box that moves
// with the device feel g - a = -f. So the one reading covers both tilt and shake: shake the phone
// and the water sloshes the way it would in a real container. In the sim frame that is
// (-f.x, +f.y, +f.z).
//
// iOS has historically reported accelerationIncludingGravity with the opposite sign to the spec
// (and to Android). Rather than sniff the platform, the sign is checked against deviceorientation
// (beta, gamma), which both follow the spec, and corrected if they disagree.
//
// Without a sensor (desktop): arrow keys tilt the box, space shakes it, and dragging the browser
// window around accelerates the box with the window.

export const G = 9.81;
const MAX_G = 45; // clamp, m/s²: a phone flung hard reads 30-40; past that it is noise
const D2R = Math.PI / 180;
const WINDOW_PX_PER_M = 3780; // 96 CSS px per inch
const WINDOW_GAIN = 2.5; // window drags are gentle; make them count

function clampMag(v, max) {
  const m = Math.hypot(v.x, v.y, v.z);
  if (m > max) {
    const s = max / m;
    v.x *= s; v.y *= s; v.z *= s;
  }
  return v;
}

export class Motion {
  constructor(params) {
    this.g = { x: 0, y: G, z: 0 };
    this.shake = 0; // how hard the box is being shaken right now, m/s² (high-passed |g|)
    this.source = 'desktop'; // 'sensor' | 'desktop' | 'override'
    this.permission = 'unknown';
    this.t = 0; // motion clock, advanced by update(dt)

    // Sign of accelerationIncludingGravity relative to the spec: +1 spec, -1 inverted.
    this.sign = 1;
    this.signLocked = false;
    this.signVotes = 0;
    this.heur = { n: 0, sum: 0 }; // fallback guess from how phones are usually held
    const flip = params && params.get('flip');
    if (flip === '1' || flip === '0') {
      this.sign = flip === '1' ? -1 : 1;
      this.signLocked = true;
    }

    this.raw = null; // latest accelerationIncludingGravity {x, y, z}, device frame, as reported
    this.rawAt = 0;
    this.firstRawAt = 0;
    this.orient = null; // latest {beta, gamma}
    this.sensorG = { x: 0, y: G, z: 0 }; // smoothed sensor gravity, sim frame

    this.override = null;
    this.pulses = [];
    this.lp = { x: 0, y: G, z: 0 }; // g low-passed over 0.35 s: the tilt without the shake (env.gSlow)

    this.tilt = 0; // desktop: radians, + = right edge down
    this.tiltHome = false;
    this.keys = new Set();
    this.win = null;

    this._attach();
  }

  _attach() {
    window.addEventListener('devicemotion', (e) => this._onMotion(e));
    window.addEventListener('deviceorientation', (e) => this._onOrientation(e));
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.key;
      if (k === ' ' || k === 'Spacebar') {
        e.preventDefault();
        if (!e.repeat) {
          if (e.shiftKey) this.pulse(30, 0.6, 0, 1, 6);
          else this.pulse(30, 0.6, 1, 0, 7);
        }
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'a' || k === 'd' || k === 'A' || k === 'D') this.keys.add(k.toLowerCase());
      if (k === 'ArrowDown' || k === 'r' || k === 'R') this.tiltHome = true;
      if (k === 'ArrowUp') this.tilt += Math.PI; // turn the box over
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Call first thing inside a user-gesture handler (iOS only grants it from a gesture).
  // Asks for motion and orientation together so the second request still has the gesture.
  requestPermission() {
    const DME = window.DeviceMotionEvent;
    const DOE = window.DeviceOrientationEvent;
    const asks = [];
    if (DME && typeof DME.requestPermission === 'function') asks.push(DME.requestPermission());
    if (DOE && typeof DOE.requestPermission === 'function') asks.push(DOE.requestPermission());
    if (!asks.length) {
      this.permission = 'not-needed';
      return Promise.resolve(this.permission);
    }
    return Promise.all(asks.map((p) => p.catch(() => 'denied'))).then((rs) => {
      this.permission = rs[0];
      return rs[0];
    });
  }

  _onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return;
    const now = performance.now();
    if (!this.raw) this.firstRawAt = now;
    this.raw = { x: a.x, y: a.y, z: a.z };
    this.rawAt = now;
    if (this.source !== 'override') this.source = 'sensor';
    if (!this.signLocked) {
      // Fallback guess: phones are held screen-up and top-up, which is f.y + f.z > 0 per spec.
      this.heur.n++;
      this.heur.sum += a.y + a.z;
      if (this.heur.n === 3 && this.signVotes === 0) this.sign = this.heur.sum / 3 < -3 ? -1 : 1;
      if (!this.orient && now - this.firstRawAt > 2000) {
        this.sign = this.heur.sum / this.heur.n < -2 ? -1 : 1;
        this.signLocked = true;
      }
    }
  }

  _onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    this.orient = { beta: e.beta, gamma: e.gamma };
    if (this.signLocked || !this.raw || performance.now() - this.rawAt > 100) return;
    // Direction f should have per spec, from the device's attitude.
    const b = e.beta * D2R;
    const gm = e.gamma * D2R;
    const ex = -Math.cos(b) * Math.sin(gm);
    const ey = Math.sin(b);
    const ez = Math.cos(b) * Math.cos(gm);
    const r = this.raw;
    const mag = Math.hypot(r.x, r.y, r.z);
    if (mag < 7 || mag > 12.5) return; // only while the phone is roughly still
    const c = (r.x * ex + r.y * ey + r.z * ez) / mag;
    if (Math.abs(c) < 0.6) return;
    this.signVotes += Math.sign(c);
    this.sign = this.signVotes >= 0 ? 1 : -1;
    if (Math.abs(this.signVotes) >= 8) this.signLocked = true;
  }

  // A synthetic shake: the box oscillates along (dirX, dirY) with peak acceleration amp (m/s²).
  pulse(amp = 30, dur = 0.6, dirX = 1, dirY = 0, freq = 7) {
    const n = Math.hypot(dirX, dirY) || 1;
    this.pulses.push({ t0: this.t, dur, amp, dx: dirX / n, dy: dirY / n, freq });
  }

  setOverride(g) {
    this.override = g ? { x: g.x, y: g.y, z: g.z || 0 } : null;
    if (this.override) this.source = 'override';
    else this.source = this.raw ? 'sensor' : 'desktop';
  }

  sensorActive() {
    return this.raw && performance.now() - this.rawAt < 1500;
  }

  update(dt) {
    this.t += dt;
    const g = this.g;

    if (this.override) {
      g.x = this.override.x; g.y = this.override.y; g.z = this.override.z;
    } else if (this.raw && this.source === 'sensor') {
      const s = this.sign;
      const tx = -s * this.raw.x;
      const ty = s * this.raw.y;
      const tz = s * this.raw.z;
      // Barely smoothed: shakes must come through. 15 ms takes the edge off sensor noise.
      const k = 1 - Math.exp(-dt / 0.015);
      const sg = this.sensorG;
      sg.x += (tx - sg.x) * k; sg.y += (ty - sg.y) * k; sg.z += (tz - sg.z) * k;
      g.x = sg.x; g.y = sg.y; g.z = sg.z;
    } else {
      this._desktop(dt, g);
    }

    // Synthetic shakes: the box accelerates by a(t); the contents feel -a(t).
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      const u = (this.t - p.t0) / p.dur;
      if (u >= 1) { this.pulses.splice(i, 1); continue; }
      const a = p.amp * Math.sin(2 * Math.PI * p.freq * (this.t - p.t0)) * Math.sin(Math.PI * u);
      g.x -= a * p.dx;
      g.y -= a * p.dy;
    }
    clampMag(g, MAX_G);

    // Shake meter: distance from a slow average, peak-held with a short decay.
    const k = 1 - Math.exp(-dt / 0.35);
    const lp = this.lp;
    lp.x += (g.x - lp.x) * k; lp.y += (g.y - lp.y) * k; lp.z += (g.z - lp.z) * k;
    const d = Math.hypot(g.x - lp.x, g.y - lp.y, g.z - lp.z);
    this.shake = Math.max(d, this.shake * Math.exp(-dt / 0.25));
    return g;
  }

  _desktop(dt, g) {
    const rate = 2.4; // rad/s
    if (this.keys.has('arrowleft') || this.keys.has('a')) { this.tilt -= rate * dt; this.tiltHome = false; }
    if (this.keys.has('arrowright') || this.keys.has('d')) { this.tilt += rate * dt; this.tiltHome = false; }
    if (this.tiltHome) {
      const target = Math.round(this.tilt / (2 * Math.PI)) * 2 * Math.PI;
      this.tilt += (target - this.tilt) * (1 - Math.exp(-dt / 0.12));
      if (Math.abs(target - this.tilt) < 1e-3) { this.tilt = target; this.tiltHome = false; }
    }
    g.x = G * Math.sin(this.tilt);
    g.y = G * Math.cos(this.tilt);
    g.z = 0;

    // The browser window as the box: drag it around and the contents lag behind.
    const sx = window.screenX;
    const sy = window.screenY;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || dt <= 0) return;
    const w = this.win;
    if (!w) {
      this.win = { x: sx, y: sy, vx: 0, vy: 0, ax: 0, ay: 0 };
      return;
    }
    const kv = 1 - Math.exp(-dt / 0.04);
    const vx = w.vx + ((sx - w.x) / dt - w.vx) * kv;
    const vy = w.vy + ((sy - w.y) / dt - w.vy) * kv;
    const ka = 1 - Math.exp(-dt / 0.05);
    w.ax += ((vx - w.vx) / dt - w.ax) * ka;
    w.ay += ((vy - w.vy) / dt - w.ay) * ka;
    w.vx = vx; w.vy = vy; w.x = sx; w.y = sy;
    g.x -= (w.ax / WINDOW_PX_PER_M) * WINDOW_GAIN;
    g.y -= (w.ay / WINDOW_PX_PER_M) * WINDOW_GAIN;
  }

  status() {
    const r = this.raw;
    return {
      source: this.source,
      permission: this.permission,
      sign: this.sign,
      signLocked: this.signLocked,
      votes: this.signVotes,
      raw: r ? `${r.x.toFixed(2)} ${r.y.toFixed(2)} ${r.z.toFixed(2)}` : '-',
      orient: this.orient ? `${this.orient.beta.toFixed(0)} ${this.orient.gamma.toFixed(0)}` : '-',
    };
  }
}
