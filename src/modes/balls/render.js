// WebGL2 renderer for the ball modes. Per frame:
//   1. the back panel of the box into an offscreen target in sim orientation (reduced
//      resolution where it does not show), then the balls' shadows multiplied onto it and, for
//      glass, the light each marble focuses onto it (caustics);
//   2. that panel onto the screen through view.clipMatrix;
//   3. the balls: one instanced quad each, a sphere impostor in the fragment shader. Glass
//      refracts the panel texture (so a marble shows the shadows and caustics behind it).
// Per-instance data: position and radius, orientation quaternion (dynamic, 28 bytes), and the
// ball's look (static, 16 bytes: three colours and pattern parameters).

import { compile, makeTarget, unitQuad } from '../../gl.js';
import { VS_BALL, VS_SHADOW, VS_BOX, FS_BG, FS_SHADOW, FS_COMPOSITE, FS_MARBLE, FS_RUBBER } from './shaders.js';

const FLOATS = 7; // x, y, r, qx, qy, qz, qw

export class BallRenderer {
  // look: preset.render (colours of the panel, which ball shader); looks: Uint8Array n*16
  constructor(gl, look, looks, n, bgScale) {
    this.gl = gl;
    this.look = look;
    this.looks = looks;
    this.n = n;
    this.bgScale = bgScale;
    this.inst = new Float32Array(n * FLOATS);
    this.fbo = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); // sim -> offscreen clip
    this.bg = null;
    this.bgW = 0; this.bgH = 0;
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.pBg = compile(gl, VS_BOX, FS_BG);
    this.pComp = compile(gl, VS_BOX, FS_COMPOSITE);
    this.pShadow = compile(gl, VS_SHADOW, FS_SHADOW);
    this.pBall = compile(gl, VS_BALL, this.look.glass ? FS_MARBLE : FS_RUBBER);
    this.quad = unitQuad(gl);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FLOATS * 4, 12);
    gl.vertexAttribDivisor(2, 1);
    this.lookBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lookBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.looks, gl.STATIC_DRAW);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(3 + k);
      gl.vertexAttribPointer(3 + k, 4, gl.UNSIGNED_BYTE, true, 16, k * 4);
      gl.vertexAttribDivisor(3 + k, 1);
    }
    gl.bindVertexArray(null);
    this.bgW = 0; // force the target to be made at the next render
  }

  // After a lost context comes back: everything is gone, make it again.
  restore() {
    this.bg = null;
    this._init();
  }

  _target(view) {
    const gl = this.gl;
    const w = Math.max(16, Math.round(view.simW * this.bgScale));
    const h = Math.max(16, Math.round(view.simH * this.bgScale));
    // sim (x, y) -> clip of the target, unflipped: texel (u, v) holds sim point (u·simW, v·simH)
    this.fbo[0] = 2 / view.simW; this.fbo[4] = 2 / view.simH; this.fbo[6] = -1; this.fbo[7] = -1;
    if (this.bg && w === this.bgW && h === this.bgH) return;
    if (this.bg) this.bg.dispose();
    this.bg = makeTarget(gl, w, h, { float: false });
    this.bgW = w; this.bgH = h;
  }

  // world: BallWorld; L: unit vector toward the light, sim frame (z < 0: in front)
  render(view, world, L) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this._target(view);
    const n = this.n, inst = this.inst, q = world.q;
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS;
      inst[o] = world.x[i]; inst[o + 1] = world.y[i]; inst[o + 2] = world.r[i];
      inst[o + 3] = q[i * 4]; inst[o + 4] = q[i * 4 + 1]; inst[o + 5] = q[i * 4 + 2]; inst[o + 6] = q[i * 4 + 3];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst);
    const look = this.look;

    // 1. the panel and what falls on it
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bg.fbo);
    gl.viewport(0, 0, this.bgW, this.bgH);
    gl.disable(gl.BLEND);
    let p = this.pBg;
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.u.uClip, false, this.fbo);
    gl.uniform2f(p.u.uSim, view.simW, view.simH);
    gl.uniform3f(p.u.uL, L[0], L[1], L[2]);
    gl.uniform3fv(p.u.uBgLit, look.bgLit);
    gl.uniform3fv(p.u.uBgFar, look.bgFar);
    gl.uniform1f(p.u.uGrain, look.grain);
    gl.uniform1f(p.u.uWeave, this.bgScale >= 0.75 ? look.weave : 0); // too fine for a coarse target
    this.quad.draw();

    gl.enable(gl.BLEND);
    p = this.pShadow;
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.u.uClip, false, this.fbo);
    gl.uniform3f(p.u.uL, L[0], L[1], L[2]);
    gl.uniform1f(p.u.uAllOpaque, look.glass ? 0 : 1);
    gl.uniform1f(p.u.uShadow, look.shadow);
    gl.bindVertexArray(this.vao);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO); // multiply
    gl.uniform1i(p.u.uPass, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    if (look.glass) {
      gl.blendFunc(gl.ONE, gl.ONE); // light focused by the glass
      gl.uniform1i(p.u.uPass, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    }

    // 2. the panel onto the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, view.pxW, view.pxH);
    gl.disable(gl.BLEND);
    p = this.pComp;
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.u.uClip, false, view.clipMatrix);
    gl.uniform2f(p.u.uSim, view.simW, view.simH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
    gl.uniform1i(p.u.uBg, 0);
    this.quad.draw();

    // 3. the balls (premultiplied alpha: the edge is antialiased in the shader)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    p = this.pBall;
    gl.useProgram(p.program);
    gl.uniformMatrix3fv(p.u.uClip, false, view.clipMatrix);
    gl.uniform1f(p.u.uDpr, view.dpr);
    gl.uniform3f(p.u.uL, L[0], L[1], L[2]);
    if (p.u.uBg) { gl.uniform1i(p.u.uBg, 0); gl.uniform2f(p.u.uSim, view.simW, view.simH); }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    if (this.bg) this.bg.dispose();
    this.quad.dispose();
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.lookBuf);
    gl.deleteVertexArray(this.vao);
    for (const p of [this.pBg, this.pComp, this.pShadow, this.pBall]) gl.deleteProgram(p.program);
  }
}
