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

// Bounce-out core as a hoisted function: easeInBounce / easeInOutBounce
// call it by name, so the ease table below stays a plain object.
function easeOutBounceFn(k) { const n1 = 7.5625, d1 = 2.75; if (k < 1 / d1) return n1 * k * k; if (k < 2 / d1) return n1 * (k - 1.5 / d1) * (k - 1.5 / d1) + 0.75; if (k < 2.5 / d1) return n1 * (k - 2.25 / d1) * (k - 2.25 / d1) + 0.9375; return n1 * (k - 2.625 / d1) * (k - 2.625 / d1) + 0.984375; }

const ease = {
  // Legacy short names — kept byte-identical so old scenes do not move:
  // linear, in (= easeInCubic), out (= easeOutCubic),
  // inOut (= easeInOutQuad), outBack (= easeOutBack).
  linear: k => k,
  inOut: k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2,
  out: k => 1 - Math.pow(1 - k, 3),
  in: k => k * k * k,
  outBack: k => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
  // Full easings.net set (10 families x in/out/inOut). Every function maps
  // 0 -> 0 and 1 -> 1 (back/elastic/bounce overshoot in between, by design).
  // Names match the `ease` param enum of the slide-in template.
  easeInSine: k => 1 - Math.cos((k * Math.PI) / 2),
  easeOutSine: k => Math.sin((k * Math.PI) / 2),
  easeInOutSine: k => -(Math.cos(Math.PI * k) - 1) / 2,
  easeInQuad: k => k * k,
  easeOutQuad: k => 1 - (1 - k) * (1 - k),
  easeInOutQuad: k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2,
  easeInCubic: k => k * k * k,
  easeOutCubic: k => 1 - Math.pow(1 - k, 3),
  easeInOutCubic: k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2,
  easeInQuart: k => k * k * k * k,
  easeOutQuart: k => 1 - Math.pow(1 - k, 4),
  easeInOutQuart: k => k < 0.5 ? 8 * k * k * k * k : 1 - Math.pow(-2 * k + 2, 4) / 2,
  easeInQuint: k => k * k * k * k * k,
  easeOutQuint: k => 1 - Math.pow(1 - k, 5),
  easeInOutQuint: k => k < 0.5 ? 16 * k * k * k * k * k : 1 - Math.pow(-2 * k + 2, 5) / 2,
  easeInExpo: k => k === 0 ? 0 : Math.pow(2, 10 * k - 10),
  easeOutExpo: k => k === 1 ? 1 : 1 - Math.pow(2, -10 * k),
  easeInOutExpo: k => k === 0 ? 0 : k === 1 ? 1 : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2,
  easeInCirc: k => 1 - Math.sqrt(1 - Math.pow(k, 2)),
  easeOutCirc: k => Math.sqrt(1 - Math.pow(k - 1, 2)),
  easeInOutCirc: k => k < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * k, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * k + 2, 2)) + 1) / 2,
  easeInBack: k => { const c1 = 1.70158, c3 = c1 + 1; return c3 * k * k * k - c1 * k * k; },
  easeOutBack: k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
  easeInOutBack: k => { const c1 = 1.70158, c2 = c1 * 1.525; return k < 0.5 ? (Math.pow(2 * k, 2) * ((c2 + 1) * 2 * k - c2)) / 2 : (Math.pow(2 * k - 2, 2) * ((c2 + 1) * (2 * k - 2) + c2) + 2) / 2; },
  easeInElastic: k => { const c4 = (2 * Math.PI) / 3; return k === 0 ? 0 : k === 1 ? 1 : -Math.pow(2, 10 * k - 10) * Math.sin((k * 10 - 10.75) * c4); },
  easeOutElastic: k => { const c4 = (2 * Math.PI) / 3; return k === 0 ? 0 : k === 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * c4) + 1; },
  easeInOutElastic: k => { const c4 = (2 * Math.PI) / 3; return k === 0 ? 0 : k === 1 ? 1 : k < 0.5 ? -(Math.pow(2, 20 * k - 10) * Math.sin((20 * k - 11.125) * c4)) / 2 : (Math.pow(2, -20 * k + 10) * Math.sin((20 * k - 11.125) * c4)) / 2 + 1; },
  easeInBounce: k => 1 - easeOutBounceFn(1 - k),
  easeOutBounce: easeOutBounceFn,
  easeInOutBounce: k => k < 0.5 ? (1 - easeOutBounceFn(1 - 2 * k)) / 2 : (1 + easeOutBounceFn(2 * k - 1)) / 2,
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

// Physical spring: a damped harmonic oscillator settling 0 -> 1.
// opts {mass=1, stiffness=120, damping=12} — the Revideo-style spring
// config (mass/stiffness/damping), evaluated in seconds, not frames,
// so the same scene settles the same way at any fps. Returns 0 before
// t0; underdamped (damping < 2*sqrt(stiffness*mass)) it overshoots past
// 1 and rings down to 1; critically/overdamped it creeps to 1 with no
// overshoot. Pure function of t — deterministic per frame.
function springValue(dt, o) {
  const mass = o?.mass ?? 1;
  const stiffness = o?.stiffness ?? 120;
  const damping = o?.damping ?? 12;
  if (![mass, stiffness, damping].every(Number.isFinite)) throw new RangeError("spring mass/stiffness/damping must be finite numbers");
  if (mass <= 0) throw new RangeError(`spring mass must be > 0, got: ${mass}`);
  if (stiffness <= 0) throw new RangeError(`spring stiffness must be > 0, got: ${stiffness}`);
  if (damping < 0) throw new RangeError(`spring damping must be >= 0, got: ${damping}`);
  if (dt <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * dt) * (Math.cos(wd * dt) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * dt));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * dt) * (1 + w0 * dt);
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s, r2 = -zeta * w0 - s;
  return 1 - (r2 * Math.exp(r1 * dt) - r1 * Math.exp(r2 * dt)) / (r2 - r1);
}
function spring(t, t0, opts) { return springValue(t - t0, opts); }
// scale with spring overshoot (for pop-ins): 0 before t0, rings to 1.
// Same spring as spring(), as a scale factor — use for cards, titles,
// anything that should land with a physical settle instead of pop()'s
// fixed outBack overshoot.
function springPop(t, t0, opts) { return spring(t, t0, opts); }

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

module.exports = { clamp, lerp, rng, ease, prog, fade, pop, slide, spring, springPop, makeParticles, positions, transition, drawTransition, glow };
