// rings.cjs — built-in assemble scene template.
// Concentric rings expand from the center and fade out, one after
// another — a calm pulse for intros and outros. Deterministic:
// frame N is a pure function of t.
// Params: color, bg, count (rings in flight), speed (cycles/sec).
module.exports.draw = async (ctx, t, W, H, assets, M) => {
  const p = M.params;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  const maxR = Math.hypot(W, H) / 2;
  const cx = W / 2;
  const cy = H / 2;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = Math.max(2, Math.min(W, H) * 0.008);
  for (let i = 0; i < p.count; i++) {
    const phase = (t * p.speed + i / p.count) % 1;
    ctx.save();
    ctx.globalAlpha = 0.9 * (1 - phase);
    ctx.beginPath();
    ctx.arc(cx, cy, phase * maxR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // Center dot, always on.
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(W, H) * 0.02, 0, Math.PI * 2);
  ctx.fill();
};
