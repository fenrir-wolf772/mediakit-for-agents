// slide-in.cjs — built-in assemble scene template.
// A rounded card slides in from off-screen left with an ease-out
// over 0.7s; its text fades in once the card has landed.
// Deterministic: frame N is a pure function of t.
// Params: text, bg, card, fg.

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
  const x1 = W * 0.1;
  const y1 = H * 0.5 - ch / 2;
  // Card starts fully off-screen left, lands at x1 by 0.7s.
  const k = fx.prog(t, 0, 0.7, fx.ease.out);
  const x = -cw + (x1 + cw) * k;
  roundRectPath(ctx, x, y1, cw, ch, Math.min(24, ch * 0.12));
  ctx.fillStyle = p.card;
  ctx.fill();
  // Text fades in 0.7-1.2s, centered in the card.
  const tk = fx.prog(t, 0.7, 1.2, fx.ease.inOut);
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
  ctx.fillText(p.text, x + cw / 2, H * 0.5);
  ctx.restore();
};
