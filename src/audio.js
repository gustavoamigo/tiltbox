// Synthesised sound for the box. No sample files: every sound is made with Web Audio.
//
// Contract (modes call only this):
//   audio.unlock()                      call inside a user gesture (iOS starts audio only from one)
//   audio.enabled                       get/set; persisted by main.js
//   audio.impact(kind, intensity, pitch = 1)
//       one-shot hit. kind: 'glass' | 'rubber' | 'grain' | 'drop' | 'chime'
//       intensity 0..1 (amplitude, also brightness), pitch: multiplier around the kind's base
//       (clamped to 0.25..4; 0.5..2 sounds best). 'chime' is always G6 × pitch, so pitch is its note.
//       Cheap to call; the engine limits voices and rate, so modes may call it freely per contact.
//   audio.bed(kind) -> { set(level, tone), stop() }
//       a continuous texture. kind: 'water' | 'honey' | 'sand' | 'swirl'
//       level 0..1 (how much is moving), tone 0..1 (how bright/fast). Call set() every frame.
//   audio.suspend() / audio.resume()    page hidden / shown (main.js)
// Unknown kinds are ignored. Everything is a no-op before unlock, while disabled and while the
// context is suspended. Outside the contract: audio.stats() for tests, and createSynth(ctx), the
// same graph on an OfflineAudioContext so the sounds can be measured without ears (docs/audio.md).
//
// How it works:
// - Impacts are rendered in JS once, after unlock, into a small bank of short stereo buffers per
//   kind (a few brightness levels × a few random takes). A hit is one AudioBufferSourceNode and
//   one GainNode, the cheapest thing Web Audio plays.
// - impact() only records a candidate. A microtask after the current task (the frame) plays the
//   loudest few of each kind, within a per-kind token bucket and a global cap of 24 voices; a new
//   hit steals the quietest voice if it is louder, else it is dropped.
// - Beds are looping noise through filters, steered with setTargetAtTime at most 30 times a second.
// - Everything goes master gain (mute) -> compressor -> soft clipper -> speakers, so a hundred
//   simultaneous clacks get louder only a little and the output never reaches 1.

const IMPACT_KINDS = ['glass', 'rubber', 'grain', 'drop', 'chime'];
const KIND_INDEX = new Map(IMPACT_KINDS.map((k, i) => [k, i]));
const BED_KINDS = new Set(['water', 'honey', 'sand', 'swirl']);
const DROP = 3;

const MAX_VOICES = 24;
const MIN_INTENSITY = 0.015; // quieter hits vanish under anything else playing
const SPREAD_S = 0.012; // hits from one frame start spread over this: a rattle, not a flam
const BED_UPDATE_S = 1 / 30; // beds steer their params at most this often
const MAX_PARTIAL_HZ = 11000; // a partial played at pitch 2 stays below Nyquist at 44.1 kHz
const TWO_PI = 2 * Math.PI;

// Per impact kind.
//   gain     level of a full-intensity hit into the master chain (takes are at 0.5 short-term RMS);
//            amplitude is gain × intensity
//   tau      decay time constant of the take, s: how loud a playing voice still is, for stealing
//   rate     token bucket refill, hits/s; burst: most saved up
//   perFrame most hits of the kind kept from one frame, loudest first
//   jitter   random playbackRate spread, so repeats differ (chimes stay in tune: the caller's pitch
//            is the note)
//   levels   brightness of the pre-rendered takes, soft hit .. hard hit; takes: random takes each
const IMPACTS = [
  { gain: 0.45, tau: 0.015, rate: 120, burst: 16, perFrame: 8, jitter: 0.06, levels: [0.35, 0.65, 1], takes: 4, synth: synthGlass },
  { gain: 0.45, tau: 0.05, rate: 40, burst: 8, perFrame: 4, jitter: 0.06, levels: [0.4, 1], takes: 3, synth: synthRubber },
  { gain: 0.30, tau: 0.002, rate: 140, burst: 12, perFrame: 8, jitter: 0.12, levels: [0.5, 1], takes: 4, synth: synthGrain },
  { gain: 0.42, tau: 0.013, rate: 30, burst: 6, perFrame: 4, jitter: 0.08, levels: [1], takes: 6, synth: synthDrop },
  { gain: 0.18, tau: 0.25, rate: 16, burst: 5, perFrame: 3, jitter: 0.003, levels: [0.5, 1], takes: 4, synth: synthChime },
];

// ---------------------------------------------------------------- sample synthesis (pure JS)

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Adds amp·e^(−t/tau)·sin(2πft + phase): one ringing mode, as a rotating phasor (no sin per sample).
function addMode(out, sr, f, amp, tau, phase) {
  if (f >= MAX_PARTIAL_HZ || amp === 0) return;
  const r = Math.exp(-1 / (tau * sr));
  const w = (TWO_PI * f) / sr;
  const c = r * Math.cos(w), s = r * Math.sin(w);
  let re = amp * Math.cos(phase), im = amp * Math.sin(phase);
  const n = Math.min(out.length, Math.ceil(tau * sr * 9.3)); // down to −80 dB
  for (let i = 0; i < n; i++) {
    out[i] += im;
    const t = re * c - im * s;
    im = re * s + im * c;
    re = t;
  }
}

// A burst of noise decaying with tau: the contact click. color 1 bright (differenced), 0 white,
// −1 dull (one-pole low-pass near 1.5 kHz).
function addClick(out, sr, amp, tau, rand, color) {
  const n = Math.min(out.length, Math.ceil(tau * sr * 7));
  const k = Math.exp(-1 / (tau * sr));
  const lp = Math.exp((-TWO_PI * 1500) / sr);
  let e = amp, prev = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    if (color > 0) y = (x - prev) * 0.5;
    else if (color < 0) y = x * (1 - lp) * 3 + y * lp;
    else y = x;
    out[i] += y * e;
    prev = x;
    e *= k;
  }
}

// RBJ band-pass (0 dB peak), src -> dst.
function bandpass(src, dst, sr, f, q) {
  const w = (TWO_PI * f) / sr, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    dst[i] += y;
  }
}

// Raised-cosine fades: takes the edge off a mathematically sharp onset, and ends a take at zero.
function fadeIn(out, sr, s) {
  const n = Math.min(out.length, Math.round(s * sr));
  for (let i = 0; i < n; i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
}
function fadeOut(out, sr, s) {
  const n = Math.min(out.length, Math.round(s * sr));
  const o = out.length - n;
  for (let i = 0; i < n; i++) out[o + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / n);
}

// Glass marble clack: inharmonic modes 1.5–6 kHz that die in tens of ms, a 1 kHz knock (what
// makes it a clack rather than a ting) and a bright contact click. Soft hits lose the top modes.
const GLASS_RATIO = [0.72, 1, 1.43, 1.97, 2.66];
const GLASS_AMP = [0.35, 1, 0.85, 0.6, 0.45];
const GLASS_TAU = [0.011, 0.012, 0.009, 0.0065, 0.0045];
function synthGlass(sr, b, rand) {
  const out = new Float32Array(Math.round(0.12 * sr));
  const f1 = 2300 * (0.9 + 0.2 * rand());
  for (let i = 0; i < GLASS_RATIO.length; i++) {
    addMode(out, sr, f1 * GLASS_RATIO[i] * (0.98 + 0.04 * rand()), GLASS_AMP[i] * (0.65 + 0.7 * rand()) * b ** (0.55 * i),
      GLASS_TAU[i] * (0.8 + 0.4 * rand()), TWO_PI * rand());
  }
  addMode(out, sr, 1050 * (0.85 + 0.3 * rand()), 0.35, 0.0035, 0);
  addClick(out, sr, 0.55 * Math.sqrt(b), 0.0003, rand, 1);
  fadeIn(out, sr, 0.0002);
  fadeOut(out, sr, 0.01);
  return out;
}

// Bouncy ball: a low sine whose pitch falls as the ball unsquashes, the shell's 'pok' and a dull
// click. A phone speaker plays almost nothing at 200 Hz, so the body also has its second mode
// (×2.3, as a drum membrane's) gliding with it, and tanh adds harmonics: the drop is heard there too.
const RUBBER_MODE2 = 2.3;
function synthRubber(sr, b, rand) {
  const out = new Float32Array(Math.round(0.2 * sr));
  const f0 = 210 * (0.85 + 0.3 * rand());
  const over = 0.45 + 0.7 * b; // the pitch starts this much above f0
  const tauA = 0.025 * (0.85 + 0.3 * rand());
  const drive = 1.6, norm = 1 / Math.tanh(drive);
  const kF = Math.exp(-1 / (0.011 * sr)), kA = Math.exp(-1 / (tauA * sr)), w0 = (TWO_PI * f0) / sr;
  const k2 = Math.exp(-1 / (0.55 * tauA * sr));
  let ph = 0, ph2 = TWO_PI * rand(), bend = over, env = drive, env2 = 0.3 + 0.25 * b;
  for (let i = 0; i < out.length; i++) {
    const w = w0 * (1 + bend);
    ph += w;
    ph2 += w * RUBBER_MODE2;
    const x = Math.sin(ph) * env;
    out[i] = ((x * (27 + x * x)) / (27 + 9 * x * x)) * norm + Math.sin(ph2) * env2; // Padé tanh, exact enough for |x| < 3
    bend *= kF;
    env *= kA;
    env2 *= k2;
  }
  addMode(out, sr, 720 * (0.85 + 0.3 * rand()), 0.35 * b, 0.006, TWO_PI * rand());
  addClick(out, sr, 0.25 * b, 0.0006, rand, -1);
  fadeIn(out, sr, 0.0012);
  fadeOut(out, sr, 0.02);
  return out;
}

// One grain of sand: a sub-millisecond noise burst through a resonance at 3–7 kHz.
function synthGrain(sr, b, rand) {
  const out = new Float32Array(Math.round(0.03 * sr));
  const burst = new Float32Array(out.length);
  addClick(burst, sr, 1, 0.0007 * (0.8 + 0.5 * rand()), rand, 0);
  const fc = (3800 + 3400 * rand()) * (0.75 + 0.25 * b);
  bandpass(burst, out, sr, fc, 2.2);
  addMode(out, sr, fc * (0.97 + 0.06 * rand()), 0.25, 0.0025, TWO_PI * rand());
  fadeOut(out, sr, 0.005);
  return out;
}

// Water droplet: a bubble's sine whose pitch rises ×1.9–2.7 within 35 ms (the 'ip' of 'plip').
function synthDrop(sr, b, rand) {
  const out = new Float32Array(Math.round(0.08 * sr));
  const f0 = 820 * (0.85 + 0.3 * rand());
  const k = Math.log(1.9 + 0.8 * rand()) / 0.035;
  const tauA = 0.01 * (0.85 + 0.35 * rand());
  const rise = Math.exp(k / sr), kA = Math.exp(-1 / (tauA * sr)), stop = Math.round(0.05 * sr);
  let ph = 0, w = (TWO_PI * f0) / sr, env = 1;
  for (let i = 0; i < out.length; i++) {
    ph += w;
    out[i] = Math.sin(ph) * env;
    if (i < stop) w *= rise;
    env *= kA;
  }
  fadeIn(out, sr, 0.0015);
  fadeOut(out, sr, 0.01);
  return out;
}

// Small bell / glitter: bar modes (1, 2.76, 5.40, 8.93) with a near-unison twin for shimmer. Every
// take is G6 (1568 Hz), so pitch is the note: pass scale ratios (1, 9/8, 5/4, 3/2, 5/3, 2) for a tune.
const CHIME_HZ = 1568;
function synthChime(sr, b, rand) {
  const out = new Float32Array(Math.round(0.7 * sr));
  const f1 = CHIME_HZ;
  addMode(out, sr, f1, 1, 0.3, 0);
  addMode(out, sr, f1 + 1.5 + 2 * rand(), 0.4, 0.3, TWO_PI * rand());
  addMode(out, sr, f1 * 2.76, 0.35 * b, 0.1, TWO_PI * rand());
  addMode(out, sr, f1 * 5.4, 0.15 * b, 0.045, TWO_PI * rand());
  addMode(out, sr, f1 * 8.93, 0.06 * b, 0.02, TWO_PI * rand());
  addClick(out, sr, 0.2 * b, 0.00025, rand, 1);
  fadeIn(out, sr, 0.0004);
  fadeOut(out, sr, 0.15);
  return out;
}

// Scale that brings the loudest 2 ms of m to an RMS of 0.5 (a sine peaking at 0.7). Normalising
// by short-term RMS rather than sample peak keeps takes equally loud: the peak of a clack is a
// one-sample contact spike that says little about how loud it sounds.
function loudnessScale(m, sr) {
  const w = Math.max(1, Math.round(0.002 * sr));
  let top = 0, peak = 0;
  for (let o = 0; o < m.length; o += w) {
    let e = 0;
    const end = Math.min(m.length, o + w);
    for (let i = o; i < end; i++) { e += m[i] * m[i]; peak = Math.max(peak, Math.abs(m[i])); }
    top = Math.max(top, e / (end - o));
  }
  return Math.min(0.5 / Math.sqrt(top), 1.5 / peak);
}

// Take v of kind k at brightness level li, at sample rate sr: { l, r }, loudness-normalised and
// panned a little left or right (alternately), so a rattle is wide on headphones.
function renderTake(sr, k, li, v) {
  const spec = IMPACTS[k];
  const rand = mulberry32(7919 * (k + 1) + 104729 * li + 1299709 * v);
  const m = spec.synth(sr, spec.levels[li], rand);
  const scale = loudnessScale(m, sr);
  const p = (v % 2 ? 1 : -1) * (0.1 + 0.25 * rand());
  const gl = (p > 0 ? 1 - p : 1) * scale, gr = (p < 0 ? 1 + p : 1) * scale;
  const l = new Float32Array(m.length), r = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) { l[i] = m[i] * gl; r[i] = m[i] * gr; }
  return { l, r };
}

function whiteNoise(n, rand) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

// Sand texture: Poisson-distributed grains (~2500/s), each about a millisecond of decaying noise,
// amplitudes 0.25..1 (no rare loud grain to set off the compressor). Wraps around, so it loops
// without a seam.
function crackle(n, sr, rand) {
  const out = new Float32Array(n);
  const count = Math.round((2500 * n) / sr);
  for (let g = 0; g < count; g++) {
    const at = Math.floor(rand() * n);
    const a = (0.25 + 0.75 * rand()) * (rand() < 0.5 ? -1 : 1);
    const k = Math.exp(-1 / ((0.00008 + 0.00017 * rand()) * sr));
    let e = a;
    for (let j = 0; e * e > 1e-8 && j < n; j++) {
      out[(at + j) % n] += (rand() * 2 - 1) * e;
      e *= k;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

// Output stage curve: unity below 0.7, then a tanh knee that ends at 0.92 for input ±1 (and
// WaveShaper clamps beyond ±1), so the output can never reach full scale.
function softClipCurve() {
  const n = 2049, knee = 0.7, room = 0.27;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

// Ornstein–Uhlenbeck step with unit stationary spread and time constant theta (s): slow random
// wandering for filter centres and grain density, so a steady bed never sounds like a loop.
function wander(w, dt, theta) {
  const k = Math.exp(-dt / theta);
  const n = (Math.random() + Math.random() + Math.random() - 1.5) * 2; // ≈ N(0, 1)
  return w * k + Math.sqrt(1 - k * k) * n;
}

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

// ---------------------------------------------------------------- the graph, for any BaseAudioContext

// Builds the master chain, the impact voices and the beds on ctx (an AudioContext or an
// OfflineAudioContext). Times are context seconds and explicit, so an offline render can script
// a whole scene before startRendering(). No rate limiting here: that is createAudio's job.
export function createSynth(ctx) {
  const sr = ctx.sampleRate;
  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 6;
  comp.ratio.value = 12;
  comp.attack.value = 0.002;
  comp.release.value = 0.15;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = 'none';
  master.connect(comp);
  comp.connect(clip);
  clip.connect(ctx.destination);

  // ------------------------------------------------ impact voices

  const banks = new Array(IMPACTS.length).fill(null); // banks[k][level][take]: AudioBuffer, once complete
  const rows = IMPACTS.map(() => [[]]); // per kind, per level: the takes rendered so far
  const lastTake = new Int32Array(IMPACTS.length).fill(-1);
  const vSrc = new Array(MAX_VOICES).fill(null);
  const vGain = new Array(MAX_VOICES).fill(null);
  const vStart = new Float64Array(MAX_VOICES);
  const vEnd = new Float64Array(MAX_VOICES); // 0: free
  const vAmp = new Float64Array(MAX_VOICES);
  const vTau = new Float64Array(MAX_VOICES);
  // Finished or stolen voices are disconnected once the context clock has passed their end. An
  // offline render is scripted before it runs, so there nothing is ever disconnected.
  const tidy = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
  const RETIRE = 32;
  const rGain = new Array(RETIRE).fill(null);
  const rAt = new Float64Array(RETIRE);
  let rNext = 0;
  let peakVoices = 0;
  // Recent hit density: voice starts in about the last 80 ms, exponentially weighted. Each hit is
  // scaled by 1/sqrt(1 + density/4), so a dense rattle sums to a few dB over one clack, not +14.
  let density = 0, densityAt = 0;

  function toBuffer({ l, r }) {
    const buf = ctx.createBuffer(2, l.length, sr);
    buf.getChannelData(0).set(l);
    buf.getChannelData(1).set(r);
    return buf;
  }
  // Renders the next take of the first incomplete kind: about a millisecond of work on a desktop.
  // A kind plays once all its takes are in. Returns false when there is nothing left to render.
  function prepareStep() {
    for (let k = 0; k < IMPACTS.length; k++) {
      if (banks[k]) continue;
      const spec = IMPACTS[k], rk = rows[k];
      let row = rk[rk.length - 1];
      if (row.length === spec.takes) { row = []; rk.push(row); }
      row.push(toBuffer(renderTake(sr, k, rk.length - 1, row.length)));
      if (rk.length === spec.levels.length && row.length === spec.takes) banks[k] = rk;
      return true;
    }
    return false;
  }

  function retire(g, at) {
    if (!tidy) return;
    rGain[rNext] = g; // a full ring forgets its oldest: the garbage collector's job then
    rAt[rNext] = at;
    rNext = (rNext + 1) % RETIRE;
  }
  function sweep() {
    const now = ctx.currentTime;
    for (let j = 0; j < RETIRE; j++) {
      if (rGain[j] && rAt[j] <= now) {
        try { rGain[j].disconnect(); } catch { /* already */ }
        rGain[j] = null;
      }
    }
  }

  // A slot for a new voice of loudness amp starting at `at`: a free one, else the quietest playing
  // voice if it is quieter than the new one (faded out over ~5 ms), else -1.
  function takeSlot(amp, at) {
    if (tidy) sweep();
    let quiet = -1, quietLoud = Infinity;
    for (let i = 0; i < MAX_VOICES; i++) {
      if (vEnd[i] <= at) {
        if (vGain[i]) { retire(vGain[i], vEnd[i] + 0.01); vGain[i] = null; vSrc[i] = null; }
        return i;
      }
      const age = at - vStart[i];
      const loud = age > 0 ? vAmp[i] * Math.exp(-age / vTau[i]) : vAmp[i];
      if (loud < quietLoud) { quietLoud = loud; quiet = i; }
    }
    if (amp <= quietLoud) return -1;
    vGain[quiet].gain.setTargetAtTime(0, at, 0.0015);
    try { vSrc[quiet].stop(at + 0.012); } catch { /* stop() twice on old WebKit */ }
    retire(vGain[quiet], at + 0.02);
    vGain[quiet] = null;
    vSrc[quiet] = null;
    return quiet;
  }

  // One hit of kind k. intensity in (0, 1], pitch in [0.25, 4]. Returns whether it got a voice.
  function play(k, intensity, pitch, at) {
    const bank = banks[k];
    if (!bank) return false;
    const spec = IMPACTS[k];
    if (at > densityAt) { density *= Math.exp((densityAt - at) / 0.08); densityAt = at; }
    const amp = (spec.gain * intensity) / Math.sqrt(1 + density / 4);
    const slot = takeSlot(amp, at);
    if (slot < 0) return false;
    density += 1;
    const li = Math.min(bank.length - 1, Math.max(0, Math.floor(intensity * bank.length + (Math.random() - 0.5) * 0.7)));
    const row = bank[li];
    let ti = Math.floor(Math.random() * row.length);
    if (ti === lastTake[k] && row.length > 1) ti = (ti + 1) % row.length; // no machine-gun repeats
    lastTake[k] = ti;
    const rate = Math.min(4, Math.max(0.25, pitch * (1 + (Math.random() - 0.5) * spec.jitter)));
    const buf = row[ti];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = amp;
    src.connect(g);
    g.connect(master);
    src.start(at);
    vSrc[slot] = src;
    vGain[slot] = g;
    vStart[slot] = at;
    vEnd[slot] = at + buf.duration / rate;
    vAmp[slot] = amp;
    vTau[slot] = spec.tau / rate;
    const n = voices(at);
    if (n > peakVoices) peakVoices = n;
    return true;
  }

  function voices(at) {
    let n = 0;
    for (let i = 0; i < MAX_VOICES; i++) if (vEnd[i] > at) n++;
    return n;
  }

  // ------------------------------------------------ beds

  let noiseBuf = null, crackleBuf = null;
  function stereo(make) {
    const n = Math.round(2 * sr); // 2 s loops, independent channels
    const buf = ctx.createBuffer(2, n, sr);
    buf.getChannelData(0).set(make(n));
    buf.getChannelData(1).set(make(n));
    return buf;
  }
  function noise() {
    if (!noiseBuf) { const rand = mulberry32(12345); noiseBuf = stereo((n) => whiteNoise(n, rand)); }
    return noiseBuf;
  }
  function grains() {
    if (!crackleBuf) { const rand = mulberry32(777); crackleBuf = stereo((n) => crackle(n, sr, rand)); }
    return crackleBuf;
  }
  function loop(buf) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(ctx.currentTime, Math.random() * buf.duration);
    return s;
  }
  function filter(type, f, q) {
    const n = ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    return n;
  }
  function gain(v) {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  }
  function chain(...nodes) {
    for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]);
  }
  const steer = (param, v, at, tau) => param.setTargetAtTime(v, at, tau);

  // A bed: sources -> ... -> out -> master. update(level, tone, at, dt) steers params at most every
  // BED_UPDATE_S (dt: since its last run); tick(level, tone, at, dt) runs on every set(), for
  // random extras such as bubbles.
  function makeBed(sources, out, update, tick) {
    out.connect(master);
    let lastAt = -1, lastUpdate = -1, stopped = false;
    return {
      set(level, tone, at) {
        if (stopped) return;
        const dt = lastAt < 0 ? 0 : Math.min(Math.max(at - lastAt, 0), 0.1);
        lastAt = at;
        if (tick && dt > 0) tick(level, tone, at, dt);
        if (lastUpdate >= 0 && at - lastUpdate < BED_UPDATE_S) return;
        update(level, tone, at, lastUpdate < 0 ? 0 : Math.min(at - lastUpdate, 0.25));
        lastUpdate = at;
      },
      refresh() { lastUpdate = -1; },
      stop(at) {
        if (stopped) return;
        stopped = true;
        out.gain.cancelScheduledValues(at);
        out.gain.setTargetAtTime(0, at, 0.04);
        sources[0].onended = () => out.disconnect();
        for (const s of sources) s.stop(at + 0.3);
      },
    };
  }

  // Slosh: noise through a band-pass whose centre follows tone and wanders, plus a splashy fizz
  // when fast and bubbles (pitched-down drops) that gurgle more the more the water moves.
  function water() {
    const src = loop(noise());
    const bp = filter('bandpass', 500, 0.9), lp = filter('lowpass', 1500, 0.6), body = gain(0);
    const hp = filter('highpass', 3000, 0.5), fizz = gain(0), out = gain(1);
    chain(src, bp, lp, body, out);
    chain(src, hp, fizz, out);
    let w = 0;
    return makeBed([src], out, (level, tone, at, dt) => {
      w = wander(w, dt, 0.35);
      const f = (300 + 800 * tone) * 2 ** (0.35 * w);
      steer(bp.frequency, f, at, 0.06);
      steer(lp.frequency, 2.4 * f + 300, at, 0.06);
      steer(body.gain, 0.5 * level ** 1.5, at, 0.05);
      steer(fizz.gain, 0.012 * level * tone * tone, at, 0.04);
    }, (level, tone, at, dt) => {
      if (Math.random() < 14 * level * (0.3 + tone) * dt) {
        play(DROP, (0.06 + 0.2 * Math.random()) * level, 0.38 + 0.35 * Math.random(), at + Math.random() * dt);
      }
    });
  }

  // Honey: the same idea darker and slower: a resonant low-pass, long time constants, and now
  // and then a big slow bloop. The high-pass removes rumble a phone speaker cannot play anyway.
  function honey() {
    const src = loop(noise());
    const hp = filter('highpass', 200, 0.7), lp1 = filter('lowpass', 450, 1.6), lp2 = filter('lowpass', 600, 0.7);
    const body = gain(0), out = gain(1);
    chain(src, hp, lp1, lp2, body, out);
    let w = 0;
    return makeBed([src], out, (level, tone, at, dt) => {
      w = wander(w, dt, 0.8);
      const f = (400 + 450 * tone) * 2 ** (0.25 * w);
      steer(hp.frequency, 0.5 * f, at, 0.2);
      steer(lp1.frequency, f, at, 0.2);
      steer(lp2.frequency, 1.3 * f, at, 0.2);
      steer(body.gain, 0.55 * level ** 1.5, at, 0.18);
    }, (level, tone, at, dt) => {
      if (Math.random() < 2.5 * level * (0.4 + tone) * dt) {
        play(DROP, (0.12 + 0.22 * Math.random()) * level, 0.24 + 0.12 * Math.random(), at);
      }
    });
  }

  // Sand: the crackle loop high-passed (grains), played faster and brighter with tone, its level
  // fluttering like a stream that thins and thickens; a little air on top.
  function sand() {
    const src = loop(grains()), hiss = loop(noise());
    const hp = filter('highpass', 2500, 0.7), lp = filter('lowpass', 7000, 0.5), body = gain(0);
    const hp2 = filter('highpass', 6000, 0.5), air = gain(0), out = gain(1);
    chain(src, hp, lp, body, out);
    chain(hiss, hp2, air, out);
    let w = 0;
    return makeBed([src, hiss], out, (level, tone, at, dt) => {
      w = wander(w, dt, 0.12);
      steer(src.playbackRate, 0.7 + 0.7 * tone, at, 0.1);
      steer(hp.frequency, 1500 + 2500 * tone, at, 0.08);
      steer(lp.frequency, 5000 + 3500 * tone, at, 0.08);
      steer(body.gain, 0.85 * level * Math.max(0.2, 1 + 0.3 * w), at, 0.03);
      steer(air.gain, 0.015 * level * (0.4 + tone), at, 0.05);
    });
  }

  // Swirl: a soft whoosh, two band-passes an octave apart drifting slowly, under a low-pass that
  // keeps their skirts from hissing when it is fast.
  function swirl() {
    const src = loop(noise());
    const bp1 = filter('bandpass', 600, 1.4), g1 = gain(0);
    const bp2 = filter('bandpass', 1300, 3), g2 = gain(0), lp = filter('lowpass', 2000, 0.5), out = gain(1);
    chain(src, bp1, g1, lp, out);
    chain(src, bp2, g2, lp);
    let w = 0;
    return makeBed([src], out, (level, tone, at, dt) => {
      w = wander(w, dt, 0.6);
      const f = (300 + 1000 * tone) * 2 ** (0.35 * w);
      steer(bp1.frequency, f, at, 0.12);
      steer(bp2.frequency, 1.9 * f, at, 0.12);
      steer(lp.frequency, 2.6 * f + 500, at, 0.12);
      const a = level ** 1.3;
      steer(g1.gain, 0.45 * a, at, 0.12);
      steer(g2.gain, 0.2 * a, at, 0.12);
    });
  }

  const BEDS = { water, honey, sand, swirl };

  return {
    ctx,
    input: master, // the master chain's input: for measuring it
    prepareStep,
    prepareAll() { while (prepareStep()); },
    ready: (k) => banks[k] !== null,
    play,
    voices,
    get peakVoices() { return peakVoices; },
    bed: (kind) => (BED_KINDS.has(kind) ? BEDS[kind]() : null),
    setMute(muted, at) {
      master.gain.cancelScheduledValues(at);
      if (muted) master.gain.setValueAtTime(0, at);
      else master.gain.setTargetAtTime(1, at, 0.01);
    },
  };
}

// ---------------------------------------------------------------- the engine modes talk to

const NOOP_BED = Object.freeze({ set() {}, stop() {} });
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'];
const noop = () => {};

export function createAudio() {
  let ctx = null;
  let synth = null;
  let enabled = true;
  let hidden = false;
  let live = false; // unlocked, enabled, visible and the context running: the only state that does work
  let armed = false;
  const handles = new Set();

  // This frame's candidates: per kind, up to perFrame (and the tokens left), loudest kept.
  const NK = IMPACTS.length, PF = Math.max(...IMPACTS.map((s) => s.perFrame));
  const candI = new Float64Array(NK * PF), candP = new Float64Array(NK * PF);
  const candN = new Int32Array(NK), cap = new Int32Array(NK);
  const tokens = Float64Array.from(IMPACTS, (s) => s.burst);
  const order = new Int32Array(NK * PF), orderAmp = new Float64Array(NK * PF);
  let lastRefill = 0;
  let batchOpen = false;
  const count = { calls: 0, played: 0, limited: 0, noVoice: 0 };

  function openBatch() {
    batchOpen = true;
    const now = performance.now();
    const dt = Math.min((now - lastRefill) / 1000, 1);
    lastRefill = now;
    for (let k = 0; k < NK; k++) {
      const s = IMPACTS[k];
      tokens[k] = Math.min(s.burst, tokens[k] + s.rate * dt);
      cap[k] = synth.ready(k) ? Math.min(s.perFrame, Math.floor(tokens[k])) : 0;
    }
    queueMicrotask(flush);
  }

  // Plays this frame's candidates loudest first, so the voice cap keeps the loudest.
  function flush() {
    batchOpen = false;
    let n = 0;
    if (live) {
      for (let k = 0; k < NK; k++) {
        for (let j = 0; j < candN[k]; j++) {
          const id = k * PF + j, a = IMPACTS[k].gain * candI[id];
          let i = n++;
          while (i > 0 && orderAmp[i - 1] < a) { order[i] = order[i - 1]; orderAmp[i] = orderAmp[i - 1]; i--; }
          order[i] = id;
          orderAmp[i] = a;
        }
      }
      const t0 = ctx.currentTime;
      for (let i = 0; i < n; i++) {
        const id = order[i], k = (id / PF) | 0;
        if (synth.play(k, candI[id], candP[id], n > 1 ? t0 + Math.random() * SPREAD_S : t0)) { tokens[k] -= 1; count.played++; } else count.noVoice++;
      }
    }
    candN.fill(0);
  }

  function setLive() {
    const was = live;
    live = !!ctx && enabled && !hidden && ctx.state === 'running';
    if (live && !was) {
      lastRefill = performance.now();
      for (const h of handles) h.refresh();
    }
  }

  // Inside a gesture: a one-sample silent buffer unlocks iOS output, and resume() starts the clock.
  function kick() {
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
      if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(noop); }
    } catch { /* closed context */ }
  }

  // iOS can leave the context 'interrupted' (a call, another app, the page coming back) or refuse
  // resume() outside a gesture: then retry on every gesture until it runs.
  function onGesture() {
    if (ctx && enabled && !hidden) kick(); else disarm();
  }
  function arm() {
    if (armed) return;
    armed = true;
    for (const t of GESTURES) window.addEventListener(t, onGesture, { capture: true, passive: true });
  }
  function disarm() {
    if (!armed) return;
    armed = false;
    for (const t of GESTURES) window.removeEventListener(t, onGesture, { capture: true });
  }

  function onState() {
    if (ctx.state === 'running') disarm();
    else if (enabled && !hidden && ctx.state !== 'closed') arm();
    setLive();
  }

  // Bring the context to where enabled/hidden say it should be.
  function sync() {
    if (!ctx) return;
    const want = enabled && !hidden;
    if (want && ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(noop);
      arm();
    } else if (!want && ctx.state === 'running') {
      const p = ctx.suspend();
      if (p && p.catch) p.catch(noop);
    }
    setLive();
  }

  // Bank rendering after unlock, one take per task, so the Start tap never stalls a frame.
  function prepareSoon() {
    setTimeout(() => {
      let more = false;
      try { more = synth.prepareStep(); } catch (e) { console.warn('audio: prepare failed', e); }
      if (more) prepareSoon();
    }, 0);
  }

  class BedHandle {
    constructor(kind) {
      this.kind = kind;
      this.level = 0;
      this.tone = 0;
      this.node = null;
      this.stopped = false;
    }
    set(level, tone) {
      if (this.stopped) return;
      this.level = clamp01(level);
      this.tone = clamp01(tone);
      if (live && this.node) this.node.set(this.level, this.tone, ctx.currentTime);
    }
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      handles.delete(this);
      if (this.node) { this.node.stop(ctx.currentTime); this.node = null; }
    }
    attach() {
      if (!this.node && synth) this.node = synth.bed(this.kind);
    }
    refresh() {
      if (this.node) this.node.refresh();
    }
  }

  return {
    get enabled() { return enabled; },
    set enabled(v) {
      v = !!v;
      if (v === enabled) return;
      enabled = v;
      if (ctx) synth.setMute(!v, ctx.currentTime);
      if (!v) disarm();
      sync();
    },

    unlock() {
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          // Mix with the user's music and follow the ring/silent switch, like a game should (iOS 17+).
          try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch { /* old WebKit */ }
          ctx = new AC({ latencyHint: 'interactive' });
          synth = createSynth(ctx);
          synth.setMute(!enabled, 0);
          ctx.onstatechange = onState;
          for (const h of handles) h.attach();
          prepareSoon();
        }
        kick();
        sync();
      } catch (e) {
        console.warn('audio: unlock failed', e);
      }
    },

    impact(kind, intensity, pitch = 1) {
      count.calls++;
      if (!live) return;
      const k = KIND_INDEX.get(kind);
      if (k === undefined || !(intensity > MIN_INTENSITY)) return;
      if (!batchOpen) openBatch();
      const c = cap[k];
      if (c === 0) { count.limited++; return; }
      const n = candN[k];
      if (intensity > 1) intensity = 1;
      pitch = pitch > 0.25 ? (pitch < 4 ? pitch : 4) : pitch > 0 ? 0.25 : 1;
      const base = k * PF;
      if (n < c) {
        candI[base + n] = intensity;
        candP[base + n] = pitch;
        candN[k] = n + 1;
        return;
      }
      count.limited++;
      let m = base;
      for (let j = base + 1; j < base + n; j++) if (candI[j] < candI[m]) m = j;
      if (intensity > candI[m]) { candI[m] = intensity; candP[m] = pitch; }
    },

    bed(kind) {
      if (!BED_KINDS.has(kind)) return NOOP_BED;
      const h = new BedHandle(kind);
      handles.add(h);
      try { h.attach(); } catch (e) { console.warn('audio: bed failed', e); }
      return h;
    },

    suspend() {
      hidden = true;
      sync();
    },
    resume() {
      hidden = false;
      sync();
    },

    // Not part of the mode contract: for tests and the debug overlay.
    stats() {
      return {
        state: ctx ? ctx.state : 'locked',
        live,
        enabled,
        sampleRate: ctx ? ctx.sampleRate : 0,
        ready: synth ? IMPACTS.reduce((a, _, k) => a + (synth.ready(k) ? 1 : 0), 0) : 0,
        voices: synth ? synth.voices(ctx.currentTime) : 0,
        peakVoices: synth ? synth.peakVoices : 0,
        beds: handles.size,
        ...count,
      };
    },
  };
}
