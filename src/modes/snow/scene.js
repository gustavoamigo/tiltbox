// The little night scene at the bottom of the globe (the device's bottom edge in the sim frame):
// two snowy hills, a cottage with lit windows, pine trees, and a hazy far ridge painted on the
// back glass. One description draws both the picture and the solid mask that the snow rests on
// and the liquid flows around, so the two always agree. Everything is in sim px, scaled by S
// (1 on a 393 px wide phone).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const gauss = (u, c, w) => Math.exp(-(((u - c) / w) ** 2));

export function sceneLayout(W, H) {
  const S = clamp(Math.min(W, 0.62 * H) / 393, 0.4, 3);
  // Heights above the bottom edge, px.
  const backH = (x) => { const u = x / W; return S * (112 + 50 * gauss(u, 0.33, 0.26) + 30 * gauss(u, 1.0, 0.17) + 3 * Math.sin(u * 9 + 1.3)); };
  const frontH = (x) => { const u = x / W; return S * (50 + 34 * gauss(u, 0.72, 0.2) + 16 * gauss(u, 0.0, 0.12) + 4 * Math.sin(u * 13 + 0.4)); };
  const farH = (x) => { const u = x / W; return S * (205 + 26 * Math.sin(u * 5.1 + 0.8) + 14 * Math.sin(u * 11.3 + 2.1)); };

  const hx = 0.33 * W;
  const base = H - backH(hx) + 4 * S;
  const house = { x: hx, base, w: 88 * S, h: 54 * S, roofH: 40 * S, over: 10 * S };
  const wy = base - house.h * 0.56;
  const lights = [
    { x: hx - 25 * S, y: wy, w: 15 * S, h: 16 * S },
    { x: hx + 26 * S, y: wy, w: 15 * S, h: 16 * S },
    { x: hx, y: base - house.h - house.roofH * 0.42, r: 5.2 * S },
  ];
  const tree = (u, h, ground) => {
    const x = u * W;
    return { x, base: H - ground(x) + 6 * S, h: h * S, w: h * S * 0.56 };
  };
  const trees = [
    tree(0.085, 150, backH),
    tree(0.555, 64, backH),
    tree(0.645, 104, backH),
    tree(0.815, 182, backH),
    tree(0.95, 118, backH),
  ];
  const tallest = Math.max(...trees.map((t) => H - t.base + t.h), H - (base - house.h - house.roofH - 20 * S));
  const top = Math.max(0, Math.floor(H - Math.max(tallest + 8 * S, 245 * S)));
  return {
    W, H, S, top, backH, frontH, farH, house, lights, trees,
    moon: { x: 0.74 * W, y: Math.max(36 * S, Math.min(0.11 * H, top - 60 * S)), r: 23 * S },
  };
}

// Draw the scene into a 2D context whose transform maps sim px to its pixels. mask: plain white
// solids only (no backdrop, no strokes that would stick out of the silhouette).
export function drawScene(c, L, mask) {
  const { W, H, S } = L;
  const P = mask ? MASK : PAL;

  if (!mask) {
    // Far ridge: painted on the back glass, so no snow settles on it.
    const g = c.createLinearGradient(0, H - L.farH(0) - 30 * S, 0, H);
    g.addColorStop(0, 'rgba(46, 66, 112, 0.55)');
    g.addColorStop(1, 'rgba(30, 44, 80, 0.55)');
    c.fillStyle = g;
    hill(c, L.farH, W, H);
    c.fill();
    c.fillStyle = 'rgba(30, 46, 84, 0.7)';
    for (let k = 0; k < 26; k++) {
      const u = (k + 0.5 * ((k * 7) % 3) / 3) / 26;
      const x = u * W;
      const h = S * (14 + ((k * 37) % 11));
      const y = H - L.farH(x) + 3 * S;
      c.beginPath();
      c.moveTo(x, y - h);
      c.lineTo(x + h * 0.32, y);
      c.lineTo(x - h * 0.32, y);
      c.closePath();
      c.fill();
    }
  }

  // Back hill: moonlit snow, bluer and darker than the near one
  c.fillStyle = mask ? P : vgrad(c, H - L.backH(W * 0.33) - 20 * S, H - L.frontH(W * 0.5), '#7d92c4', '#3a4a7a');
  hill(c, L.backH, W, H);
  c.fill();
  if (!mask) {
    rim(c, L.backH, W, H, 'rgba(214, 228, 255, 0.55)', 1.8 * S);
    glints(c, L.backH, W, H, S, 0.32, 7);
  }

  for (const t of L.trees) if (t.x > L.house.x) pine(c, t, mask, S);
  house(c, L, mask);
  for (const t of L.trees) if (t.x <= L.house.x) pine(c, t, mask, S);

  // Front hill: nearer snow, brighter along its crest, falling into blue shadow
  c.fillStyle = mask ? P : vgrad(c, H - L.frontH(W * 0.72) - 10 * S, H, '#9aaedb', '#26335c');
  hill(c, L.frontH, W, H);
  c.fill();
  if (!mask) {
    rim(c, L.frontH, W, H, 'rgba(230, 238, 255, 0.7)', 1.6 * S);
    glints(c, L.frontH, W, H, S, 0.45, 11);
  }
}

const MASK = '#ffffff';
const PAL = {
  trunk: '#2a1e1c',
  wall: '#4a3438', wallLit: '#5a4045', plank: 'rgba(20, 10, 14, 0.35)',
  roof: '#262a44', roofEdge: '#3b4268', roofShade: 'rgba(0, 0, 0, 0.32)',
  chimney: '#3e3036', chimneyCap: '#55454c',
  door: '#22161a', frame: '#2a1c1c',
};

function vgrad(c, y0, y1, a, b) {
  const g = c.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

function hill(c, hf, W, H) {
  c.beginPath();
  c.moveTo(0, H + 2);
  for (let x = 0; x <= W + 4; x += 4) c.lineTo(Math.min(x, W), H - hf(Math.min(x, W)));
  c.lineTo(W, H + 2);
  c.closePath();
}

// Tiny frozen glints scattered over a hill, densest near its crest. Deterministic.
function glints(c, hf, W, H, S, alpha, seed) {
  let a = seed * 9301 + 49297;
  const rnd = () => { a = (a * 9301 + 49297) % 233280; return a / 233280; };
  const n = Math.round((W / S) * 0.9);
  for (let k = 0; k < n; k++) {
    const x = rnd() * W;
    const top = H - hf(x);
    const y = top + 2 * S + Math.pow(rnd(), 2.2) * (H - top) * 0.8;
    const r = (0.35 + 0.6 * rnd()) * S;
    c.fillStyle = `rgba(235, 242, 255, ${(alpha * (0.3 + 0.7 * rnd()) * (1 - (y - top) / (H - top + 1))).toFixed(3)})`;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
}

function rim(c, hf, W, H, color, lw) {
  c.beginPath();
  for (let x = 0; x <= W + 4; x += 4) {
    const xx = Math.min(x, W);
    if (x === 0) c.moveTo(xx, H - hf(xx) + lw * 0.5); else c.lineTo(xx, H - hf(xx) + lw * 0.5);
  }
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.stroke();
}

function pine(c, t, mask, S) {
  const { x, base, h, w } = t;
  c.fillStyle = mask ? MASK : PAL.trunk;
  c.fillRect(x - 0.05 * w, base - 0.24 * h, 0.1 * w, 0.24 * h + 10 * S);
  const tiers = 4;
  for (let k = 0; k < tiers; k++) {
    const top = base - h + k * h * 0.19;
    const bot = top + h * (0.3 + 0.07 * k);
    const hw = w * 0.5 * (0.4 + (0.6 * (k + 1)) / tiers);
    if (mask) c.fillStyle = MASK;
    else {
      const g = c.createLinearGradient(x - hw, 0, x + hw, 0);
      g.addColorStop(0, '#0b1f27');
      g.addColorStop(0.55, '#143640');
      g.addColorStop(1, '#22505a');
      c.fillStyle = g;
    }
    c.beginPath();
    c.moveTo(x, top);
    c.quadraticCurveTo(x + hw * 0.42, top + (bot - top) * 0.58, x + hw, bot);
    c.quadraticCurveTo(x + hw * 0.55, bot - h * 0.04, x, bot - h * 0.015);
    c.quadraticCurveTo(x - hw * 0.55, bot - h * 0.04, x - hw, bot);
    c.quadraticCurveTo(x - hw * 0.42, top + (bot - top) * 0.58, x, top);
    c.closePath();
    c.fill();
    if (!mask) {
      c.strokeStyle = 'rgba(190, 215, 255, 0.28)';
      c.lineWidth = 1.1 * S;
      c.beginPath();
      c.moveTo(x + hw * 0.08, top + (bot - top) * 0.1);
      c.quadraticCurveTo(x + hw * 0.42, top + (bot - top) * 0.58, x + hw, bot);
      c.stroke();
    }
  }
}

function house(c, L, mask) {
  const { S } = L;
  const { x, base, w, h, roofH, over } = L.house;
  const left = x - w / 2, right = x + w / 2, eave = base - h;
  const fill = (col) => { c.fillStyle = mask ? MASK : col; };

  // Chimney, behind the roof
  fill(PAL.chimney);
  c.fillRect(x + w * 0.2, eave - roofH * 0.95, 12 * S, roofH * 0.8);
  fill(PAL.chimneyCap);
  c.fillRect(x + w * 0.2 - 2 * S, eave - roofH * 0.95 - 4 * S, 16 * S, 4.5 * S);

  // Walls, down into the hill
  fill(PAL.wall);
  c.fillRect(left, eave, w, h + 26 * S);
  if (!mask) {
    c.fillStyle = PAL.plank;
    for (let k = 1; k < 9; k++) c.fillRect(left + (k * w) / 9, eave, 0.8 * S, h + 26 * S);
    // shadow under the eaves
    const g = c.createLinearGradient(0, eave, 0, eave + 10 * S);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(left, eave, w, 10 * S);
  }

  // Roof slab with overhang
  fill(PAL.roof);
  c.beginPath();
  c.moveTo(left - over, eave + 3 * S);
  c.lineTo(x, eave - roofH);
  c.lineTo(right + over, eave + 3 * S);
  c.lineTo(right + over - 3 * S, eave + 6 * S);
  c.lineTo(x, eave - roofH + 8 * S);
  c.lineTo(left - over + 3 * S, eave + 6 * S);
  c.closePath();
  c.fill();
  if (!mask) {
    // gable wall under the roof
    c.fillStyle = PAL.wallLit;
    c.beginPath();
    c.moveTo(left + 2 * S, eave + 1);
    c.lineTo(x, eave - roofH + 9 * S);
    c.lineTo(right - 2 * S, eave + 1);
    c.closePath();
    c.fill();
    c.strokeStyle = PAL.roofEdge;
    c.lineWidth = 1.4 * S;
    c.beginPath();
    c.moveTo(left - over, eave + 3 * S);
    c.lineTo(x, eave - roofH);
    c.lineTo(right + over, eave + 3 * S);
    c.stroke();
  }

  if (mask) return;
  // Windows: warm light, mullions, sills
  for (const L0 of L.lights) {
    if (L0.r) {
      const g = c.createRadialGradient(L0.x, L0.y, 0, L0.x, L0.y, L0.r);
      g.addColorStop(0, '#fff1c2');
      g.addColorStop(1, '#ffb04a');
      c.fillStyle = PAL.frame;
      c.beginPath(); c.arc(L0.x, L0.y, L0.r + 1.6 * S, 0, Math.PI * 2); c.fill();
      c.fillStyle = g;
      c.beginPath(); c.arc(L0.x, L0.y, L0.r, 0, Math.PI * 2); c.fill();
      c.fillStyle = PAL.frame;
      c.fillRect(L0.x - 0.6 * S, L0.y - L0.r, 1.2 * S, 2 * L0.r);
      continue;
    }
    const x0 = L0.x - L0.w / 2, y0 = L0.y - L0.h / 2;
    c.fillStyle = PAL.frame;
    c.fillRect(x0 - 2 * S, y0 - 2 * S, L0.w + 4 * S, L0.h + 4 * S);
    const g = c.createRadialGradient(L0.x, L0.y + L0.h * 0.15, 1, L0.x, L0.y, L0.w * 0.75);
    g.addColorStop(0, '#fff3c8');
    g.addColorStop(0.6, '#ffc861');
    g.addColorStop(1, '#f08a32');
    c.fillStyle = g;
    c.fillRect(x0, y0, L0.w, L0.h);
    c.fillStyle = PAL.frame;
    c.fillRect(L0.x - 0.7 * S, y0, 1.4 * S, L0.h);
    c.fillRect(x0, L0.y - 0.7 * S, L0.w, 1.4 * S);
    c.fillStyle = '#6a5056';
    c.fillRect(x0 - 3 * S, y0 + L0.h + 1.5 * S, L0.w + 6 * S, 2 * S);
  }
  // Door
  c.fillStyle = PAL.frame;
  c.fillRect(x - 6.5 * S, base - 30 * S, 13 * S, 30 * S);
  c.fillStyle = PAL.door;
  c.fillRect(x - 5 * S, base - 28.5 * S, 10 * S, 28.5 * S);
  c.fillStyle = '#d9a650';
  c.beginPath(); c.arc(x + 2.8 * S, base - 14 * S, 0.9 * S, 0, Math.PI * 2); c.fill();
}

// Rasterise the solid mask at 1 sim px per pixel and return lookups for the flakes (point) and
// the liquid grid (area coverage).
export function buildMask(L) {
  const { W, H, top } = L;
  const w = Math.max(1, Math.ceil(W)), h = Math.max(1, Math.ceil(H - top));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.setTransform(1, 0, 0, 1, 0, -top);
  drawScene(c, L, true);
  const data = c.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) a[k] = data[k * 4 + 3] > 127 ? 1 : 0;
  // Summed-area table for O(1) coverage of any rect.
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) {
    let row = 0;
    for (let i = 0; i < w; i++) {
      row += a[j * w + i];
      sat[(j + 1) * (w + 1) + i + 1] = sat[j * (w + 1) + i + 1] + row;
    }
  }
  const at = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y - top);
    if (j < 0) return false;
    if (i < 0 || i >= w || j >= h) return true;
    return a[j * w + i] === 1;
  };
  const coverage = (x0, y0, x1, y1) => {
    const area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
    const i0 = clamp(Math.round(x0), 0, w), i1 = clamp(Math.round(x1), 0, w);
    const j0 = clamp(Math.round(y0 - top), 0, h), j1 = clamp(Math.round(y1 - top), 0, h);
    const s = sat[j1 * (w + 1) + i1] - sat[j0 * (w + 1) + i1] - sat[j1 * (w + 1) + i0] + sat[j0 * (w + 1) + i0];
    // Rows below the mask (y > H) never happen; rows above top are open.
    return s / area;
  };
  return { at, coverage };
}

// The colour picture of the scene, (W x (H - top)) * dpr pixels, transparent above the silhouette.
export function paintScene(L, dpr, canvas) {
  const cv = canvas || document.createElement('canvas');
  cv.width = Math.max(1, Math.round(L.W * dpr));
  cv.height = Math.max(1, Math.round((L.H - L.top) * dpr));
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.setTransform(cv.width / L.W, 0, 0, cv.height / (L.H - L.top), 0, (-L.top * cv.height) / (L.H - L.top));
  drawScene(c, L, false);
  return cv;
}
