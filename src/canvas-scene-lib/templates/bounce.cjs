// bounce.cjs — built-in assemble scene template.
// A ball bouncing on a floor line: pure gravity parabolas, squash
// on impact, a shadow that shrinks as the ball rises. Deterministic:
// frame N is a pure function of t.
// Params: color, bg, radius (fraction of min(W,H)), bounces.
module.exports.draw = async (ctx, t, W, H, assets, M) => {
  const p = M.params;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  const r = p.radius * Math.min(W, H);
  // Floor at 0.62H, apex at 0.12H: the whole bounce stays above
  // the burned-caption band (~0.69H), so the ball is never hidden
  // behind subtitles — same rule as the chase scene's run line.
  const floorY = H * 0.62;
  const restY = floorY - r; // ball center at rest (touching floor)
  const apexY = H * 0.12;
  const cycle = M.duration / p.bounces;
  const phase = (t % cycle) / cycle; // 0..1 within one bounce
  // Parabola: 0 at the cycle ends (floor), 1 at mid-cycle (apex).
  const h = 4 * phase * (1 - phase);
  const y = restY - h * (restY - apexY);
  // Squash near impact: within 6% of the cycle ends.
  const d = Math.min(phase, 1 - phase);
  const squash = d < 0.06 ? 1 - 0.3 * (1 - d / 0.06) : 1;
  const cx = W / 2;
  // Floor line.
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = Math.max(2, H * 0.004);
  ctx.beginPath();
  ctx.moveTo(0, floorY);
  ctx.lineTo(W, floorY);
  ctx.stroke();
  // Shadow: wide + dark at the floor, narrow + faint at the apex.
  ctx.save();
  ctx.globalAlpha = 0.35 * (1 - h * 0.7);
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.ellipse(cx, floorY + r * 0.25, r * (1.1 - h * 0.35), r * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Ball (wider while squashed, bottom pinned to the floor contact:
  // center sits r*(1-squash) above y so center + r*squash = floorY).
  ctx.save();
  ctx.translate(cx, y + r * (1 - squash));
  ctx.scale(2 - squash, squash);
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};
