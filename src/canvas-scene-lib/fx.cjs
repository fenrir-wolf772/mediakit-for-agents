// Vendored from the local-video-pipeline skill (same workspace):
// ~/workspace/custom-skills/local-video-pipeline/lib/fx.js
// Pure functions, no dependencies. Kept in sync by hand; the skill is the source of truth.
//
// NOTE: this file is CommonJS on purpose — scene modules are CJS too
// (module.exports.draw), matching the pipeline skill's contract.
// fx.js — deterministic effects helpers for Canvas scenes. Everything is a pure function of t.
//
// Usage in scene.js:
//   const fx = M.lib.fx;
//   const a = fx.fade(t, 1.0, 1.5);          // 0..1 opacity
//   const s = fx.pop(t, 2.0, 0.5);           // 0..1..overshoot scale
//   const ps = fx.particles(fx._ps || (fx._ps = fx.makeParticles({ count: 80, seed: 7 })));
//   // positions at time t: ps.at(t, W, H)

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function lerp(a, b, k) { return a + (b - a) * k; }

// deterministic PRNG (mulberry32) — same seed => same sequence, every run
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

const ease = {
  linear: k => k,
  inOut: k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2,
  out: k => 1 - Math.pow(1 - k, 3),
  in: k => k * k * k,
  outBack: k => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
};

// progress 0..1 of [t0,t1], clamped; eased with ease.out by default
function prog(t, t0, t1, e) {
  const k = clamp((t - t0) / (t1 - t0), 0, 1);
  return (e || ease.out)(k);
}
// opacity ramp: 0 before t0, 1 after t1
function fade(t, t0, t1) { return prog(t, t0, t1, ease.inOut); }
// scale with overshoot (for pop-ins): 0 before t0, settles at 1
function pop(t, t0, dur) { return prog(t, t0, t0 + dur, ease.outBack); }
// slide offset in px: dist -> 0 over [t0, t0+dur]
function slide(t, t0, dur, dist, e) { return dist * (1 - prog(t, t0, t0 + dur, e || ease.out)); }

// looping particle field. p = makeParticles({count, seed, size:[min,max], speed:[min,max],
//   x:[0,1], y:[0,1] (fractions), driftX, alpha:[min,max]})
// positions(p, t, W, H) -> [{x, y, r, a}] — deterministic for given t
function makeParticles(o) {
  const r = rng(o.seed || 1);
  const n = o.count || 60;
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      x0: (o.x ? o.x[0] + r() * (o.x[1] - o.x[0]) : r()),
      y0: (o.y ? o.y[0] + r() * (o.y[1] - o.y[0]) : r()),
      sp: (o.speed ? o.speed[0] + r() * (o.speed[1] - o.speed[0]) : 0.02 + r() * 0.05),
      ph: r() * Math.PI * 2,
      sz: (o.size ? o.size[0] + r() * (o.size[1] - o.size[0]) : 2 + r() * 5),
      al: (o.alpha ? o.alpha[0] + r() * (o.alpha[1] - o.alpha[0]) : 0.25 + r() * 0.5),
    });
  }
  return { pts, driftX: o.driftX || 0, period: o.period || 14 };
}
function positions(p, t, W, H) {
  return p.pts.map(q => {
    const y = (((q.y0 - (t * q.sp) / p.period) % 1) + 1) % 1; // rises, loops
    const x = (q.x0 + p.driftX * t + 0.02 * Math.sin(t * 0.8 + q.ph) + 1) % 1;
    return { x: x * W, y: y * H, r: q.sz, a: q.al * (0.6 + 0.4 * Math.sin(t * 2 + q.ph)) };
  });
}

// full-screen transition wipe 0..1 over [t0,t0+dur]; type 'fade'|'wipe-left'|'circle'
function transition(t, t0, dur, type) {
  const k = prog(t, t0, t0 + dur, ease.inOut);
  return { k, type: type || 'fade' };
}
function drawTransition(ctx, W, H, tr, color) {
  if (tr.k <= 0) return;
  ctx.save();
  ctx.fillStyle = color || '#000';
  if (tr.type === 'fade') {
    ctx.globalAlpha = tr.k;
    ctx.fillRect(0, 0, W, H);
  } else if (tr.type === 'wipe-left') {
    ctx.fillRect(0, 0, W * tr.k, H);
  } else if (tr.type === 'circle') {
    const r = tr.k * Math.hypot(W, H) * 0.75;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// soft glow: draws text/shape with shadowBlur, restores state
function glow(ctx, color, blur, fn) {
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}

module.exports = { clamp, lerp, rng, ease, prog, fade, pop, slide, makeParticles, positions, transition, drawTransition, glow };
