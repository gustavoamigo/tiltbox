// The starting sand: the bottom of the box filled in wavy bands of colour, like a sand-art
// bottle, with a gently rolling surface well under the angle of repose so it is at rest from the
// first frame. Each grain gets its own shade of its band's colour, and a few are dark or
// glassy specks, the way real sand is a mix of minerals.

// Band colours, bottom to top (sRGB 0..255): warm natural tones with one cool layer for contrast.
const BANDS = [
  [142, 78, 47], // rust
  [214, 172, 101], // golden sand
  [238, 226, 199], // ivory
  [183, 102, 64], // terracotta
  [222, 190, 128], // pale sand
  [118, 128, 140], // slate
  [205, 150, 88], // ochre
  [236, 219, 182], // cream
];

// mulberry32: a small seeded generator, so a refill looks the same every time
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fills `grid` (emptied first) to `level` (0..1 of its height) and writes each grain's colour
// (r, g, b, 255) into `rgba`. Returns the number of grains.
export function fillLayers(grid, rgba, level = 0.36, seed = 7) {
  const rand = rng(seed);
  grid.clear();
  const { gw, gh } = grid;
  const k = 2 * Math.PI / gw;
  // the surface: two slow waves, at most a few degrees of slope
  const ph1 = rand() * 6.28, ph2 = rand() * 6.28;
  const amp = gh * 0.018;
  const surf = (x) => gh * (1 - level) + amp * Math.sin(k * 1.1 * x + ph1) + amp * 0.5 * Math.sin(k * 2.3 * x + ph2);
  // band boundaries: each its own wave, as poured from a funnel moved around
  const nb = BANDS.length;
  const waves = [];
  for (let b = 0; b < nb; b++) waves.push({ a: 0.25 + 0.5 * rand(), f: 0.7 + 1.8 * rand(), p: rand() * 6.28, f2: 3 + 4 * rand(), p2: rand() * 6.28 });
  for (let x = 0; x < gw; x++) {
    const top = Math.max(0, Math.round(surf(x)));
    const depth = gh - top;
    // boundary heights (fraction of this column's depth from the bottom) for this column
    const bounds = [];
    for (let b = 1; b < nb; b++) {
      const w = waves[b];
      const t = b / nb + (w.a * Math.sin(k * w.f * x + w.p) + 0.25 * Math.sin(k * w.f2 * x + w.p2)) * 0.45 / nb;
      bounds.push(t);
    }
    for (let y = gh - 1; y >= top; y--) {
      const i = grid.add(x, y);
      if (i < 0) continue;
      const h = (gh - 1 - y + 0.5) / depth; // 0 at the floor, 1 at the surface
      let band = 0;
      while (band < nb - 1 && h > bounds[band]) band++;
      shade(rgba, i, BANDS[band], rand);
    }
  }
  return grid.n;
}

function shade(rgba, i, c, rand) {
  let r = c[0], g = c[1], b = c[2];
  const u = rand();
  if (u < 0.03) {
    // dark mineral speck
    const k = 0.4 + 0.2 * rand();
    r = r * k + 18; g = g * k + 14; b = b * k + 12;
  } else if (u < 0.045) {
    // glassy quartz: pale
    const k = 0.55 + 0.25 * rand();
    r += (250 - r) * k; g += (246 - g) * k; b += (236 - b) * k;
  } else {
    // ordinary grain: its own lightness and a slight warm or cool cast
    const l = 0.88 + 0.2 * rand();
    const t = (rand() - 0.5) * 16;
    r = r * l + t; g = g * l; b = b * l - t * 0.6;
  }
  const o = 4 * i;
  rgba[o] = clamp8(r); rgba[o + 1] = clamp8(g); rgba[o + 2] = clamp8(b);
  rgba[o + 3] = (rand() * 255) | 0; // per-grain random for the shader (sparkle phase)
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
