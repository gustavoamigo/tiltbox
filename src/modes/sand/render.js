// Draws the sand with WebGL2 in three passes, all straight to the screen:
//   1. the box behind the sand: a dark warm gradient, and inside the pile a dark sand tone so the
//      gaps between grains read as shadow (one full-screen quad);
//   2. the grains: one point sprite each, a little larger than its cell so the sand reads as a
//      solid mass. Each grain is lit by how much sand lies above it, looked up in a small
//      occupancy texture (the grid itself, one byte a cell): grains on the free surface are
//      bright, grains deep in the pile darker, so a heap reads as a heap. Within the sprite, a
//      grain is a little brighter on the side facing up;
//   3. the glass over it: a faint sheen and a darker rim (one blended full-screen quad).
// Positions are uploaded only while something moves, the occupancy texture only when a grain
// changed cell.

import { compile, unitQuad } from '../../gl.js';

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 a_uv;
uniform mat3 u_clip;
uniform vec2 u_box;
out vec2 v_p;
void main() {
  v_p = a_uv * u_box;
  gl_Position = vec4((u_clip * vec3(v_p, 1.0)).xy, 0.0, 1.0);
}`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 v_p;
uniform vec2 u_box;
uniform vec2 u_up;
uniform sampler2D u_occ;
uniform vec2 u_texel; // one grid cell in uv
out vec4 o;
void main() {
  vec2 uv = v_p / u_box;
  // lighter toward "up", like a box lit from above
  float h = dot(uv - 0.5, u_up) + 0.5;
  vec3 col = mix(vec3(0.030, 0.028, 0.034), vec3(0.105, 0.096, 0.108), smoothstep(0.0, 1.0, h));
  vec2 e = abs(uv - 0.5) * 2.0;
  col *= 1.0 - 0.35 * pow(max(e.x, e.y), 6.0);
  // Inside the sand, gaps between grains are shadow, not the box behind. Samples half a cell to
  // each side close a gap one cell wide; wider ones stay open.
  vec2 hx = vec2(0.5 * u_texel.x, 0.0), hy = vec2(0.0, 0.5 * u_texel.y);
  float occ = max(max(texture(u_occ, uv + hx).r, texture(u_occ, uv - hx).r),
                  max(texture(u_occ, uv + hy).r, texture(u_occ, uv - hy).r));
  float sand = smoothstep(0.3, 0.6, occ);
  col = mix(col, vec3(0.15, 0.11, 0.08), sand);
  o = vec4(col, 1.0);
}`;

const GRAIN_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_col;
uniform mat3 u_clip;
uniform vec2 u_box;
uniform float u_cell;
uniform vec2 u_up;
uniform float u_size;
uniform float u_glint;
uniform sampler2D u_occ;
out vec3 v_col;
out float v_glint;
float occ(vec2 p) { return texture(u_occ, p / u_box).r; }
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float id = float(gl_VertexID);
  // a fixed sub-cell offset per grain, so resting sand shows no lattice
  vec2 p = a_pos + (vec2(hash(id * 0.137 + 0.11), hash(id * 0.311 + 0.73)) - 0.5) * (0.42 * u_cell);
  vec2 up = u_up * u_cell;
  vec2 side = vec2(-u_up.y, u_up.x) * u_cell;
  float near = occ(p + up * 1.3);
  float far = (occ(p + up * 3.0) + occ(p + up * 6.0) + occ(p + up * 11.0) + occ(p + up * 18.0)) * 0.25;
  float flank = (occ(p + side * 4.0 + up * 2.0) + occ(p - side * 4.0 + up * 2.0)) * 0.5;
  float light = 1.06 + 0.20 * (1.0 - near) - 0.20 * far - 0.08 * flank;
  v_col = a_col.rgb * light;
  // a few grains (glassy facets) catch the light at their own tilt of the box
  float facet = a_col.a * 6.2832;
  v_glint = step(0.955, hash(id * 0.71 + 3.1)) * pow(max(0.0, cos(u_glint - facet)), 60.0) * (1.0 - near);
  gl_Position = vec4((u_clip * vec3(p, 1.0)).xy, 0.0, 1.0);
  gl_PointSize = u_size;
}`;

const GRAIN_FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_glint;
uniform vec2 u_lightS; // "up" in sprite coordinates (y down)
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float shade = (0.93 + 0.13 * dot(q, u_lightS)) * (1.0 - 0.22 * r2);
  vec3 col = v_col * shade + v_glint * vec3(1.0, 0.97, 0.9) * (1.0 - r2);
  o = vec4(col, 1.0);
}`;

const GLASS_FS = `#version 300 es
precision highp float;
in vec2 v_p;
uniform vec2 u_box;
uniform vec2 u_sheen; // sheen band direction, sim frame, drifts with the tilt
out vec4 o;
void main() {
  vec2 uv = v_p / u_box;
  vec2 e = abs(uv - 0.5) * 2.0;
  float rim = pow(max(e.x, e.y), 10.0);
  float s = dot((uv - 0.5) * vec2(u_box.x / u_box.y, 1.0), u_sheen);
  float sheen = exp(-pow((s - 0.12) / 0.11, 2.0)) * 0.035 + exp(-pow((s + 0.22) / 0.035, 2.0)) * 0.025;
  // premultiplied: a little white light on top, a little darkening at the rim
  o = vec4(vec3(sheen), sheen + rim * 0.28);
}`;

export class SandRenderer {
  constructor(gl, cap) {
    this.gl = gl;
    this.cap = cap;
    this.bg = compile(gl, QUAD_VS, BG_FS);
    this.glass = compile(gl, QUAD_VS, GLASS_FS);
    this.grains = compile(gl, GRAIN_VS, GRAIN_FS);
    this.quad = unitQuad(gl);
    this.pos = new Float32Array(cap * 2);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.colBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 4, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindVertexArray(null);
    this.occTex = gl.createTexture();
    this.occW = 0; this.occH = 0;
    this.occBytes = null;
    this.dirty = true; // positions or occupancy need uploading
  }

  // Grain colours changed (a refill): rgba holds 4 bytes per grain.
  setColours(rgba, n) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, rgba.subarray(0, n * 4));
    this.dirty = true;
  }

  // Upload what the sim changed (the mode sets `dirty`): positions (sim px) and the occupancy.
  update(grid) {
    if (!this.dirty) return;
    this.dirty = false;
    const gl = this.gl;
    const { n, gw, gh } = grid;
    const pos = this.pos;
    for (let i = 0; i < n; i++) { pos[2 * i] = grid.posX(i); pos[2 * i + 1] = grid.posY(i); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos.subarray(0, 2 * n));
    const cells = gw * gh;
    if (!this.occBytes || this.occBytes.length !== cells) this.occBytes = new Uint8Array(cells);
    const ob = grid.occupancy(this.occBytes);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.occW !== gw || this.occH !== gh) {
      this.occW = gw; this.occH = gh;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gw, gh, 0, gl.RED, gl.UNSIGNED_BYTE, ob);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gw, gh, gl.RED, gl.UNSIGNED_BYTE, ob);
    }
  }

  // g: the gravity the sand feels (m/s²), for the lighting; grains drawn at `grainScale` cells.
  draw(view, grid, g, grainScale) {
    const gl = this.gl;
    this.update(grid);
    gl.viewport(0, 0, view.pxW, view.pxH);
    gl.disable(gl.BLEND);
    const W = view.simW, H = view.simH;
    // "up" for the light: against in-plane gravity, or the top of the device when it lies flat
    const gl2 = Math.hypot(g.x, g.y);
    const k = Math.min(1, gl2 / 3);
    let ux = -g.x / (gl2 || 1) * k, uy = -g.y / (gl2 || 1) * k - (1 - k);
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.useProgram(this.bg.program);
    gl.uniformMatrix3fv(this.bg.u.u_clip, false, view.clipMatrix);
    gl.uniform2f(this.bg.u.u_box, W, H);
    gl.uniform2f(this.bg.u.u_up, ux, uy);
    gl.uniform1i(this.bg.u.u_occ, 0);
    gl.uniform2f(this.bg.u.u_texel, 1 / grid.gw, 1 / grid.gh);
    this.quad.draw();

    const cell = Math.max(grid.sx, grid.sy);
    const dpr = view.pxW / view.cssW;
    const m = view.m; // sim -> screen (rotation only, for vectors)
    let lx = m.a * ux + m.b * uy, ly = m.d * ux + m.e * uy;
    const ll = Math.hypot(lx, ly) || 1;
    lx /= ll; ly /= ll;
    const p = this.grains;
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.u.u_clip, false, view.clipMatrix);
    gl.uniform2f(p.u.u_box, W, H);
    gl.uniform1f(p.u.u_cell, cell);
    gl.uniform2f(p.u.u_up, ux, uy);
    gl.uniform2f(p.u.u_lightS, -lx, -ly);
    gl.uniform1f(p.u.u_size, Math.max(1, cell * grainScale * dpr));
    gl.uniform1f(p.u.u_glint, Math.atan2(g.x, g.y) * 9 + Math.atan2(g.z, gl2) * 5);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.uniform1i(p.u.u_occ, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, grid.n);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.glass.program);
    gl.uniformMatrix3fv(this.glass.u.u_clip, false, view.clipMatrix);
    gl.uniform2f(this.glass.u.u_box, W, H);
    const sa = 0.9 + 0.15 * Math.atan2(g.x, Math.hypot(g.y, g.z));
    gl.uniform2f(this.glass.u.u_sheen, Math.cos(sa), Math.sin(sa));
    this.quad.draw();
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.bg.program);
    gl.deleteProgram(this.glass.program);
    gl.deleteProgram(this.grains.program);
    this.quad.dispose();
    gl.deleteBuffer(this.posBuf);
    gl.deleteBuffer(this.colBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.occTex);
  }
}
