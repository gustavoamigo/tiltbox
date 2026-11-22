// Drawing the globe with WebGL2: one full-screen pass and the flakes (mobile GPUs are fill-rate
// bound, so there is no separate glass pass).
//   1. background (opaque): night sky gradient, stars, the moon, the scene picture, window glow,
//      then the glass: a vignette toward the rim and a soft reflection that drifts with the tilt;
//   2. flakes as point sprites, premultiplied alpha: soft discs for snow, turning hexagons with a
//      star flare for glitter; tinted by the cottage windows they pass and darkened by the same
//      vignette as what lies behind them (the reflection is too faint to miss on them).
// All geometry is in sim px through view.clipMatrix, so a rotated page needs nothing special.

import { compile, unitQuad } from '../../gl.js';

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 a_uv;
uniform mat3 u_clip;
uniform vec2 u_size;
out vec2 v_sim;
void main() {
  v_sim = a_uv * u_size;
  vec3 c = u_clip * vec3(v_sim, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

const COMMON = `
// The glass at sim position p in a box of size sz: x = how much the rim darkens (vignette),
// y = brightness added by the reflection. shift: the reflection's drift with the tilt.
vec2 glass(vec2 p, vec2 sz, vec2 shift) {
  vec2 q = p / sz * 2.0 - 1.0;
  vec2 a = abs(q);
  vec2 a2 = a * a;
  float e = pow(a2.x * a2.x * a.x + a2.y * a2.y * a.y, 0.2); // superellipse |q|_5: the rim
  float vig = 0.62 * smoothstep(0.72, 1.12, e) + 0.12 * smoothstep(0.2, 1.0, length(q * vec2(1.0, 0.8)));
  // a curved window reflection high on the left, and a thin streak beside it
  vec2 r = (p - shift) / sz.x;               // units of the box width
  vec2 c = vec2(1.05, 0.95);
  float dc = length(r - c);
  float ang = atan(r.y - c.y, r.x - c.x);      // the upper-left arc is around -2.3
  float arc = smoothstep(-2.95, -2.55, ang) * smoothstep(-1.75, -2.2, ang);
  float band = exp(-pow((dc - 1.05) / 0.05, 2.0)) * arc;
  float thin = exp(-pow((dc - 0.94) / 0.012, 2.0)) * arc * 0.7;
  // a faint bright edge where the glass meets the frame
  vec2 edge = min(p, sz - p);
  float rimL = exp(-min(edge.x, edge.y) / 2.5) * 0.05;
  return vec2(vig, band * 0.075 + thin * 0.09 + rimL);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 v_sim;
uniform vec2 u_size;
uniform sampler2D u_scene;
uniform vec4 u_sceneRect;   // x0, y0, w, h (sim px)
uniform vec3 u_moon;        // x, y, r
uniform vec4 u_light[3];    // x, y, radius, strength
uniform float u_time;
uniform float u_S;
uniform vec2 u_shift;
out vec4 o;
${COMMON}
void main() {
  vec2 p = v_sim;
  float t = clamp(p.y / u_size.y, 0.0, 1.0);
  vec3 col = mix(vec3(0.012, 0.022, 0.065), vec3(0.075, 0.115, 0.235), t * t * (3.0 - 2.0 * t));

  // moon halo
  vec2 dm = p - u_moon.xy;
  float d = length(dm);
  float r = u_moon.z;
  col += vec3(0.20, 0.25, 0.40) * 0.55 * exp(-max(d - r, 0.0) / (r * 1.3));
  col += vec3(0.10, 0.13, 0.24) * exp(-max(d - r, 0.0) / (r * 6.0));

  // stars: one candidate per 22 px cell, faint, twinkling slowly
  vec2 cell = floor(p / (22.0 * u_S));
  float h = hash12(cell);
  if (h > 0.86) {
    vec2 sp = (cell + 0.2 + 0.6 * vec2(hash12(cell + 7.1), hash12(cell + 3.7))) * 22.0 * u_S;
    float sd = length(p - sp);
    float tw = 0.6 + 0.4 * sin(u_time * (0.7 + 2.0 * h) + h * 40.0);
    float b = (h - 0.86) / 0.14;
    col += vec3(0.75, 0.82, 1.0) * (0.25 + 0.75 * b * b) * tw * exp(-sd * sd / (0.5 + 0.9 * b)) * (1.0 - t * 0.8);
  }

  // moon disc with soft maria
  float m = smoothstep(r + 0.8, r - 0.8, d);
  if (m > 0.0) {
    vec2 q = dm / r;
    float mar = 0.5 * smoothstep(0.42, 0.0, length(q - vec2(-0.25, -0.2)))
              + 0.35 * smoothstep(0.3, 0.0, length(q - vec2(0.3, 0.25)))
              + 0.3 * smoothstep(0.22, 0.0, length(q - vec2(0.05, 0.45)));
    float limb = 1.0 - 0.18 * dot(q, q);
    vec3 mc = vec3(1.0, 0.97, 0.88) * limb * (1.0 - 0.16 * mar);
    col = mix(col, mc, m);
  }

  // scene picture (premultiplied)
  vec2 uv = (p - u_sceneRect.xy) / u_sceneRect.zw;
  if (uv.y >= 0.0) {
    vec4 s = texture(u_scene, uv);
    col = col * (1.0 - s.a) + s.rgb;
  }

  // warm window light spilling out, flickering a little like a fire inside
  for (int i = 0; i < 3; i++) {
    vec4 L = u_light[i];
    float dl = length(p - L.xy);
    float fl = 0.92 + 0.05 * sin(u_time * 7.3 + float(i) * 2.1) + 0.03 * sin(u_time * 17.0 + float(i));
    col += vec3(1.0, 0.62, 0.25) * L.w * fl * exp(-dl * dl / (L.z * L.z));
  }

  vec2 gw = glass(p, u_size, u_shift);
  col = col * (1.0 - gw.x) + vec3(0.85, 0.9, 1.0) * gw.y;
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0; // dither the dark gradients
  o = vec4(col, 1.0);
}`;

const FLAKE_VS = `#version 300 es
layout(location = 0) in vec4 a_a;   // x, y, size (diameter, sim px), shade
layout(location = 1) in vec4 a_b;   // kind (0 snow, 1..4 glitter), angle, softness, spark
uniform mat3 u_clip;
uniform float u_dpr;
uniform float u_maxPt;
uniform vec4 u_light[3];
uniform vec2 u_size;
uniform vec2 u_shift;
out vec4 v_col;      // body colour, premultiplied
out vec3 v_spark;    // flare colour (additive)
out vec4 v_shape;    // kind, body fraction of the sprite, softness, angle
${COMMON}
void main() {
  vec3 c = u_clip * vec3(a_a.xy, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
  float kind = a_b.x;
  float spark = a_b.w;
  float warm = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 d = a_a.xy - u_light[i].xy;
    float R = u_light[i].z * 1.25;
    warm += u_light[i].w * 2.2 * exp(-dot(d, d) / (R * R));
  }
  warm = min(warm, 0.85);
  float size = a_a.z;
  float frac = 1.0;
  if (kind < 0.5) {
    vec3 base = mix(vec3(0.60, 0.68, 0.86), vec3(0.95, 0.97, 1.0), a_a.w);
    base = mix(base, vec3(1.0, 0.80, 0.55), warm);
    float alpha = 0.92 * (1.0 - 0.55 * max(0.0, a_b.z - 0.5) * 2.0);
    v_col = vec4(base * alpha, alpha);
    v_spark = vec3(0.0);
  } else {
    vec3 tint = kind < 1.5 ? vec3(0.86, 0.92, 1.0)    // silver
              : kind < 2.5 ? vec3(1.0, 0.82, 0.48)    // gold
              : kind < 3.5 ? vec3(1.0, 0.66, 0.88)    // rose
              :              vec3(0.58, 0.92, 1.0);   // ice blue
    tint = mix(tint, vec3(1.0, 0.78, 0.45), warm * 0.6);
    // Metal foil: light even when edge-on (never a dark speck on the snow), white-hot on a glint.
    float lum = 0.62 + 0.25 * a_a.w + 0.5 * spark;
    float alpha = 0.7 + 0.3 * spark;
    v_col = vec4(tint * lum * alpha, alpha);
    v_spark = mix(tint, vec3(1.0), 0.55) * spark * 1.25;
    frac = 1.0 / (1.0 + 3.2 * spark);
    size *= 1.0 + 3.2 * spark;
  }
  float px = size * u_dpr;
  gl_PointSize = clamp(px, 1.0, u_maxPt);
  // Points below a pixel or two read as dim specks rather than vanishing: keep their energy.
  float shrink = px / max(gl_PointSize, 1e-3);
  v_col *= min(1.0, shrink * shrink);
  float vig = glass(a_a.xy, u_size, u_shift).x;
  v_col.rgb *= 1.0 - vig;
  v_spark *= 1.0 - vig;
  v_shape = vec4(kind, frac, a_b.z, a_b.y);
}`;

const FLAKE_FS = `#version 300 es
precision mediump float;
in vec4 v_col;
in vec3 v_spark;
in vec4 v_shape;
out vec4 o;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r = length(pc);
  if (v_shape.x < 0.5) {
    // snow: a soft disc, a touch brighter in the middle
    float a = smoothstep(1.0, 1.0 - max(v_shape.z, 0.25), r);
    o = v_col * a * (0.85 + 0.15 * (1.0 - r));
    return;
  }
  // glitter: a small turning hexagon, plus a cross flare and halo when it catches the light
  float ca = cos(v_shape.w), sa = sin(v_shape.w);
  vec2 q = mat2(ca, -sa, sa, ca) * pc / v_shape.y;
  // squash with the turn angle: a flat platelet seen at an angle
  q.x /= 0.35 + 0.65 * abs(cos(v_shape.w * 1.7));
  vec2 aq = abs(q);
  float hex = max(aq.x * 0.866 + aq.y * 0.5, aq.y);
  float body = smoothstep(1.0, 0.72, hex);
  vec2 s = abs(pc);
  float flare = exp(-s.x * 22.0) * exp(-s.y * 3.2) + exp(-s.y * 22.0) * exp(-s.x * 3.2);
  float halo = exp(-r * r * 9.0);
  vec3 add = v_spark * (flare * 0.9 + halo * 0.8);
  o = vec4(v_col.rgb * body + add, v_col.a * body);
}`;

export function createRenderer(gl, maxFlakes) {
  const quad = unitQuad(gl);
  const bg = compile(gl, QUAD_VS, BG_FS);
  const fl = compile(gl, FLAKE_VS, FLAKE_FS);
  const maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;

  const data = new Float32Array(maxFlakes * 8);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
  gl.bindVertexArray(null);

  const sceneTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

  const lights = new Float32Array(12);
  let L = null;

  return {
    data,

    setScene(canvas, layout) {
      L = layout;
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const S = layout.S;
      layout.lights.forEach((l, i) => {
        lights[i * 4] = l.x;
        lights[i * 4 + 1] = l.y;
        lights[i * 4 + 2] = (l.r ? 22 : 34) * S;
        lights[i * 4 + 3] = l.r ? 0.12 : 0.2;
      });
    },

    // frame: { count, time, shiftX, shiftY }
    draw(view, frame) {
      if (!L) return;
      gl.viewport(0, 0, view.pxW, view.pxH);
      gl.disable(gl.BLEND);

      gl.useProgram(bg.program);
      gl.uniformMatrix3fv(bg.u.u_clip, false, view.clipMatrix);
      gl.uniform2f(bg.u.u_size, view.simW, view.simH);
      gl.uniform4f(bg.u.u_sceneRect, 0, L.top, L.W, L.H - L.top);
      gl.uniform3f(bg.u.u_moon, L.moon.x, L.moon.y, L.moon.r);
      gl.uniform4fv(bg.u.u_light, lights);
      gl.uniform1f(bg.u.u_time, frame.time);
      gl.uniform1f(bg.u.u_S, L.S);
      gl.uniform2f(bg.u.u_shift, frame.shiftX, frame.shiftY);
      gl.uniform1i(bg.u.u_scene, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      quad.draw();

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(fl.program);
      gl.uniformMatrix3fv(fl.u.u_clip, false, view.clipMatrix);
      gl.uniform1f(fl.u.u_dpr, view.dpr);
      gl.uniform1f(fl.u.u_maxPt, maxPt);
      gl.uniform4fv(fl.u.u_light, lights);
      gl.uniform2f(fl.u.u_size, view.simW, view.simH);
      gl.uniform2f(fl.u.u_shift, frame.shiftX, frame.shiftY);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, frame.count * 8);
      gl.drawArrays(gl.POINTS, 0, frame.count);
      gl.bindVertexArray(null);

      gl.disable(gl.BLEND);
    },

    dispose() {
      quad.dispose();
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteTexture(sceneTex);
      gl.deleteProgram(bg.program);
      gl.deleteProgram(fl.program);
    },
  };
}
