// Screen-space liquid renderer. Per frame:
//   1. splat: every particle is a soft disc added into a reduced-resolution field target in the
//      sim frame (density, foam, speed). Particles near a wall are splatted again mirrored across
//      it, so the field does not thin out against the glass.
//   2. blur: a separable Gaussian on the field rounds off particle-scale bumps (two small passes).
//   3. caustics: a small light-line texture for the back glass (water only).
//   4. composite: one full-screen pass turns the field into the liquid over the back glass:
//      anti-aliased outline, depth colour from a distance field off the sim grid, refraction of
//      the back glass, a bright band under the free surface, highlights, foam.
//   5. bubbles: little rings over the liquid where it is foamy (water) or trapped air (honey).
// The composite and bubbles reach the screen through view.clipMatrix, so the picture lands
// right on a rotated screen.

import { compile, makeTarget, unitQuad } from '../../gl.js';
import {
  SPLAT_VS, SPLAT_FS, TARGET_VS, BLUR_FS, CAUSTIC_FS, COMP_VS, COMP_FS, BUBBLE_VS, BUBBLE_FS,
} from './shaders.js';

const CAUSTIC_SCALE = 0.25; // caustic texels per sim px: soft light lines need little detail
const STRIDE = 5; // floats per instance: x, y, foam, spray speed, splat weight

export class LiquidRenderer {
  // look: colours and strengths (tuning.js); opts: { texScale, maxInstances, blur (passes), caustics }
  constructor(gl, look, opts) {
    this.gl = gl;
    this.look = look;
    this.opts = opts;
    this.maxInst = opts.maxInstances;
    this.inst = new Float32Array(this.maxInst * STRIDE);
    this.instances = 0;
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.pSplat = compile(gl, SPLAT_VS, SPLAT_FS);
    this.pBlur = compile(gl, TARGET_VS, BLUR_FS);
    this.pCaustic = compile(gl, TARGET_VS, CAUSTIC_FS);
    this.pComp = compile(gl, COMP_VS, COMP_FS);
    this.pBubble = compile(gl, BUBBLE_VS, BUBBLE_FS);
    this.quad = unitQuad(gl);

    // Instanced discs: corners on attribute 0, per-particle data on attribute 1.
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
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE * 4, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    this.field = null;
    this.fieldB = null;
    this.caustic = null;
    this.depthTex = null;
    this.depthW = 0;
    this.depthH = 0;
  }

  // Context restored: every GL object is gone; rebuild.
  restore() {
    this._init();
  }

  _ensureTargets(W, H, nx, ny) {
    const gl = this.gl;
    const tw = Math.max(16, Math.round(W * this.opts.texScale));
    const th = Math.max(16, Math.round(H * this.opts.texScale));
    if (!this.field || this.field.w !== tw || this.field.h !== th) {
      if (this.field) this.field.dispose();
      if (this.fieldB) this.fieldB.dispose();
      this.field = makeTarget(gl, tw, th, { float: true, filter: gl.LINEAR });
      this.fieldB = this.opts.blur > 0 ? makeTarget(gl, tw, th, { float: true, filter: gl.LINEAR }) : null;
    }
    if (this.opts.caustics) {
      const cw = Math.max(16, Math.round(W * CAUSTIC_SCALE));
      const ch = Math.max(16, Math.round(H * CAUSTIC_SCALE));
      if (!this.caustic || this.caustic.w !== cw || this.caustic.h !== ch) {
        if (this.caustic) this.caustic.dispose();
        this.caustic = makeTarget(gl, cw, ch, { float: false, filter: gl.LINEAR });
      }
    }
    if (!this.depthTex || this.depthW !== nx || this.depthH !== ny) {
      if (this.depthTex) gl.deleteTexture(this.depthTex);
      this.depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, nx, ny, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      this.depthW = nx;
      this.depthH = ny;
    }
  }

  // Fill the instance buffer: the n particles in order (so gl_InstanceID is the particle), then
  // mirror images across the walls they are within R of. Per particle: foam (not for lone
  // droplets: that would draw bubbles in the air), the speed of lone droplets and thin spray
  // (the composite whitens those), and a splat weight. The surface sits at a high iso level,
  // where many particles add up and the outline is smooth; a lone droplet alone would never
  // reach it, so it is splatted heavier, enough to show at about its own size.
  _fillInstances(sim, R, speedRef, loneWeight) {
    const inst = this.inst;
    const max = this.maxInst;
    const { px, py, vx, vy, foam, dens, n, W, H } = sim;
    const isp = 1 / speedRef;
    const nn = Math.min(n, max);
    for (let i = 0; i < nn; i++) {
      let s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * isp;
      if (s > 1) s = 1;
      const d = dens[i];
      // 1 in the bulk, loneWeight for a droplet on its own, blended over thin sheets
      let t = (d - 0.15) / 0.35;
      t = t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
      const o = i * STRIDE;
      inst[o] = px[i]; inst[o + 1] = py[i];
      inst[o + 2] = d < 0.45 ? 0 : foam[i];
      inst[o + 3] = d < 0.45 ? s : 0;
      inst[o + 4] = loneWeight + (1 - loneWeight) * t;
    }
    let k = nn;
    for (let i = 0; i < nn && k < max; i++) {
      const x = px[i];
      const y = py[i];
      const mx = x < R ? -x : x > W - R ? 2 * W - x : NaN;
      const my = y < R ? -y : y > H - R ? 2 * H - y : NaN;
      if (mx !== mx && my !== my) continue;
      const src = i * STRIDE;
      if (mx === mx && k < max) { this._copyInst(src, k++, mx, y); }
      if (my === my && k < max) { this._copyInst(src, k++, x, my); }
      if (mx === mx && my === my && k < max) { this._copyInst(src, k++, mx, my); }
    }
    this.instances = k;
    return nn;
  }

  // Fill each finger's hole with splats on the particles' own lattice, weighted by how deep in
  // the liquid the finger is (o.fill).
  _fillFingers(obstacles, r) {
    const inst = this.inst;
    const dx = 2 * r;
    const dy = 1.7320508 * r;
    let k = this.instances;
    for (const o of obstacles) {
      if (!(o.fill > 0)) continue;
      const R2 = o.r * o.r;
      for (let row = -Math.ceil(o.r / dy); row * dy <= o.r; row++) {
        const y = o.y + row * dy;
        const off = row & 1 ? r : 0;
        for (let x = o.x - Math.ceil(o.r / dx) * dx + off; x <= o.x + o.r; x += dx) {
          const ddx = x - o.x; const ddy = y - o.y;
          if (ddx * ddx + ddy * ddy > R2 || k >= this.maxInst) continue;
          const q = k++ * STRIDE;
          inst[q] = x; inst[q + 1] = y; inst[q + 2] = 0; inst[q + 3] = 0; inst[q + 4] = o.fill;
        }
      }
    }
    this.instances = k;
  }

  _copyInst(src, k, x, y) {
    const inst = this.inst;
    const o = k * STRIDE;
    inst[o] = x; inst[o + 1] = y;
    inst[o + 2] = inst[src + 2]; inst[o + 3] = inst[src + 3]; inst[o + 4] = inst[src + 4];
  }

  _blit(prog, target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(prog.program);
    return prog.u;
  }

  // frame: { sim, splatR, thresh, bulk, loneWeight, obstacles, speedRef, up, light, time, causticT,
  //   wobble }
  render(view, frame) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const { sim } = frame;
    const W = sim.W;
    const H = sim.H;
    this._ensureTargets(W, H, sim.nx, sim.ny);
    const f = this.field;
    const R = frame.splatR;
    const nPart = this._fillInstances(sim, R, frame.speedRef, frame.loneWeight);
    this._fillFingers(frame.obstacles, sim.r);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, this.instances * STRIDE);
    gl.disable(gl.BLEND);

    // 1. splat
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
    const scale = f.half ? 1 : 1 / 16; // RGBA8: squeeze the range so dense spots do not clip early
    gl.uniform1f(u.uScale, scale);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instances);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    // 2. blur: field -> fieldB (x), fieldB -> field (y)
    gl.activeTexture(gl.TEXTURE0);
    for (let b = 0; this.fieldB && b < this.opts.blur; b++) {
      u = this._blit(this.pBlur, this.fieldB);
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.uniform1i(u.uSrc, 0);
      gl.uniform2f(u.uStep, 1 / f.w, 0);
      this.quad.draw();
      u = this._blit(this.pBlur, f);
      gl.bindTexture(gl.TEXTURE_2D, this.fieldB.tex);
      gl.uniform2f(u.uStep, 0, 1 / f.h);
      this.quad.draw();
    }

    // 3. caustics
    if (this.caustic) {
      u = this._blit(this.pCaustic, this.caustic);
      gl.uniform2f(u.uBox, W, H);
      gl.uniform1f(u.uT, frame.causticT);
      gl.uniform1f(u.uScale, this.look.caustScale);
      this.quad.draw();
    }

    // depth field from the sim grid
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sim.nx, sim.ny, gl.RED, gl.UNSIGNED_BYTE, sim.depth8);

    // 4. composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, view.pxW, view.pxH);
    gl.useProgram(this.pComp.program);
    u = this.pComp.u;
    const L = this.look;
    gl.uniformMatrix3fv(u.uM, false, view.clipMatrix);
    gl.uniform2f(u.uBox, W, H);
    gl.uniform2f(u.uTexel, 1 / f.w, 1 / f.h);
    gl.uniform1f(u.uTexPx, W / f.w);
    gl.uniform1f(u.uFieldScale, 1 / scale);
    gl.uniform1f(u.uThresh, frame.thresh);
    gl.uniform1f(u.uBulk, frame.bulk);
    gl.uniform1f(u.uDepthMax, ((16 * 255) / 256) * Math.max(sim.hx, sim.hy));
    gl.uniform1f(u.uCellPx, Math.max(sim.hx, sim.hy));
    gl.uniform1f(u.uPx, 1 / view.dpr);
    gl.uniform2f(u.uUp, frame.up.x, frame.up.y);
    gl.uniform2f(u.uLight, frame.light.x, frame.light.y);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uWobble, frame.wobble);
    gl.uniform1i(u.uPattern, L.pattern);
    gl.uniform3fv(u.uBgTop, L.bgTop);
    gl.uniform3fv(u.uBgBot, L.bgBot);
    gl.uniform3fv(u.uTileA, L.tileA);
    gl.uniform3fv(u.uTileB, L.tileB);
    gl.uniform3fv(u.uGroutCol, L.grout);
    gl.uniform1f(u.uTileSize, L.tileSize);
    gl.uniform3fv(u.uWetGain, L.wetGain);
    gl.uniform3fv(u.uAbsorb, L.absorb);
    gl.uniform3fv(u.uShallow, L.shallow);
    gl.uniform3fv(u.uDeep, L.deep);
    gl.uniform1f(u.uDeepPx, L.deepPx);
    gl.uniform3fv(u.uRimCol, L.rimCol);
    gl.uniform1f(u.uRim, L.rim);
    gl.uniform1f(u.uRimW, L.rimW);
    gl.uniform1f(u.uMirror, L.mirror);
    gl.uniform3fv(u.uSpecCol, L.specCol);
    gl.uniform1f(u.uSpec, L.spec);
    gl.uniform1f(u.uShine, L.shine);
    gl.uniform1f(u.uLens, L.lens);
    gl.uniform1f(u.uBulge, L.bulge);
    gl.uniform3fv(u.uFoamCol, L.foamCol);
    gl.uniform1f(u.uFoam, L.foam);
    gl.uniform1f(u.uSpray, L.spray);
    gl.uniform1f(u.uCaust, this.caustic ? L.caust : 0);
    gl.uniform3fv(u.uCaustCol, L.caustCol);
    gl.uniform1f(u.uRays, L.rays);
    gl.uniform1f(u.uBubbleHole, L.bubbleHole);
    gl.uniform1f(u.uGlow, L.glow);
    gl.uniform3fv(u.uGlowCol, L.glowCol);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.uniform1i(u.uField, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(u.uDepth, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.caustic ? this.caustic.tex : this.depthTex);
    gl.uniform1i(u.uCaustic, 2);
    this.quad.draw();

    // 5. bubbles, premultiplied over the composite
    const B = L.bubbles;
    if (B) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pBubble.program);
      u = this.pBubble.u;
      gl.uniformMatrix3fv(u.uM, false, view.clipMatrix);
      gl.uniform1f(u.uSize, B.size * sim.r);
      gl.uniform1f(u.uMode, B.every > 0 ? 1 : 0);
      gl.uniform1f(u.uEvery, B.every || 1);
      gl.uniform1f(u.uTime, frame.time);
      gl.uniform3fv(u.uRing, B.ring);
      gl.uniform3fv(u.uFill, B.fill);
      gl.uniform1f(u.uEdge, Math.min(0.5, 1.5 / (view.dpr * B.size * sim.r)));
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPart);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    for (const t of [this.field, this.fieldB, this.caustic]) if (t) t.dispose();
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    this.quad.dispose();
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteVertexArray(this.vao);
    for (const p of [this.pSplat, this.pBlur, this.pCaustic, this.pComp, this.pBubble]) gl.deleteProgram(p.program);
  }
}
