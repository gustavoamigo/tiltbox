// GLSL for the screen-space liquid (surface.js). Sim px throughout: the box is [0, W] x [0, H],
// y down; the composite and the bubbles reach the screen through view.clipMatrix.

// 1. Splat: each particle is a soft disc added into the reduced-resolution field target.
//    R: density, G: density x foam, B: density x speed (0..1), A: unused.
export const SPLAT_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aP; // x, y (sim px), foam 0..1, spray speed 0..1
layout(location = 2) in float aW; // splat weight
uniform vec2 uBox;
uniform float uR;
out vec2 vUV;
out vec3 vD;
void main() {
  vUV = aCorner;
  vD = vec3(aP.zw, aW);
  vec2 p = aP.xy + aCorner * uR;
  gl_Position = vec4(p / uBox * 2.0 - 1.0, 0.0, 1.0);
}`;

export const SPLAT_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec3 vD;
uniform float uScale;
out vec4 o;
void main() {
  float w = max(1.0 - dot(vUV, vUV), 0.0);
  w = w * w * w;
  w *= vD.z;
  o = vec4(w, w * vD.x, w * vD.y, 0.0) * uScale; // G / R and B / R: weighted mean foam, spray
}`;

// Full-screen-in-the-target pass for the blur and the caustics: aPos is the unit quad.
export const TARGET_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

// 2. A separable 5-tap Gaussian on the field: rounds off the particle-scale bumps.
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uStep; // one texel along the blur axis, in uv
out vec4 o;
void main() {
  // 5 taps folded into 3 bilinear fetches: weights 1 4 6 4 1 / 16
  vec2 d = uStep * 1.2;
  o = texture(uSrc, vUV) * 0.375 + (texture(uSrc, vUV + d) + texture(uSrc, vUV - d)) * 0.3125;
}`;

// 3. Caustics: moving light lines on the back glass, cast by the wavy surface. A small target in
//    the sim frame, refreshed every frame; the composite samples it under the liquid.
//    The pattern is the well-known iterated-trig water caustic; its clock runs with the motion.
export const CAUSTIC_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec2 uBox;
uniform float uT;
uniform float uScale; // pattern cells per sim px
out vec4 o;
void main() {
  vec2 p = vUV * uBox * uScale - 250.0;
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = uT * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  float v = pow(abs(c), 7.0);
  o = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// 4. Composite: the field becomes the liquid, drawn over the back glass.
export const COMP_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform mat3 uM;
uniform vec2 uBox;
out vec2 vSim;
void main() {
  vSim = aPos * uBox;
  vec3 c = uM * vec3(vSim, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

export const COMP_FS = `#version 300 es
precision highp float;
in vec2 vSim;
out vec4 outColor;

uniform sampler2D uField;
uniform sampler2D uDepth;
uniform sampler2D uCaustic;
uniform vec2 uBox;        // sim px
uniform vec2 uTexel;      // one field texel, in uv
uniform float uTexPx;     // sim px per field texel
uniform float uFieldScale;// undo the RGBA8 range squeeze
uniform float uThresh;    // iso level of the surface
uniform float uBulk;      // field value inside resting liquid
uniform float uDepthMax;  // sim px that depth texture 1.0 stands for
uniform float uCellPx;    // sim px per grid cell
uniform float uPx;        // sim px per device px
uniform vec2 uUp;         // unit, against in-plane gravity (sim frame)
uniform vec2 uLight;      // unit, toward the light in the sim frame (screen-fixed: the room)
uniform float uTime;
uniform float uWobble;    // refraction ripple, sim px (grows with motion)

// look (presets.js)
uniform int uPattern;     // 0: dots, 1: honeycomb, 2: none (plain glass)
uniform vec3 uBgTop, uBgBot; // the dry back glass, top and bottom
uniform vec3 uTileA, uTileB, uGroutCol;
uniform float uTileSize;
uniform vec3 uWetGain;    // the back glass seen through the liquid: tint and light
uniform vec3 uAbsorb;     // extinction per 100 px of depth below the surface
uniform vec3 uShallow, uDeep;
uniform float uDeepPx;
uniform vec3 uRimCol;
uniform float uRim, uRimW;
uniform float uMirror;   // the soft band under the free surface
uniform vec3 uSpecCol;
uniform float uSpec, uShine;
uniform float uLens;      // refraction at the edges, sim px
uniform float uBulge;     // how rounded the liquid's edges look (0 flat sheet .. 1 thick goo)
uniform vec3 uFoamCol;
uniform float uFoam;
uniform float uSpray;     // whitening of thin, fast sheets and droplets
uniform float uCaust;
uniform vec3 uCaustCol;
uniform float uRays;      // light shafts under the surface
uniform float uBubbleHole; // air pockets inside the liquid drawn as bubbles
uniform float uGlow;      // light carried in from the surface, fading with depth (honey)
uniform vec3 uGlowCol;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

// The pattern on the back glass. Returns (pattern 0..1: 1 on a mark, its shade 0..1).
// aa: the pattern's anti-aliasing width in pattern units (no derivatives: called in branches).
vec2 pattern(vec2 p, float aa) {
  if (uPattern == 2) return vec2(0.0); // plain glass: no marks
  if (uPattern == 0) {
    // a grid of small dots, every other row offset: fine enough to show the lens at the edges
    vec2 g = p / uTileSize;
    g.x += 0.5 * mod(floor(g.y), 2.0);
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float d = length(f) - 0.09;
    return vec2(1.0 - smoothstep(-aa, aa, d), hash12(id));
  }
  // honeycomb: hexagonal cells with thin walls
  vec2 g = p / uTileSize;
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(g, s) - s * 0.5;
  vec2 b = mod(g - s * 0.5, s) - s * 0.5;
  vec2 h = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = g - h;
  vec2 ah = abs(h);
  float e = max(dot(ah, normalize(s)), ah.x); // hex distance, 0.5 at the wall
  float d = e - 0.44;
  return vec2(1.0 - smoothstep(-aa, aa, d), hash12(floor(id * 2.0)));
}

vec3 backGlass(vec2 p, out float face) {
  float aa = 1.2 * uPx / uTileSize;
  vec2 pt = pattern(p, aa);
  face = pt.x;
  float y = clamp(p.y / uBox.y, 0.0, 1.0);
  vec3 base = mix(uBgTop, uBgBot, y);
  vec3 tile = mix(uTileA, uTileB, pt.y);
  return base + mix(uGroutCol, tile, pt.x);
}

float field(vec2 uv) { return texture(uField, uv).r * uFieldScale; }

void main() {
  vec2 uv = vSim / uBox;
  vec4 c = texture(uField, uv) * uFieldScale;
  float rho = c.r;
  float face;
  vec3 dry = backGlass(vSim, face);

  // The front glass: a soft diagonal sheen and a gentle vignette, over everything.
  vec2 q = vSim / uBox - 0.5;
  float vign = 1.0 - 0.35 * dot(q, q) * 2.0;
  float sheen = 0.035 * smoothstep(0.25, 0.0, abs(dot(q, vec2(0.8, 0.6)) + 0.18));

  // Distance to the air from the sim grid: deep inside, a gap between particles is not a hole.
  float depthTex = texture(uDepth, uv).r * uDepthMax;
  float solid = smoothstep(1.5, 2.5, depthTex / uCellPx);
  // A gap with liquid all round it is an air pocket: it shows as a pale bubble, not as the dark
  // glass behind (one ring of four taps, only where the liquid is thin).
  if (rho < uThresh * 1.5 && uBubbleHole > 0.0) {
    vec2 d = uTexel * 3.0;
    float ring = field(uv + vec2(d.x, 0.0)) + field(uv - vec2(d.x, 0.0)) + field(uv + vec2(0.0, d.y)) + field(uv - vec2(0.0, d.y));
    float enclosed = smoothstep(0.5, 0.75, ring / (4.0 * uBulk));
    dry = mix(dry, uFoamCol * 0.55 + uShallow * 0.4, enclosed * uBubbleHole);
  }
  if (rho < uThresh * 0.4 && solid == 0.0) {
    outColor = vec4(dry * vign + sheen, 1.0);
    return;
  }

  vec2 grad = vec2(field(uv + vec2(uTexel.x, 0.0)) - field(uv - vec2(uTexel.x, 0.0)),
                   field(uv + vec2(0.0, uTexel.y)) - field(uv - vec2(0.0, uTexel.y))) / (2.0 * uTexPx);
  float gl = length(grad);
  vec2 nIn = gl > 1e-5 ? grad / gl : -uUp;   // points into the liquid
  float sd = (rho - uThresh) / max(gl, 1e-3); // sim px inside the surface (approx.)
  float cover = max(clamp(sd / uPx + 0.5, 0.0, 1.0), solid);
  float sdi = max(clamp(sd, 0.0, 400.0), solid * depthTex);
  float depth = max(depthTex, min(sdi, 30.0));

  // A rounded edge: a height that rises from the outline and levels off inside; its slope
  // tilts the normal for the lens and the highlights.
  float bw = 6.0 + 10.0 * uBulge;
  float edge = exp(-sdi / bw);                // 1 at the outline, 0 well inside
  vec3 n3 = normalize(vec3(-nIn * edge * (0.6 + 1.6 * uBulge), 1.0)); // toward the viewer

  // The back glass seen through the liquid: shifted by the curved edge and a little ripple.
  float speed = clamp(c.b / max(rho, 1e-3), 0.0, 1.0); // lone droplets and spray only
  vec2 rip = vec2(vnoise(vSim * 0.045 + vec2(uTime * 0.7, 0.0)), vnoise(vSim * 0.045 + vec2(0.0, uTime * 0.6) + 7.3)) - 0.5;
  vec2 refr = -nIn * uLens * edge + rip * uWobble * (0.6 + speed);
  float wface;
  vec3 wet = backGlass(vSim + refr, wface);
  wet *= uWetGain;

  // Light: absorbed with depth below the surface, in-scattered colour, caustics near the top.
  vec3 tr = exp(-uAbsorb * (depth / 100.0));
  float dk = 1.0 - exp(-depth / uDeepPx);
  vec3 col = wet * tr + mix(uShallow, uDeep, dk);
  if (uCaust > 0.0) {
    float ca = texture(uCaustic, (vSim + refr * 2.0) / uBox).r;
    col += uCaustCol * uCaust * ca * exp(-depth / 120.0) * smoothstep(2.0, 14.0, sdi) * (0.35 + 0.65 * wface);
  }
  col += uGlowCol * uGlow * exp(-depth / 40.0);
  // Shafts of light from the surface, slanting down from the room light and drifting slowly.
  if (uRays > 0.0) {
    vec2 rd = normalize(-uUp + vec2(-uUp.y, uUp.x) * 0.3); // down, slanted a little
    float across = dot(vSim, vec2(-rd.y, rd.x));
    float r1 = vnoise(vec2(across * 0.035, uTime * 0.25));
    float r2 = vnoise(vec2(across * 0.09 + 13.0, uTime * 0.4));
    float ray = r1 * r1 * (0.6 + 0.8 * r2);
    col += uShallow * uRays * ray * exp(-depth / 260.0) * smoothstep(0.0, 30.0, depth);
  }

  // The surface seen from inside: a bright band just within the outline, brightest where the
  // outline faces up (the underside of the free surface reflects the sky).
  float facing = dot(-nIn, uUp);
  float upness = smoothstep(-0.2, 0.8, facing);
  float band = exp(-sdi / uRimW);
  col += uRimCol * uRim * band * (0.35 + 0.65 * upness);
  // Below that, the underside of the surface mirrors the lit water under it: a soft band.
  col += uShallow * uMirror * exp(-sdi / (5.0 * uRimW)) * upness;

  // Specular from the room light, on the rounded edge; a tighter glint on top.
  vec3 L = normalize(vec3(uLight, 0.9));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(n3, H), 0.0);
  float spec = pow(nh, uShine) * edge;
  float glint = pow(nh, uShine * 4.0) * edge;
  col += uSpecCol * uSpec * (spec * 0.6 + glint * 1.4);

  // Whitewater: milky where foamy, with a bubbly texture.
  float foam = clamp(c.g / max(rho, 1e-3), 0.0, 1.0);
  float w = uSpray * speed;
  if (uFoam > 0.0 && foam > 0.01) {
    float n1 = vnoise(vSim * 0.35 + vec2(0.0, uTime * 1.5));
    float n2 = vnoise(vSim * 0.12 - vec2(uTime * 0.3, -uTime * 0.4));
    w += uFoam * smoothstep(0.0, 0.7, foam) * (0.45 + 0.55 * n2) * (0.75 + 0.5 * n1);
  }
  col = mix(col, uFoamCol, clamp(w, 0.0, 0.85));

  // Anti-aliased outline: the liquid over the dry glass; a hairline of light right on the edge.
  vec3 outC = mix(dry, col, cover);
  float hair = cover * (1.0 - cover) * 4.0;
  outC += uRimCol * hair * 0.25 * uRim;
  outColor = vec4(outC * vign + sheen, 1.0);
}`;

// 5. Bubbles: small rings drawn over the liquid where particles carry foam (water) or, for
//    honey, a sparse fixed set of trapped air bubbles that show the flow.
export const BUBBLE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aP; // x, y, foam, speed
uniform mat3 uM;
uniform float uSize;    // sim px, largest bubble radius
uniform float uMode;    // 0: foam bubbles, 1: fixed sparse bubbles (honey)
uniform float uEvery;   // mode 1: one particle in this many is a bubble
uniform float uTime;
out vec2 vUV;
out float vA;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float id = float(gl_InstanceID);
  float a;
  float sz;
  vec2 off;
  if (uMode < 0.5) {
    a = smoothstep(0.12, 0.6, aP.z);
    sz = uSize * (0.35 + 0.65 * h1(id));
    off = (vec2(h1(id + 3.1), h1(id + 5.7)) - 0.5) * uSize * 2.0;
  } else {
    a = mod(id, uEvery) < 0.5 ? 0.9 : 0.0;
    sz = uSize * (0.4 + 0.6 * h1(id));
    off = vec2(0.0);
  }
  vA = a;
  vUV = aCorner;
  if (a < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // culled
  vec2 p = aP.xy + off + aCorner * sz;
  vec3 c = uM * vec3(p, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

export const BUBBLE_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in float vA;
uniform vec3 uRing;
uniform vec3 uFill;
uniform float uEdge;    // ring softness in uv units (about one device px)
out vec4 o;
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float ring = smoothstep(0.55, 0.85, r) * (1.0 - smoothstep(1.0 - uEdge, 1.0, r));
  float dot2 = 1.0 - smoothstep(0.0, 0.32, length(vUV - vec2(-0.35, -0.35)));
  float a = vA * clamp(ring * 0.75 + dot2 * 0.9 + 0.12, 0.0, 1.0);
  vec3 col = mix(uFill, uRing, clamp(ring + dot2, 0.0, 1.0));
  o = vec4(col * a, a); // premultiplied
}`;
