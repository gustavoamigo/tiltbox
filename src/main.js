// Tiltbox shell: start screen, mode bar, the frame loop, touch input and test hooks.
// The physics and drawing live in the modes (src/modes/); see docs/design.md for the contract.

import { MODES } from './modes/index.js';
import { View, screenAngle } from './view.js';
import { Motion } from './motion.js';
import { createAudio } from './audio.js';
import { loseContext } from './gl.js';

const params = new URLSearchParams(location.search);
const TEST = params.has('test'); // no start screen, no auto quality; driven through window.__T
const QUALITIES = ['low', 'medium', 'high'];
const DPR_CAP = { low: 1, medium: 1.5, high: 2 };

const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
document.body.classList.toggle('touch', isTouch);
if (!window.isSecureContext) document.body.classList.add('insecure');

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const bar = $('bar');
const modesEl = $('modes');
const toastEl = $('toast');
const debugEl = $('debug');
const startEl = $('start');
const btnSound = $('btn-sound');

const store = {
  get(k, d) {
    try { const v = localStorage.getItem(`tiltbox.${k}`); return v == null ? d : v; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(`tiltbox.${k}`, v); } catch { /* private mode */ }
  },
};

const motion = new Motion(params);
const audio = createAudio();
audio.enabled = !params.has('nosound') && store.get('sound', '1') === '1';
btnSound.classList.toggle('off', !audio.enabled);

let quality = QUALITIES.includes(params.get('q')) ? params.get('q') : 'high';
const qualityFixed = QUALITIES.includes(params.get('q')) || TEST;

const findMode = (id) => MODES.find((m) => m.id === id);
let modeId = findMode(params.get('mode')) ? params.get('mode') : store.get('mode', MODES[0].id);
if (!findMode(modeId)) modeId = MODES[0].id;

let mode = null;
let canvas = null;
let view = null;
let token = 0;
let ready = false;
let started = TEST;
let paused = false;
let forcedAngle = null; // tests: pretend the page is rotated
let modeStart = 0;
let failed = null;

// ---------------------------------------------------------------- view

function measureView() {
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[quality]);
  // Only phones and tablets turn the page; a desktop monitor's angle means nothing to the box.
  const angle = forcedAngle != null ? forcedAngle : isTouch ? screenAngle() : 0;
  return new View(w, h, angle, dpr);
}

// iOS delivers a rotation's new size and new angle in separate messages, so for a frame they can
// disagree and the box would look turned sideways. Apply a change only once it has held for a
// moment (at once under ?test, where tests turn the page on purpose).
let pendingView = null;
let pendingSince = 0;
function checkView() {
  const v = measureView();
  if (v.same(view)) { pendingView = null; return; }
  if (!TEST) {
    const now = performance.now();
    if (!pendingView || !v.same(pendingView)) { pendingView = v; pendingSince = now; return; }
    if (now - pendingSince < 120) return;
  }
  pendingView = null;
  view = v;
  canvas.width = v.pxW;
  canvas.height = v.pxH;
  if (mode) guard(() => mode.resize(v));
}

// ---------------------------------------------------------------- modes

function fail(e) {
  console.error(e);
  failed = String(e && e.stack ? e.stack : e);
  ready = false;
  toast(`Something broke: ${e && e.message ? e.message : e}`, 6000);
}

function guard(fn) {
  try { return fn(); } catch (e) { fail(e); return undefined; }
}

async function switchMode(id) {
  const entry = findMode(id) || MODES[0];
  const my = ++token;
  ready = false;
  failed = null;
  if (mode) {
    const old = mode;
    mode = null;
    try { old.dispose(); } catch (e) { console.error(e); }
  }
  if (canvas) {
    const old = canvas;
    canvas = null; // so its contextlost below is recognised as ours
    const gl = old.getContext('webgl2') || old.getContext('webgl');
    if (gl) loseContext(gl);
    old.remove();
  }
  canvas = document.createElement('canvas');
  const c = canvas;
  // iOS Safari can drop a WebGL context after backgrounding or a lock. Start the mode again on a
  // fresh canvas rather than draw into a dead context.
  c.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (c !== canvas) return;
    ready = false;
    const restart = () => { if (c === canvas) switchMode(modeId); };
    if (document.visibilityState === 'visible') setTimeout(restart, 0);
    else document.addEventListener('visibilitychange', restart, { once: true });
  });
  stage.appendChild(canvas);
  view = measureView();
  canvas.width = view.pxW;
  canvas.height = view.pxH;
  modeId = entry.id;
  if (!TEST) store.set('mode', entry.id);
  document.documentElement.style.setProperty('--accent', entry.accent);
  for (const b of modesEl.children) b.classList.toggle('on', b.dataset.id === entry.id);
  try {
    const mod = await entry.load();
    if (my !== token) return;
    const m = await mod.default({ canvas, view, audio, haptic, quality, params, modeName: entry.name, test: TEST });
    if (my !== token) { m.dispose(); return; }
    mode = m;
    mode.resize(view);
    modeStart = performance.now();
    perfWin.frames = 0; perfWin.cpu = 0; perfWin.t0 = 0; perfWin.prev = 0; perfWin.done = qualityFixed;
    ready = true;
    if (!paused) mode.render(view);
  } catch (e) {
    if (my === token) fail(e);
  }
}

// A short buzz where the platform has one (Android). Off with the sound.
let lastBuzz = 0;
function haptic(strength = 0.5) {
  if (!started || TEST || !audio.enabled || !navigator.vibrate) return;
  const now = performance.now();
  if (now - lastBuzz < 70) return;
  lastBuzz = now;
  try { navigator.vibrate(Math.round(6 + 24 * Math.min(1, Math.max(0, strength)))); } catch { /* blocked */ }
}

// ---------------------------------------------------------------- pointers

const pointers = new Map();
let testPointers = null;
const env = { g: motion.g, shake: 0, pointers: [], time: 0, dt: 0, source: 'desktop' };
const screenG = { x: 0, y: 0, z: 0 };

function stagePos(e) {
  const r = stage.getBoundingClientRect();
  return view.toSim(e.clientX - r.left, e.clientY - r.top);
}

stage.addEventListener('pointerdown', (e) => {
  if (!view) return;
  e.preventDefault();
  try { stage.setPointerCapture(e.pointerId); } catch { /* old Safari */ }
  const p = stagePos(e);
  pointers.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, vx: 0, vy: 0, t: e.timeStamp });
});
stage.addEventListener('pointermove', (e) => {
  const q = pointers.get(e.pointerId);
  if (!q || !view) return;
  const p = stagePos(e);
  const dt = Math.max((e.timeStamp - q.t) / 1000, 1 / 500);
  const k = Math.min(1, dt / 0.03);
  q.vx += ((p.x - q.x) / dt - q.vx) * k;
  q.vy += ((p.y - q.y) / dt - q.vy) * k;
  q.x = p.x; q.y = p.y; q.t = e.timeStamp;
});
const lift = (e) => pointers.delete(e.pointerId);
stage.addEventListener('pointerup', lift);
stage.addEventListener('pointercancel', lift);
stage.addEventListener('lostpointercapture', lift);
stage.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => { if (e.target.closest('#stage')) e.preventDefault(); }, { passive: false });

function pointerList(dt) {
  const out = env.pointers;
  out.length = 0;
  if (testPointers) { for (const p of testPointers) out.push(p); return out; }
  const now = performance.now();
  for (const q of pointers.values()) {
    if (now - q.t > 40) { const k = Math.exp(-dt / 0.05); q.vx *= k; q.vy *= k; } // finger held still
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------- frame loop

const perf = { step: 0, render: 0, fps: 0, n: 0, t0: 0 };
const perfWin = { frames: 0, cpu: 0, t0: 0, prev: 0, done: false };

function tick(dt) {
  motion.update(dt);
  env.g = motion.g;
  if (motion.source === 'desktop' && view.angle) {
    // No sensor (desktop keys, http, refused, none): 'down' is the screen's down, whatever the angle.
    const r = view.vecToSim(motion.g.x, motion.g.y);
    screenG.x = r.x; screenG.y = r.y; screenG.z = motion.g.z;
    env.g = screenG;
  }
  env.shake = motion.shake;
  env.dt = dt;
  env.time += dt;
  env.source = motion.source;
  pointerList(dt);
  const t0 = performance.now();
  mode.step(dt, env);
  return performance.now() - t0;
}

// rAF's timestamp is the frame's start, which can be earlier than a performance.now() read in an
// event handler; so after a pause the clock is resynced from the next frame, never from an event.
let last = 0;
let resync = true;
function frame(now) {
  requestAnimationFrame(frame);
  if (resync) { last = now; resync = false; return; }
  const raw = (now - last) / 1000;
  last = now;
  if (!mode || !ready || paused || !(raw > 0)) return;
  const dt = Math.min(raw, 1 / 30); // a hiccup is slow motion, never a blow-up
  try {
    checkView();
    const stepMs = tick(dt);
    const t1 = performance.now();
    mode.render(view);
    const renderMs = performance.now() - t1;
    const a = 0.05;
    perf.step += (stepMs - perf.step) * a;
    perf.render += (renderMs - perf.render) * a;
    perf.n++;
    if (now - perf.t0 >= 500) { perf.fps = (perf.n * 1000) / (now - perf.t0); perf.n = 0; perf.t0 = now; }
    autoQuality(now, stepMs + renderMs);
  } catch (e) {
    fail(e);
  }
}
requestAnimationFrame(frame);

// One look per mode start: if this device can't keep up, drop a level and start again.
function autoQuality(now, cpuMs) {
  if (perfWin.done || !started || now - modeStart < 2000) return;
  const gap = perfWin.prev ? now - perfWin.prev : 0;
  perfWin.prev = now;
  if (gap > 100) { perfWin.frames = 0; perfWin.cpu = 0; perfWin.t0 = 0; return; } // a stall says nothing about speed
  if (!perfWin.t0) perfWin.t0 = now;
  perfWin.frames++;
  perfWin.cpu += cpuMs;
  if (perfWin.frames < 120) return;
  perfWin.done = true;
  const cpu = perfWin.cpu / perfWin.frames;
  const frameMs = (now - perfWin.t0) / (perfWin.frames - 1);
  // iOS caps rAF at 30 fps in Low Power Mode and when hot; only slower than that counts.
  const slow = cpu > 11 || (frameMs > 40 && cpu > 6);
  const i = QUALITIES.indexOf(quality);
  if (slow && i > 0) {
    quality = QUALITIES[i - 1];
    toast('Less detail, to keep it smooth');
    switchMode(modeId);
  }
}

// ---------------------------------------------------------------- UI

let hideT = 0;
function pokeUI() {
  bar.classList.add('shown');
  clearTimeout(hideT);
  if (started) hideT = setTimeout(() => bar.classList.remove('shown'), 4500);
}

let toastT = 0;
function toast(msg, ms = 3500) {
  toastEl.textContent = msg;
  toastEl.classList.add('shown');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('shown'), ms);
}

for (const m of MODES) {
  const b = document.createElement('button');
  b.className = 'mode';
  b.dataset.id = m.id;
  b.setAttribute('aria-label', m.name);
  b.innerHTML = `<svg viewBox="0 0 24 24" style="fill:${m.accent}">${m.icon}</svg><span>${m.name}</span>`;
  b.addEventListener('click', () => { pokeUI(); if (m.id !== modeId || !ready) switchMode(m.id); });
  modesEl.appendChild(b);
}
$('btn-menu').addEventListener('click', () => {
  if (bar.classList.contains('shown')) { bar.classList.remove('shown'); clearTimeout(hideT); } else pokeUI();
});
$('btn-reset').addEventListener('click', () => {
  pokeUI();
  if (mode && ready && mode.reset) guard(() => mode.reset()); else switchMode(modeId);
});
btnSound.addEventListener('click', () => {
  pokeUI();
  audio.unlock();
  audio.enabled = !audio.enabled;
  store.set('sound', audio.enabled ? '1' : '0');
  btnSound.classList.toggle('off', !audio.enabled);
});

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed: fine */ }
}

function goFullscreen() {
  const el = document.documentElement;
  const f = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!f) return;
  try {
    const p = f.call(el, { navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => {});
  } catch { /* iPhone Safari: no fullscreen for pages */ }
}

$('btn-start').addEventListener('click', () => {
  const perm = motion.requestPermission(); // first: iOS needs the gesture for this
  audio.unlock();
  if (isTouch) goFullscreen();
  started = true;
  startEl.classList.add('gone');
  pokeUI();
  keepAwake();
  perm.then((r) => {
    if (isTouch && !window.isSecureContext) { toast('Tilt needs the https:// address. Drag to stir.', 6000); return; }
    // iOS remembers a refusal per site until the browser is closed; a reload does not ask again.
    if (r === 'denied') { toast('Motion access is off for this page. To be asked again, close the browser completely and reopen the page. Drag to stir.', 8000); return; }
    setTimeout(() => {
      if (motion.sensorActive()) return;
      if (isTouch) toast(window.isSecureContext ? 'No motion sensor here. Drag to stir.' : 'Tilt needs the https:// address. Drag to stir.', 6000);
      else toast('← → tilt · space shake · drag to stir', 4500);
    }, 1500);
  });
});

document.addEventListener('visibilitychange', () => {
  perfWin.prev = 0;
  if (document.visibilityState === 'visible') {
    resync = true;
    if (started) keepAwake();
    if (audio.resume) audio.resume();
  } else if (audio.suspend) audio.suspend();
});

// ---------------------------------------------------------------- debug overlay

let debugOn = params.has('debug');
window.addEventListener('keydown', (e) => { if (e.key === '`') debugOn = !debugOn; });
setInterval(() => {
  debugEl.classList.toggle('shown', debugOn);
  if (!debugOn) return;
  const s = window.__T.stats();
  const m = motion.status();
  const g = motion.g;
  const extra = s ? Object.entries(s).filter(([k]) => !['mode', 'quality', 'fps', 'stepMs', 'renderMs', 'simW', 'simH', 'angle', 'g', 'source'].includes(k))
    .map(([k, v]) => `${k} ${typeof v === 'number' ? +v.toFixed(3) : v}`).join('\n') : '';
  debugEl.textContent = [
    `${modeId} · ${quality} · ${perf.fps.toFixed(0)} fps`,
    `step ${perf.step.toFixed(2)} ms · draw ${perf.render.toFixed(2)} ms`,
    `g ${g.x.toFixed(2)} ${g.y.toFixed(2)} ${g.z.toFixed(2)} · shake ${motion.shake.toFixed(1)}`,
    `src ${m.source} · perm ${m.permission} · sign ${m.sign}${m.signLocked ? '' : '?'} (${m.votes})`,
    `raw ${m.raw} · β γ ${m.orient}`,
    view ? `sim ${view.simW}×${view.simH} · angle ${view.angle} · dpr ${view.dpr}` : '',
    extra,
    failed ? `ERROR ${failed.split('\n')[0]}` : '',
  ].filter(Boolean).join('\n');
}, 250);

// ---------------------------------------------------------------- test hooks

window.__T = {
  get ready() { return ready; },
  get mode() { return modeId; },
  get modeObj() { return mode; },
  get view() { return view; },
  get error() { return failed; },
  modes: MODES.map((m) => m.id),
  motion,
  audio,
  setMode: (id) => switchMode(id),
  setQuality(q) { if (!QUALITIES.includes(q)) throw new Error(`quality ${q}`); quality = q; return switchMode(modeId); },
  // Pretend the page is turned. Turn the viewport too (width <-> height), as a phone does.
  rotate(angle) {
    forcedAngle = angle;
    if (angle != null && (angle % 180 !== 0) !== (stage.clientWidth > stage.clientHeight)) {
      console.warn('__T.rotate: turn the viewport with the angle, or the box changes shape');
    }
    if (mode) checkView();
  },
  pause(on = true) { paused = on; resync = true; },
  // Deterministic stepping: n steps of dt, then one render. Use with pause().
  step(n = 1, dt = 1 / 60) {
    if (!(dt > 0 && dt <= 1 / 30)) throw new Error(`dt must be in (0, 1/30], got ${dt}`);
    if (!mode || !ready) return null;
    try {
      checkView();
      let ms = 0;
      for (let i = 0; i < n; i++) ms += tick(dt);
      perf.step = ms / n;
      const t1 = performance.now();
      mode.render(view);
      perf.render = performance.now() - t1;
    } catch (e) { fail(e); }
    return this.stats();
  },
  gravity(x, y, z = 0) { motion.setOverride(x == null ? null : { x, y, z }); },
  shake(amp = 30, dur = 0.6, dirX = 1, dirY = 0, freq = 7) { motion.pulse(amp, dur, dirX, dirY, freq); },
  pointer(list) { testPointers = list ? list.map((p, i) => ({ id: 1000 + i, x: p.x, y: p.y, vx: p.vx || 0, vy: p.vy || 0 })) : null; },
  stats() {
    if (!mode) return null;
    const s = guard(() => (mode.stats ? mode.stats() : {})) || {};
    return {
      mode: modeId, quality, fps: perf.fps, stepMs: perf.step, renderMs: perf.render,
      simW: view.simW, simH: view.simH, angle: view.angle,
      g: { x: motion.g.x, y: motion.g.y, z: motion.g.z }, source: motion.source, ...s,
    };
  },
};

if (TEST) {
  startEl.style.display = 'none';
  if (params.get('ui') !== '1') bar.classList.remove('shown');
}
switchMode(modeId);
