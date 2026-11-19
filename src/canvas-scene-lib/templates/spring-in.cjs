// spring-in.cjs — built-in assemble scene template.
// A rounded card springs in from nothing: it scales up from the frame
// center with a damped harmonic oscillator (fx.spring), overshoots past
// full size, rings down and settles — a physical landing, not a fixed
// easing curve. Text fades in once the card is near full size.
// Deterministic: frame N is a pure function of t.
// Params: text, bg, card, fg, stiffness, damping, mass.

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

module.exports.draw = async (ctx, t, W, H, assets, M) => {
  const fx = M.lib.fx;
  const p = M.params;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  const cw = W * 0.8;
  const ch = H * 0.28;
  // Spring scale: 0 at t=0, overshoots past 1 (~1.13 with defaults),
  // settled at 1 by ~0.9s. Clamp the draw scale at >= 0 so the card
  // never flips inside-out on the first frames.
  const s = Math.max(0, fx.spring(t, 0, { mass: p.mass, stiffness: p.stiffness, damping: p.damping }));
  if (s <= 0) return;
  const w = cw * s;
  const h = ch * s;
  const x = (W - w) / 2;
  const y = (H - h) / 2;
  roundRectPath(ctx, x, y, w, h, Math.min(24, h * 0.12));
  ctx.fillStyle = p.card;
  ctx.fill();
  // Text fades in 0.5-0.9s at fixed size, centered — it does not scale
  // with the card, so it never wobbles while the spring rings.
  const tk = fx.prog(t, 0.5, 0.9, fx.ease.out);
  if (tk <= 0) return;
  ctx.save();
  ctx.globalAlpha = tk;
  ctx.fillStyle = p.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let fs = Math.round(ch * 0.4);
  ctx.font = `bold ${fs}px sans-serif`;
  while (fs > 12 && ctx.measureText(p.text).width > cw * 0.86) {
    fs = Math.round(fs * 0.9);
    ctx.font = `bold ${fs}px sans-serif`;
  }
  ctx.fillText(p.text, W / 2, H / 2);
  ctx.restore();
};
