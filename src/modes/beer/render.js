// The head, drawn over the liquid (../fluid/surface.js draws the beer first). Per frame:
//   1. splat the foam particles into a field target (density, coarseness), mirrored across the
//      walls like the liquid's, and blur it once;
//   2. carbonation bubbles: small bright rings, premultiplied over the beer;
//   3. composite: the lacing on the dry glass and the foam body (creamy, a fine bubbly texture,
//      lit on top, wet and golden where it meets the beer), premultiplied over all of it;
//   4. the coarse bubbles of fresh foam, drawn on the foam particles so they move with it.
// Everything reaches the screen through view.clipMatrix, as the liquid does.

import { compile, makeTarget, unitQuad } from '../../gl.js';
import { SPLAT_VS, SPLAT_FS, TARGET_VS, BLUR_FS, COMP_VS } from '../fluid/shaders.js';

const SPLAT_STRIDE = 5; // x, y, coarse, 0, weight (the liquid's splat layout)
const SPRITE_STRIDE = 4; // x, y, radius, alpha

const FOAM_FS = `#version 300 es
precision highp float;
in vec2 vSim;
out vec4 o;
uniform sampler2D uFoam;
uniform sampler2D uLiq;
uniform sampler2D uLace;
uniform vec2 uBox;
uniform vec2 uTexel;     // one foam-field texel, uv
uniform float uTexPx;    // sim px per foam-field texel
uniform float uFoamScale, uLiqScale;
uniform float uThresh;   // foam iso level
uniform float uLiqThresh;
uniform float uPx;       // sim px per device px
uniform vec2 uUp;
uniform vec2 uLight;
uniform float uTime;
uniform vec3 uCream, uWarm, uShade, uLaceCol;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Cells of a foam: (distance to the nearest cell centre, gap to the second nearest).
vec2 worley(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = g + hash22(i + g) * 0.85 + 0.075 - f;
      float d = dot(c, c);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2(sqrt(d1), sqrt(d2) - sqrt(d1));
}

void main() {
  vec2 uv = vSim / uBox;
  vec4 f = texture(uFoam, uv) * uFoamScale;
  float rho = f.r;
  float lace = texture(uLace, uv).r;
  if (rho < uThresh * 0.3 && lace < 0.02) discard;
  float liq = texture(uLiq, uv).r * uLiqScale;

  vec2 q = uv - 0.5;
  float vign = 1.0 - 0.35 * dot(q, q) * 2.0;
  vec4 acc = vec4(0.0);

  // Lacing: lace left on the dry glass. Patches with scalloped holes (they shrink as the film
  // fades), each a net of bright thin bubble walls over clear glass, with a whiter rim where the
  // film thickened at its edge. Mostly see-through: a flat fill reads as grey dirt on dark glass.
  float dry = 1.0 - smoothstep(0.5 * uLiqThresh, uLiqThresh, liq);
  if (lace > 0.02 && dry > 0.0) {
    float n = vnoise(vSim * 0.045) * 0.55 + vnoise(vSim * 0.11 + 5.2) * 0.3 + vnoise(vSim * 0.27 + 9.7) * 0.15;
    n -= 0.22 * worley(vSim / 6.0).x;
    float v = n + 0.3 * lace;
    float film = smoothstep(0.62, 0.65, v);
    if (film > 0.0) {
      vec2 w = worley(vSim / 2.2);
      float wall = 1.0 - smoothstep(0.03, 0.14, w.y);
      float rim = film * (1.0 - smoothstep(0.66, 0.72, v));
      float a = dry * smoothstep(0.02, 0.2, lace) * clamp(film * (0.06 + 0.5 * wall) + 0.45 * rim, 0.0, 0.85);
      acc = vec4(uLaceCol * vign * a, a);
    }
  }

  if (rho > uThresh * 0.3) {
    float coarse = clamp(f.g / max(rho, 1e-3), 0.0, 1.0);
    vec2 grad = vec2(texture(uFoam, uv + vec2(uTexel.x, 0.0)).r - texture(uFoam, uv - vec2(uTexel.x, 0.0)).r,
                     texture(uFoam, uv + vec2(0.0, uTexel.y)).r - texture(uFoam, uv - vec2(0.0, uTexel.y)).r)
                * uFoamScale / (2.0 * uTexPx);
    float gl = length(grad);
    vec2 nIn = gl > 1e-5 ? grad / gl : -uUp;
    float sd = (rho - uThresh) / max(gl, 1e-3); // sim px inside the foam's outline
    float cover = clamp(sd / uPx + 0.5, 0.0, 1.0);
    float inside = clamp(sd, 0.0, 200.0);
    // Beer just under this point: the foam there is wet, golden and a little see-through.
    float below = texture(uLiq, (vSim - uUp * 4.0) / uBox).r * uLiqScale;
    float facing = dot(-nIn, uUp);
    float wet = smoothstep(0.6 * uLiqThresh, 1.2 * uLiqThresh, max(below, liq))
              * (0.25 + 0.75 * smoothstep(0.2, -0.6, facing) * exp(-inside / 5.0));
    // Fine bubbles everywhere, larger where the foam is fresh from a shake.
    float sc = mix(2.2, 4.5, coarse);
    vec2 w = worley(vSim / sc);
    float wall = 1.0 - smoothstep(0.04, 0.22, w.y);
    float n = vnoise(vSim * 0.08);
    vec3 col = mix(uCream, uWarm, wet * 0.75);
    col = mix(col, uShade, wall * (0.12 + 0.2 * coarse) + 0.05 * n);
    // Light from above: the top of the head is brightest; deeper in, the foam is a touch grey.
    float top = smoothstep(-0.1, 0.8, facing) * exp(-inside / 7.0);
    col += 0.10 * top;
    col *= 0.93 + 0.07 * smoothstep(40.0, 0.0, inside);
    // A soft glint on the foam's upper rim, toward the room light.
    float rim = exp(-inside / 2.5) * max(dot(-nIn, uLight), 0.0);
    col += 0.10 * rim;
    float a = cover * (0.97 - 0.3 * wet * smoothstep(10.0, 0.0, inside));
    acc = vec4(col * vign * a, a) + acc * (1.0 - a);
  }
  if (acc.a < 0.002) discard;
  o = acc;
}`;

const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aI; // x, y, radius (sim px), alpha
uniform mat3 uM;
uniform vec2 uBox;
out vec2 vUV;
out float vA;
out float vId;
void main() {
  vUV = aCorner;
  vA = aI.w;
  vId = float(gl_InstanceID);
  if (aI.w < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 p = aI.xy + aCorner * aI.z;
  vec3 c = uM * vec3(p, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

// uKind 0: a carbonation bubble in the beer (bright rim, a glint that twinkles);
// 1: a coarse bubble in fresh foam (a thin shadowed wall with a highlight).
const SPRITE_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in float vA;
in float vId;
uniform float uKind;
uniform float uEdge;
uniform float uTime;
uniform vec3 uRim, uFill;
out vec4 o;
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float ring = smoothstep(0.5, 0.85, r) * (1.0 - smoothstep(1.0 - uEdge, 1.0, r));
  float glint = 1.0 - smoothstep(0.0, 0.4, length(vUV - vec2(-0.33, -0.38)));
  if (uKind < 0.5) {
    float tw = 0.65 + 0.35 * sin(uTime * 7.0 + vId * 1.7);
    float a = vA * clamp(ring * 0.8 + glint * tw + 0.1, 0.0, 1.0);
    vec3 col = mix(uFill, uRim, clamp(ring + glint, 0.0, 1.0));
    o = vec4(col * a, a);
  } else {
    float a = vA * clamp(ring * 0.22 + glint * 0.3, 0.0, 1.0);
    vec3 col = mix(vec3(0.55, 0.5, 0.42), vec3(1.0), glint);
    o = vec4(col * a, a);
  }
}`;

export class HeadRenderer {
  // look: HEAD.look; opts: { texScale, maxFoam, maxBubbles }
  constructor(gl, look, opts) {
    this.gl = gl;
    this.look = look;
    this.opts = opts;
    this.maxSplat = opts.maxFoam * 2 + 64;
    this.splat = new Float32Array(this.maxSplat * SPLAT_STRIDE);
    this.maxSprites = Math.max(opts.maxFoam, opts.maxBubbles);
    this.sprites = new Float32Array(this.maxSprites * SPRITE_STRIDE);
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.pSplat = compile(gl, SPLAT_VS, SPLAT_FS);
    this.pBlur = compile(gl, TARGET_VS, BLUR_FS);
    this.pFoam = compile(gl, COMP_VS, FOAM_FS);
    this.pSprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.quad = unitQuad(gl);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.splatVao = gl.createVertexArray();
    gl.bindVertexArray(this.splatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.splatBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.splat.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SPLAT_STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, SPLAT_STRIDE * 4, 16);
    gl.vertexAttribDivisor(2, 1);

    this.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.spriteBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sprites.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SPRITE_STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.field = null;
    this.fieldB = null;
    this.laceTex = null;
    this.laceW = 0;
    this.laceH = 0;
  }

  restore() { this._init(); }

  _ensure(W, H, lw, lh) {
    const gl = this.gl;
    const tw = Math.max(16, Math.round(W * this.opts.texScale));
    const th = Math.max(16, Math.round(H * this.opts.texScale));
    if (!this.field || this.field.w !== tw || this.field.h !== th) {
      if (this.field) this.field.dispose();
      if (this.fieldB) this.fieldB.dispose();
      this.field = makeTarget(gl, tw, th, { float: true, filter: gl.LINEAR });
      this.fieldB = makeTarget(gl, tw, th, { float: true, filter: gl.LINEAR });
    }
    if (!this.laceTex || this.laceW !== lw || this.laceH !== lh) {
      if (this.laceTex) gl.deleteTexture(this.laceTex);
      this.laceTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.laceTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, lw, lh, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      this.laceW = lw;
      this.laceH = lh;
    }
  }

  // The foam particles, then mirror images across the walls they are within R of.
  _fillSplat(head, R) {
    const s = this.splat;
    const L = this.look;
    const { nf, fx, fy, fr, fc, W, H, rf } = head;
    const max = this.maxSplat;
    let k = 0;
    for (let i = 0; i < nf && k < max; i++) {
      const o = k++ * SPLAT_STRIDE;
      // A shrinking particle fades out of the field; a lone fleck is splatted heavier, enough
      // to show at about its own size instead of vanishing under the iso level.
      const nn = head.fnn[i];
      const lone = nn >= 4 ? 0 : 1 - nn / 4;
      const w = (fr[i] / rf) ** 2 * (1 + (L.loneWeight - 1) * lone);
      s[o] = fx[i]; s[o + 1] = fy[i]; s[o + 2] = fc[i]; s[o + 3] = 0; s[o + 4] = w;
    }
    const n = k;
    for (let i = 0; i < n && k < max; i++) {
      const x = s[i * SPLAT_STRIDE]; const y = s[i * SPLAT_STRIDE + 1];
      const mx = x < R ? -x : x > W - R ? 2 * W - x : NaN;
      const my = y < R ? -y : y > H - R ? 2 * H - y : NaN;
      if (mx !== mx && my !== my) continue;
      if (mx === mx && k < max) this._copy(i, k++, mx, y);
      if (my === my && k < max) this._copy(i, k++, x, my);
      if (mx === mx && my === my && k < max) this._copy(i, k++, mx, my);
    }
    return k;
  }

  _copy(src, dst, x, y) {
    const s = this.splat;
    const a = src * SPLAT_STRIDE; const b = dst * SPLAT_STRIDE;
    s[b] = x; s[b + 1] = y; s[b + 2] = s[a + 2]; s[b + 3] = 0; s[b + 4] = s[a + 4];
  }

  _drawSprites(view, n, kind, rim, fill, time) {
    const gl = this.gl;
    if (n <= 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sprites, 0, n * SPRITE_STRIDE);
    gl.useProgram(this.pSprite.program);
    const u = this.pSprite.u;
    gl.uniformMatrix3fv(u.uM, false, view.clipMatrix);
    gl.uniform1f(u.uKind, kind);
    gl.uniform1f(u.uEdge, 0.35);
    gl.uniform1f(u.uTime, time);
    gl.uniform3fv(u.uRim, rim);
    gl.uniform3fv(u.uFill, fill);
    gl.bindVertexArray(this.spriteVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
  }

  // frame: { liquid (the LiquidRenderer, after its render), liqThresh, up, light, time }
  render(view, head, frame) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const L = this.look;
    const { W, H } = head;
    this._ensure(W, H, head.lw, head.lh);
    const f = this.field;
    const R = L.splat * 2 * head.rf;
    const nSplat = this._fillSplat(head, R);

    // 1. splat + blur
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.splat, 0, nSplat * SPLAT_STRIDE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.viewport(0, 0, f.w, f.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pSplat.program);
    let u = this.pSplat.u;
    gl.uniform2f(u.uBox, W, H);
    gl.uniform1f(u.uR, R);
    const scale = f.half ? 1 : 1 / 16;
    gl.uniform1f(u.uScale, scale);
    gl.bindVertexArray(this.splatVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nSplat);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldB.fbo);
    gl.viewport(0, 0, f.w, f.h);
    gl.useProgram(this.pBlur.program);
    u = this.pBlur.u;
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.uniform1i(u.uSrc, 0);
    gl.uniform2f(u.uStep, 1 / f.w, 0);
    this.quad.draw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldB.tex);
    gl.uniform2f(u.uStep, 0, 1 / f.h);
    this.quad.draw();

    // lacing
    gl.bindTexture(gl.TEXTURE_2D, this.laceTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, head.lw, head.lh, gl.RED, gl.UNSIGNED_BYTE, head.lace8);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, view.pxW, view.pxH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // 2. carbonation
    const sp = this.sprites;
    let n = 0;
    for (let i = 0; i < head.nb; i++) {
      const o = n++ * SPRITE_STRIDE;
      const a = head.bage[i];
      sp[o] = head.bx[i]; sp[o + 1] = head.by[i];
      sp[o + 2] = Math.max(1.0 / view.dpr, head.br[i]);
      sp[o + 3] = Math.min(1, a * 8, (head.bubbleLifeNow - a) * 5) * 0.85;
    }
    this._drawSprites(view, n, 0, L.bubbleRim, L.bubbleFill, frame.time);

    // 3. lacing and foam
    const liq = frame.liquid.field;
    gl.useProgram(this.pFoam.program);
    u = this.pFoam.u;
    const bulk = (Math.PI * (2 * L.splat) ** 2) / (8 * Math.sqrt(3));
    gl.uniformMatrix3fv(u.uM, false, view.clipMatrix);
    gl.uniform2f(u.uBox, W, H);
    gl.uniform2f(u.uTexel, 1 / f.w, 1 / f.h);
    gl.uniform1f(u.uTexPx, W / f.w);
    gl.uniform1f(u.uFoamScale, 1 / scale);
    gl.uniform1f(u.uLiqScale, liq && liq.half ? 1 : 16);
    gl.uniform1f(u.uThresh, L.thresh * bulk);
    gl.uniform1f(u.uLiqThresh, frame.liqThresh);
    gl.uniform1f(u.uPx, 1 / view.dpr);
    gl.uniform2f(u.uUp, frame.up.x, frame.up.y);
    gl.uniform2f(u.uLight, frame.light.x, frame.light.y);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform3fv(u.uCream, L.cream);
    gl.uniform3fv(u.uWarm, L.warm);
    gl.uniform3fv(u.uShade, L.shade);
    gl.uniform3fv(u.uLaceCol, L.lace);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.uniform1i(u.uFoam, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, liq ? liq.tex : f.tex);
    gl.uniform1i(u.uLiq, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.laceTex);
    gl.uniform1i(u.uLace, 2);
    this.quad.draw();
    gl.activeTexture(gl.TEXTURE0);

    // 4. coarse bubbles in fresh foam
    n = 0;
    for (let i = 0; i < head.nf && n < this.maxSprites; i++) {
      const c = head.fc[i];
      if (c < 0.5 || head.fnn[i] < 4) continue; // in the body of the foam only
      const o = n++ * SPRITE_STRIDE;
      sp[o] = head.fx[i]; sp[o + 1] = head.fy[i];
      sp[o + 2] = head.fr[i] * (0.4 + 1.6 * (c - 0.5) * (c - 0.5) * 4);
      sp[o + 3] = c * Math.min(1, head.fr[i] / head.frt[i] || 0);
    }
    this._drawSprites(view, n, 1, L.bubbleRim, L.bubbleFill, frame.time);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    for (const t of [this.field, this.fieldB]) if (t) t.dispose();
    if (this.laceTex) gl.deleteTexture(this.laceTex);
    this.quad.dispose();
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.splatBuf);
    gl.deleteBuffer(this.spriteBuf);
    gl.deleteVertexArray(this.splatVao);
    gl.deleteVertexArray(this.spriteVao);
    for (const p of [this.pSplat, this.pBlur, this.pFoam, this.pSprite]) gl.deleteProgram(p.program);
  }
}
