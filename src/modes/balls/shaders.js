// GLSL for the ball modes. Shading frame = the sim frame in 3D: x right, y down, z into the
// screen (toward the back glass); the viewer looks along +z. uL is the unit vector toward the
// light (uL.z < 0: in front). Colours arrive as sRGB bytes; lighting is done in a gamma-2
// approximation of linear (square in, square root out), which is cheap and close enough.

// Instance attributes shared by the shadow and ball passes (one VAO serves both).
const ATTRS = `
layout(location = 0) in vec2 aCorner;   // quad corner, -1..1
layout(location = 1) in vec3 aPosR;     // centre (sim px), radius (sim px)
layout(location = 2) in vec4 aQuat;     // orientation, local -> sim
layout(location = 3) in vec4 aC0;
layout(location = 4) in vec4 aC1;
layout(location = 5) in vec4 aC2;
layout(location = 6) in vec4 aP;        // type/255, seed, a, b
`;

const VARY = (dir) => `
${dir} vec2 vLocal;
flat ${dir} vec2 vCenter;
flat ${dir} float vR;
flat ${dir} float vRpx;
flat ${dir} vec3 vR0;
flat ${dir} vec3 vR1;
flat ${dir} vec3 vR2;
flat ${dir} vec4 vC0;
flat ${dir} vec4 vC1;
flat ${dir} vec4 vC2;
flat ${dir} vec4 vP;
`;

const QUAT_TO_COLS = `
  vec4 q = aQuat;
  float x = q.x, y = q.y, z = q.z, w = q.w;
  vR0 = vec3(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w));
  vR1 = vec3(2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w));
  vR2 = vec3(2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y));
`;

// Ball impostor: a quad a little larger than the disc, for the antialiased edge.
export const VS_BALL = `#version 300 es
${ATTRS}
uniform mat3 uClip;
uniform float uDpr;
${VARY('out')}
void main() {
  float r = aPosR.z;
  float pad = 1.0 + 1.5 / max(r * uDpr, 1.0);
  vLocal = aCorner * pad;
  vec2 p = aPosR.xy + vLocal * r;
  gl_Position = vec4((uClip * vec3(p, 1.0)).xy, 0.0, 1.0);
  vCenter = aPosR.xy; vR = r; vRpx = r * uDpr;
  ${QUAT_TO_COLS}
  vC0 = aC0; vC1 = aC1; vC2 = aC2; vP = aP;
}`;

// Shadow quad: centred on the ball, large enough for the offset, stretched penumbra.
export const VS_SHADOW = `#version 300 es
${ATTRS}
uniform mat3 uClip;
uniform vec3 uL;
out vec2 vS;
flat out vec4 vC0;
flat out vec4 vC1;
flat out vec4 vP;
void main() {
  vec2 off = -uL.xy / max(-uL.z, 0.35);
  float ext = 1.7 + 0.8 * length(off);
  vS = aCorner * ext;
  vec2 p = aPosR.xy + vS * aPosR.z;
  gl_Position = vec4((uClip * vec3(p, 1.0)).xy, 0.0, 1.0);
  vC0 = aC0; vC1 = aC1; vP = aP;
}`;

// Full-box quad (unit quad on location 0) in sim px, through uClip.
export const VS_BOX = `#version 300 es
layout(location = 0) in vec2 aUv;
uniform mat3 uClip;
uniform vec2 uSim;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4((uClip * vec3(aUv * uSim, 1.0)).xy, 0.0, 1.0);
}`;

// The back panel of the box, drawn into the offscreen target (sim orientation, texel = sim/uSim).
export const FS_BG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uSim;
uniform vec3 uL;
uniform vec3 uBgLit;     // sRGB, the side toward the light
uniform vec3 uBgFar;     // sRGB, away from it
uniform float uGrain;
uniform float uWeave;
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
// smooth value noise, 0..1: soft blotches in the card / linen, no visible cells
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}
void main() {
  vec2 p = vUv * uSim;
  vec2 c = vUv - 0.5;
  c.y *= uSim.y / uSim.x;          // round light pool in px
  vec2 ld = uL.xy;                 // toward the light, in plane
  float t = 0.62 + dot(c, ld) * 1.1 - dot(c, c) * 0.35;
  vec3 col = mix(uBgFar, uBgLit, clamp(t, 0.0, 1.0));
  // a fine weave behind the glass: it shows the refraction through the balls
  // linen: warp and weft threads ~4 px apart, each thread a little lighter or darker, slubs
  // along it; seen bent and magnified through the clear marbles
  vec2 th = p / 4.0;
  vec2 ci = floor(th);
  vec2 f = fract(th) - 0.5;
  float warp = 1.0 - 4.0 * f.x * f.x, weft = 1.0 - 4.0 * f.y * f.y;
  float sx = hash(vec2(ci.x, floor(p.y / 23.0))) - 0.5, sy = hash(vec2(floor(p.x / 19.0), ci.y + 71.0)) - 0.5;
  float over = mod(ci.x + ci.y, 2.0);
  float wv = mix(warp * (1.0 + 0.5 * sx), weft * (1.0 + 0.5 * sy), over) - 0.55;
  col *= 1.0 + uWeave * wv;
  col *= 1.0 + 0.045 * (vnoise(p / 61.0) - 0.5) + 0.012 * (vnoise(p / 11.0 + 17.0) - 0.5);
  col += (hash(floor(p)) - 0.5) * uGrain;
  // the box walls: a soft inner shadow and a lit glass edge
  float e = min(min(p.x, uSim.x - p.x), min(p.y, uSim.y - p.y));
  col *= 1.0 - 0.32 * exp(-e / 22.0);
  col += vec3(0.05) * exp(-e / 1.6);
  o = vec4(col, 1.0);
}`;

// Shadows on the back panel. Pass 0 multiplies (dark, tinted for glass); pass 1 adds the
// caustic a glass ball focuses onto the panel.
export const FS_SHADOW = `#version 300 es
precision highp float;
in vec2 vS;
flat in vec4 vC0;
flat in vec4 vC1;
flat in vec4 vP;
uniform vec3 uL;
uniform int uPass;
uniform float uAllOpaque;
uniform float uShadow;
out vec4 o;
void main() {
  int type = int(vP.x * 255.0 + 0.5);
  bool opaque = uAllOpaque > 0.5 || type == 3;
  vec2 off = -uL.xy / max(-uL.z, 0.35) * 0.62;
  float lo = length(off);
  vec2 dir = lo > 1e-3 ? off / lo : vec2(0.0, 1.0);
  vec2 p = vS - off;
  float along = dot(p, dir), across = dot(p, vec2(-dir.y, dir.x));
  float e = length(vec2(along / (1.0 + 0.3 * lo), across));
  float soft = 1.0 - smoothstep(0.45, 1.25, e);
  float core = exp(-dot(vS, vS) * 4.5);   // contact: right behind the ball
  if (uPass == 0) {
    vec3 m;
    if (opaque) m = vec3(1.0 - uShadow * (0.5 * soft + 0.28 * core));
    else {
      vec3 tint = mix(vec3(1.0), vC0.rgb, clamp(vC0.a * 1.6, 0.0, 1.0)) * 0.85;
      m = mix(vec3(1.0), tint * 0.62, soft * 0.62 + core * 0.25);
    }
    o = vec4(m, 1.0);
  } else {
    if (opaque) discard;
    vec2 cp = off * 0.75;
    vec2 d = vS - cp;
    float k = exp(-dot(d, d) * 16.0);
    vec3 tint = mix(vec3(1.0), vC0.rgb, clamp(vC0.a * 1.6, 0.0, 1.0));
    vec3 inner = mix(tint, vC1.rgb, type == 0 ? 0.35 : 0.0);
    o = vec4(inner * k * 0.5, 1.0);
  }
}`;

// Composite: the back panel onto the screen.
export const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBg;
out vec4 o;
void main() { o = vec4(texture(uBg, vUv).rgb, 1.0); }`;

const BALL_HEAD = `#version 300 es
precision highp float;
${VARY('in')}
uniform vec3 uL;
out vec4 o;
const float PI = 3.14159265;
vec3 lin(vec3 c) { return c * c; }
vec3 toLocal(vec3 v) { return vec3(dot(vR0, v), dot(vR1, v), dot(vR2, v)); }
vec3 toWorld(vec3 v) { return v.x * vR0 + v.y * vR1 + v.z * vR2; }
// The room in reflections: dark, brighter above, a soft window around the light.
vec3 env(vec3 R) {
  float up = clamp(-R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.012, 0.013, 0.018), vec3(0.11, 0.12, 0.14), up * up);
  float l = max(dot(R, uL), 0.0);
  c += vec3(1.0, 0.96, 0.9) * (0.22 * pow(l, 6.0) + 1.4 * pow(l, 70.0));
  return c;
}
`;

// Glass marbles: refraction of the back panel, coloured interiors, Fresnel reflection.
export const FS_MARBLE = `${BALL_HEAD}
uniform sampler2D uBg;
uniform vec2 uSim;

// Cat's eye: 3-4 planar vanes through the local y axis, lens-shaped, sorted by depth.
vec4 vanes(vec3 P, vec3 D, float len, float seed, vec3 cA, vec3 cB, int nv) {
  float ts[4];
  vec4 cs[4];
  float fnv = float(nv);
  for (int k = 0; k < 4; k++) {
    ts[k] = 1e9; cs[k] = vec4(0.0);
    if (k >= nv) continue;
    float ang = seed + float(k) * PI / fnv;
    vec3 pn = vec3(cos(ang), 0.0, sin(ang));
    float den = dot(pn, D);
    den = abs(den) < 1e-3 ? 1e-3 : den;
    float t = -dot(pn, P) / den;
    if (t < 0.0 || t > len) continue;
    vec3 h = P + t * D;
    float a = h.y, b = dot(h, vec3(-pn.z, 0.0, pn.x));
    float wdt = 0.5 * (1.0 - (a * a) / 0.70);
    float m = smoothstep(0.0, 0.045, wdt - abs(b));
    if (m <= 0.0) continue;
    float streak = 0.82 + 0.18 * sin(b * 38.0 + a * 6.0 + seed * 3.0);
    vec3 nW = toWorld(pn);
    float lit = 0.5 + 0.8 * abs(dot(nW, uL));
    vec3 c = lin((k % 2 == 0) ? cA : cB) * lit * streak;
    float al = m * clamp(0.62 + 0.3 * (1.0 - abs(den)), 0.0, 0.94);
    ts[k] = t; cs[k] = vec4(c, al);
  }
  // sort by depth (4 elements)
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      if (ts[j + 1] < ts[j]) {
        float tt = ts[j]; ts[j] = ts[j + 1]; ts[j + 1] = tt;
        vec4 cc = cs[j]; cs[j] = cs[j + 1]; cs[j + 1] = cc;
      }
    }
  }
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    acc.rgb += (1.0 - acc.a) * cs[k].rgb * cs[k].a;
    acc.a += (1.0 - acc.a) * cs[k].a;
  }
  return acc;
}

// Clear swirl: twisted ribbons around the local y axis, integrated along the ray.
vec4 swirl(vec3 P, vec3 D, float len, float seed, vec3 cA, vec3 cB, float nr, float twist) {
  vec4 acc = vec4(0.0);
  const int S = 7;
  float st = len / float(S);
  vec3 A = lin(cA), B = lin(cB);
  for (int i = 0; i < S; i++) {
    vec3 p = P + D * (st * (float(i) + 0.5));
    float rho = length(p.xz);
    float u = (atan(p.z, p.x) + twist * p.y + seed) * nr / (2.0 * PI);
    float f = abs(fract(u) - 0.5);
    float band = smoothstep(0.26, 0.12, f);
    float dens = band * smoothstep(0.12, 0.3, rho) * smoothstep(0.92, 0.7, rho);
    float a = 1.0 - exp(-dens * 11.0 * st);
    vec3 c = mod(floor(u), 2.0) < 1.0 ? A : B;
    acc.rgb += (1.0 - acc.a) * a * c * (0.75 + 0.35 * (1.0 - rho));
    acc.a += (1.0 - acc.a) * a;
  }
  return acc;
}

// Tiny air bubbles: bright rings where the ray passes close to one.
float bubbles(vec3 P, vec3 D, float len, float seed) {
  float s = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec3 c = 0.62 * vec3(sin(seed * 7.1 + fk * 2.3), cos(seed * 5.3 + fk * 1.7), sin(seed * 3.7 - fk * 2.9));
    float rb = 0.035 + 0.03 * fract(seed * 13.0 + fk * 0.37);
    float t = dot(c - P, D);
    if (t < 0.0 || t > len) continue;
    float dd = length(P + D * t - c) / rb;
    s += smoothstep(1.0, 0.8, dd) * (0.35 + 0.65 * smoothstep(0.55, 0.95, dd));
  }
  return s;
}

void main() {
  float d = length(vLocal);
  float cov = clamp((1.0 - d) * vRpx + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;
  vec2 q = d > 0.998 ? vLocal * (0.998 / d) : vLocal;
  float z = sqrt(max(1.0 - dot(q, q), 0.0));
  vec3 N = vec3(q, -z);
  const vec3 V = vec3(0.0, 0.0, 1.0);
  int type = int(vP.x * 255.0 + 0.5);
  float seed = vP.y * 6.2831853;
  float F = 0.04 + 0.96 * pow(1.0 - z, 5.0);
  vec3 R = reflect(V, N);
  float hl = max(dot(R, uL), 0.0);
  vec3 spec = vec3(1.0, 0.98, 0.95) * (pow(hl, 1400.0) * 5.0 + pow(hl, 220.0) * 0.6);
  vec3 col;
  if (type == 3) {
    // opaque glass with swirled bands on the surface
    vec3 n = toLocal(N);
    float w = 1.6 * n.y + 0.55 * sin(3.1 * n.x + seed) + 0.35 * sin(4.3 * n.z + 2.0 * seed) + 0.18 * sin(9.0 * n.y + 3.0 * n.x);
    float f = fract(w);
    float m1 = smoothstep(0.0, 0.03, f) * smoothstep(0.34, 0.31, f);
    float m2 = smoothstep(0.52, 0.55, f) * smoothstep(0.64, 0.61, f);
    vec3 alb = mix(mix(lin(vC0.rgb), lin(vC1.rgb), m1), lin(vC2.rgb), m2);
    float dif = max(dot(N, uL), 0.0);
    float amb = 0.16 + 0.12 * (0.5 - 0.5 * N.y);
    col = alb * (amb + 0.95 * dif) + alb * 0.12 * smoothstep(0.3, 1.0, z); // a little light from within
    col = col * (1.0 - F) + env(R) * F * 0.9 + spec;
  } else {
    vec3 T1 = refract(V, N, 1.0 / 1.5);
    float len = -2.0 * dot(N, T1);
    vec3 P2 = N + len * T1;
    vec3 T2 = refract(T1, -P2, 1.5);
    if (dot(T2, T2) < 1e-6) T2 = reflect(T1, -P2);
    float sp = (1.0 - P2.z) / max(T2.z, 0.12);
    vec2 hit = P2.xy + T2.xy * min(sp, 3.0);
    vec3 bg = lin(texture(uBg, (vCenter + hit * vR) / uSim).rgb);
    vec3 tint = lin(vC0.rgb);
    vec3 trans = bg * pow(tint, vec3(len * vC0.a * 2.2));
    vec3 Pl = toLocal(N), Dl = toLocal(T1);
    vec4 acc = vec4(0.0);
    if (type == 0) acc = vanes(Pl, Dl, len, seed, vC1.rgb, vC2.rgb, int(vP.z * 255.0 + 0.5));
    else if (type == 1) acc = swirl(Pl, Dl, len, seed, vC1.rgb, vC2.rgb, floor(vP.z * 255.0 + 0.5), vP.w * 255.0 / 40.0);
    float bub = type == 1 ? 0.0 : bubbles(Pl, Dl, len, seed);
    // light gathered by the glass and thrown toward the side away from the light
    vec2 away = -uL.xy;
    float glow = smoothstep(0.2, 0.9, dot(q, away) * 0.9 + 0.25) * (1.0 - smoothstep(0.82, 1.0, d));
    vec3 inside = acc.rgb + (trans + tint * glow * 0.22 * (1.0 - acc.a)) * (1.0 - acc.a);
    inside += vec3(bub) * 0.35 * (0.4 + 0.6 * bg);
    // near the rim the refracted view squeezes into a dark band
    inside *= mix(1.0, 0.28, smoothstep(0.62, 1.0, d));
    col = inside * (1.0 - F) + env(R) * F + spec;
  }
  col = col / (1.0 + 0.25 * max(col - 0.8, 0.0)); // soft shoulder for the glints
  o = vec4(sqrt(clamp(col, 0.0, 1.0)) * cov, cov);
}`;

// Rubber balls: glossy opaque rubber with a pattern that shows the rotation.
export const FS_RUBBER = `${BALL_HEAD}
const vec3 ICO[12] = vec3[12](
  vec3(0.0, 0.526, 0.851), vec3(0.0, -0.526, 0.851), vec3(0.0, 0.526, -0.851), vec3(0.0, -0.526, -0.851),
  vec3(0.526, 0.851, 0.0), vec3(-0.526, 0.851, 0.0), vec3(0.526, -0.851, 0.0), vec3(-0.526, -0.851, 0.0),
  vec3(0.851, 0.0, 0.526), vec3(-0.851, 0.0, 0.526), vec3(0.851, 0.0, -0.526), vec3(-0.851, 0.0, -0.526));
void main() {
  float d = length(vLocal);
  float cov = clamp((1.0 - d) * vRpx + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;
  vec2 q = d > 0.998 ? vLocal * (0.998 / d) : vLocal;
  float z = sqrt(max(1.0 - dot(q, q), 0.0));
  vec3 N = vec3(q, -z);
  const vec3 V = vec3(0.0, 0.0, 1.0);
  int type = int(vP.x * 255.0 + 0.5);
  float seed = vP.y * 6.2831853;
  vec3 n = toLocal(N);
  vec3 c0 = lin(vC0.rgb), c1 = lin(vC1.rgb), c2 = lin(vC2.rgb);
  float aa = 1.5 / max(vRpx, 1.0);
  vec3 alb;
  if (type == 0) {
    float b = abs(n.y);
    alb = mix(c0, c1, smoothstep(0.25 + aa, 0.25 - aa, b));
  } else if (type == 1) {
    alb = mix(c1, c0, smoothstep(-aa, aa, n.y));
  } else if (type == 2) {
    float w = 2.2 * n.x + 0.9 * sin(3.0 * n.y + seed) + 0.6 * sin(5.0 * n.z - seed) + 0.3 * sin(8.0 * n.x + 4.0 * n.y);
    float f = fract(w);
    alb = f < 0.33 ? c0 : f < 0.66 ? c1 : c2;
    float e = min(min(abs(f - 0.33), abs(f - 0.66)), min(f, 1.0 - f));
    alb *= 0.9 + 0.1 * smoothstep(0.0, 0.03, e);
  } else if (type == 3) {
    float m = 0.0;
    for (int k = 0; k < 12; k++) m = max(m, dot(n, ICO[k]));
    alb = mix(c0, c1, smoothstep(0.935 - aa, 0.935 + aa, m));
  } else {
    float ang = atan(n.z, n.x) + PI;
    float seg = floor(ang / (PI / 3.0));
    int si = int(seg) % 3;
    alb = si == 0 ? c0 : si == 1 ? c1 : c2;
    float fe = fract(ang / (PI / 3.0));
    alb = mix(vec3(0.92), alb, smoothstep(0.0, aa * 3.0, min(fe, 1.0 - fe)) * 0.15 + 0.85);
    alb = mix(alb, vec3(0.93), smoothstep(0.9 - aa, 0.9 + aa, abs(n.y)));
  }
  float ndl = dot(N, uL);
  float dif = max(ndl * 0.8 + 0.2, 0.0);
  float amb = 0.16 + 0.16 * (0.5 - 0.5 * N.y);
  vec3 col = alb * (amb + 0.95 * dif);
  // a soft red-shifted wrap where rubber scatters a little light under its skin
  col += alb * alb * 0.12 * smoothstep(-0.3, 0.3, ndl) * (1.0 - smoothstep(0.3, 1.0, ndl));
  float F = 0.04 + 0.96 * pow(1.0 - z, 5.0);
  vec3 R = reflect(V, N);
  float hl = max(dot(R, uL), 0.0);
  col += vec3(1.0, 0.98, 0.95) * (pow(hl, 160.0) * 0.85 + pow(hl, 18.0) * 0.06);
  col = col * (1.0 - F * 0.6) + env(R) * F * 0.55;
  col *= 1.0 - 0.25 * smoothstep(0.75, 1.0, d);
  o = vec4(sqrt(clamp(col, 0.0, 1.0)) * cov, cov);
}`;
