// Vendored from the local-video-pipeline skill (same workspace):
// ~/workspace/custom-skills/local-video-pipeline/lib/camera.js
// Pure functions, no dependencies. Kept in sync by hand; the skill is the source of truth.
//
// NOTE: this file is CommonJS on purpose — scene modules are CJS too
// (module.exports.draw), matching the pipeline skill's contract.
// camera.js — virtual 2D camera for Canvas scenes. Pure functions of t (deterministic).
//
// A shot frames the world: center (cx, cy) as fractions of W/H (0.5,0.5 = frame center),
// zoom z (1 = whole frame visible). Camera moves are eased interpolations between shots.
//
// Usage in scene.js:
//   const cam = M.lib.camera;
//   const shots = [
//     cam.shot({ t0: 0, t1: 3, from: [0.5, 0.55], to: [0.35, 0.5], zoom: [1.0, 1.25] }),
//     cam.shot({ t0: 3, t1: 6, from: [0.35, 0.5], to: [0.35, 0.5], zoom: [1.25, 1.25],
//                shake: { amp: 0.004, freq: 9 } }),
//   ];
//   const tr = cam.at(shots, t);
//   ctx.save(); cam.apply(ctx, W, H, tr);
//   ... draw world ...
//   ctx.restore();
//   ... draw HUD / subtitles in screen space ...

const EASE = {
  linear: k => k,
  inOut: k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2,
  out: k => 1 - Math.pow(1 - k, 3),
  in: k => k * k * k,
};

function shot(o) {
  return {
    t0: o.t0, t1: o.t1,
    from: o.from || [0.5, 0.5],
    to: o.to || o.from || [0.5, 0.5],
    zoom: o.zoom || [1, 1],
    ease: EASE[o.ease] || EASE.inOut,
    shake: o.shake || null, // {amp (fraction of W), freq (Hz)}
  };
}

// interpolate camera transform at time t across a shot list (holds first/last outside range)
function at(shots, t) {
  let s = shots[0];
  if (t <= shots[0].t0) {
    return base(shots[0], 0);
  }
  const last = shots[shots.length - 1];
  if (t >= last.t1) {
    return base(last, 1);
  }
  for (const cand of shots) {
    if (t >= cand.t0 && t < cand.t1) { s = cand; break; }
  }
  const k = s.ease(Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))));
  return base(s, k, t);
}

function base(s, k, t) {
  const cx = s.from[0] + (s.to[0] - s.from[0]) * k;
  const cy = s.from[1] + (s.to[1] - s.from[1]) * k;
  const z = s.zoom[0] + (s.zoom[1] - s.zoom[0]) * k;
  let sx = 0, sy = 0;
  if (s.shake && t !== undefined) {
    // deterministic handheld shake; ramps in/out at shot edges
    const edge = Math.min(1, (t - s.t0) / 0.3, (s.t1 - t) / 0.3);
    const a = Math.max(0, edge) * s.shake.amp;
    sx = a * Math.sin(t * s.shake.freq * Math.PI * 2);
    sy = a * 0.7 * Math.sin(t * s.shake.freq * 1.37 * Math.PI * 2 + 1.3);
  }
  return { cx: cx + sx, cy: cy + sy, z };
}

// apply transform: camera looks at (cx,cy) [fractions] with zoom z
function apply(ctx, W, H, tr) {
  ctx.translate(W / 2, H / 2);
  ctx.scale(tr.z, tr.z);
  ctx.translate(-tr.cx * W, -tr.cy * H);
}

module.exports = { shot, at, apply, EASE };
