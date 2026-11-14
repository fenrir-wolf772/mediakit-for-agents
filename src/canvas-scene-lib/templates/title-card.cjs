// title-card.cjs — built-in assemble scene template.
// Big centered title over a vertical gradient, sliding up and
// fading in over the first 0.6s, with an accent bar that grows
// under the text. Deterministic: frame N is a pure function of t.
// Params: text, bg1, bg2, fg, accent.
module.exports.draw = async (ctx, t, W, H, assets, M) => {
  const fx = M.lib.fx;
  const p = M.params;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, p.bg1);
  g.addColorStop(1, p.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const k = fx.prog(t, 0, 0.6, fx.ease.out); // 0..1 slide/fade
  // Shrink the title to fit one line within 90% of the width.
  let fs = Math.round(Math.min(W, H) * 0.11);
  ctx.font = `bold ${fs}px sans-serif`;
  while (fs > 12 && ctx.measureText(p.text).width > W * 0.9) {
    fs = Math.round(fs * 0.9);
    ctx.font = `bold ${fs}px sans-serif`;
  }
  const y = H * 0.5 - (1 - k) * H * 0.06;
  ctx.save();
  ctx.globalAlpha = k;
  ctx.fillStyle = p.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(p.text, W / 2, y);
  // Accent bar grows left-to-right under the text.
  const barW = Math.min(W * 0.5, ctx.measureText(p.text).width * 0.8) * fx.prog(t, 0.2, 0.8, fx.ease.out);
  ctx.fillStyle = p.accent;
  ctx.fillRect(W / 2 - barW / 2, y + fs * 0.75, barW, Math.max(4, fs * 0.08));
  ctx.restore();
};
