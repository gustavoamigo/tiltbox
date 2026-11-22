// Stand-in mode: a handful of dots under gravity, drawn with Canvas2D. It proves the shell
// (sensors, rotation, pointers, test hooks) and is replaced by each real mode.

export default function create(ctx) {
  const c2 = ctx.canvas.getContext('2d');
  const PX_PER_M = 1500;
  let W = 1, H = 1;
  const n = 40;
  const r = 14;
  const p = [];
  for (let i = 0; i < n; i++) p.push({ x: 0, y: 0, vx: 0, vy: 0 });
  let placed = false;

  return {
    resize(view) {
      W = view.simW; H = view.simH;
      if (!placed) {
        p.forEach((q, i) => { q.x = (0.1 + 0.8 * ((i * 0.618) % 1)) * W; q.y = (0.1 + 0.8 * (i / n)) * H; });
        placed = true;
      }
      for (const q of p) { q.x = Math.min(Math.max(q.x, r), W - r); q.y = Math.min(Math.max(q.y, r), H - r); }
    },
    step(dt, env) {
      const gx = env.g.x * PX_PER_M, gy = env.g.y * PX_PER_M;
      for (const q of p) {
        q.vx += gx * dt; q.vy += gy * dt;
        for (const t of env.pointers) {
          const dx = q.x - t.x, dy = q.y - t.y, d = Math.hypot(dx, dy);
          if (d < 60 && d > 0) { q.vx += (dx / d) * 4000 * dt + t.vx * 0.1; q.vy += (dy / d) * 4000 * dt + t.vy * 0.1; }
        }
        q.vx *= 0.995; q.vy *= 0.995;
        q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.x < r) { q.x = r; q.vx = -q.vx * 0.5; }
        if (q.x > W - r) { q.x = W - r; q.vx = -q.vx * 0.5; }
        if (q.y < r) { q.y = r; q.vy = -q.vy * 0.5; }
        if (q.y > H - r) { q.y = H - r; q.vy = -q.vy * 0.5; }
      }
    },
    render(view) {
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.fillStyle = '#0b1020';
      c2.fillRect(0, 0, view.pxW, view.pxH);
      view.apply2d(c2);
      // a marker in the device's top-left corner, to check the rotation by eye
      c2.fillStyle = '#ff5a5a';
      c2.fillRect(0, 0, 40, 8);
      c2.fillStyle = '#6cc4ff';
      for (const q of p) { c2.beginPath(); c2.arc(q.x, q.y, r, 0, Math.PI * 2); c2.fill(); }
      c2.fillStyle = 'rgba(255,255,255,0.5)';
      c2.font = '16px system-ui';
      c2.textAlign = 'center';
      c2.fillText(`${ctx.modeName}: coming soon`, W / 2, H / 2);
    },
    stats() {
      let nan = false, outside = 0;
      for (const q of p) {
        if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) nan = true;
        else if (q.x < 0 || q.x > W || q.y < 0 || q.y > H) outside++;
      }
      return { count: n, nan, outside };
    },
    reset() { placed = false; this.resize({ simW: W, simH: H }); },
    dispose() {},
  };
}
