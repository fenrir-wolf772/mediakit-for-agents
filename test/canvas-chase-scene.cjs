// canvas-chase-scene.js — demo scene for assemble canvas_scene.
// Milo the orange cat chases Pip the grey mouse (cheese in paws) across a
// kitchen floor, right to left — the same beat as the 3-frame flipbook
// demo, redrawn in code at 30fps. Flat vector, warm kitchen palette
// (see cat-mouse/animated/art-direction.md).
//
// Contract (local-video-pipeline skill): module.exports.draw = async
// (ctx, t, W, H, assets, M) => {}. Frame N is a pure function of
// t = N/fps — deterministic, no Math.random, no Date.now.
// M: {duration, fps, params, lib: {camera, fx}}.

const OUTLINE = "#5A3A22";

function ellipse(ctx, x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function leg(ctx, x, y, len, ang, w) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = ctx._legColor;
  ctx.fillRect(-w / 2, 0, w, len);
  ctx.restore();
}

// Pip the mouse, facing left. s = scale (1 = ~150px tall), phase = run cycle (radians).
function drawMouse(ctx, x, y, s, phase, fx) {
  const bob = Math.sin(phase * 2) * 6 * s; // two bobs per stride
  const run = fx.prog ? 1 : 1;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.scale(s, s);
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  // tail: pink curve waving behind (to the right, since we face left)
  ctx.strokeStyle = "#E8A0A8";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(52, -6);
  ctx.quadraticCurveTo(95 + Math.sin(phase) * 10, -22 - Math.sin(phase * 1.3) * 8, 128, -2 + Math.sin(phase * 1.7) * 10);
  ctx.stroke();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;
  // body (drawn first so the legs swing visibly BELOW it)
  ctx.fillStyle = "#8A8F98";
  ellipse(ctx, 0, 0, 62, 48);
  ctx.fillStyle = "#C9CDD4";
  ellipse(ctx, -12, 14, 38, 26);
  // legs: drawn AFTER the body, from its lower edge down — the run
  // cycle is only visible if the legs are not covered by the body
  ctx.fillStyle = "#8A8F98";
  ctx._legColor = "#8A8F98";
  leg(ctx, -18, 30, 34, Math.sin(phase) * 0.7, 13);
  leg(ctx, 22, 30, 34, -Math.sin(phase) * 0.7, 13);
  ctx.fillStyle = "#6E737C";
  ellipse(ctx, -18 + Math.sin(phase) * 14, 66, 10, 6);
  ellipse(ctx, 22 - Math.sin(phase) * 14, 66, 10, 6);
  // scarf: blue band + fluttering end
  ctx.fillStyle = "#3A7BD5";
  ctx.fillRect(-52, -38, 58, 16);
  ctx.beginPath();
  ctx.moveTo(4, -36);
  ctx.quadraticCurveTo(38 + Math.sin(phase * 1.5) * 8, -48, 62 + Math.sin(phase * 1.5) * 10, -30);
  ctx.quadraticCurveTo(38, -22, 4, -24);
  ctx.fill();
  ctx.stroke();
  // head (left), big round ears
  ctx.fillStyle = "#8A8F98";
  circle(ctx, -42, -58, 30);
  circle(ctx, 6, -62, 30);
  ctx.fillStyle = "#E8A0A8";
  circle(ctx, -42, -58, 16);
  circle(ctx, 6, -62, 16);
  ctx.fillStyle = "#8A8F98";
  circle(ctx, -18, -34, 42);
  // eye + nose (facing left)
  ctx.fillStyle = "#1F2937";
  circle(ctx, -38, -42, 7);
  ctx.fillStyle = "#FFFFFF";
  circle(ctx, -40, -44, 2.5);
  ctx.fillStyle = "#D43D2A";
  circle(ctx, -58, -24, 6);
  // cheese wedge held at the chest in both front paws (not a hat)
  ctx.save();
  ctx.translate(-56, -6);
  ctx.rotate(-0.35);
  ctx.fillStyle = "#F7C948";
  ctx.beginPath();
  ctx.moveTo(-30, 22);
  ctx.lineTo(30, 22);
  ctx.lineTo(8, -22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#D9A03A";
  circle(ctx, -6, 6, 5);
  circle(ctx, 10, -2, 4);
  circle(ctx, 2, 12, 3.5);
  ctx.restore();
  // paws gripping the cheese
  ctx.fillStyle = "#8A8F98";
  circle(ctx, -52, 2, 9);
  circle(ctx, -38, -14, 9);
  ctx.restore();
  return run;
}

// Milo the cat, facing left, mid-bound. s = scale, phase = run cycle.
function drawCat(ctx, x, y, s, phase) {
  const bob = Math.abs(Math.sin(phase)) * 14 * s; // bounds: up off the floor
  ctx.save();
  ctx.translate(x, y - bob);
  ctx.scale(s, s);
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUTLINE;
  // tail up, curved
  ctx.strokeStyle = "#E8913A";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(88, -30);
  ctx.quadraticCurveTo(150, -70, 138, -130);
  ctx.stroke();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 4;
  // stripes on tail
  ctx.strokeStyle = "#C97A24";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(112, -52);
  ctx.lineTo(128, -46);
  ctx.moveTo(128, -88);
  ctx.lineTo(142, -82);
  ctx.stroke();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 4;
  // body (drawn first so the legs swing visibly BELOW it)
  ctx.fillStyle = "#E8913A";
  ellipse(ctx, 0, 0, 96, 68);
  ctx.fillStyle = "#FFF3E0";
  ellipse(ctx, -16, 26, 58, 38);
  // legs: drawn AFTER the body, from its lower edge down
  ctx.fillStyle = "#E8913A";
  ctx._legColor = "#E8913A";
  leg(ctx, -58, 44, 56, Math.sin(phase) * 0.9, 18);
  leg(ctx, 58, 44, 56, -Math.sin(phase) * 0.9 + 0.5, 18);
  leg(ctx, -30, 48, 52, -Math.sin(phase) * 0.6, 18);
  leg(ctx, 34, 48, 52, Math.sin(phase) * 0.6, 18);
  ctx.fillStyle = "#FFF3E0";
  ellipse(ctx, -58 + Math.sin(phase) * 30, 102, 13, 8);
  ellipse(ctx, 58 - Math.sin(phase) * 30, 102, 13, 8);
  ellipse(ctx, -30 - Math.sin(phase) * 20, 102, 13, 8);
  ellipse(ctx, 34 + Math.sin(phase) * 20, 102, 13, 8);
  // back stripes
  ctx.strokeStyle = "#C97A24";
  ctx.lineWidth = 6;
  for (const dx of [-40, -12, 16]) {
    ctx.beginPath();
    ctx.moveTo(dx, -58);
    ctx.quadraticCurveTo(dx + 8, -30, dx, -6);
    ctx.stroke();
  }
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 4;
  // head (left): ears tilted back, green eyes, pink nose
  ctx.fillStyle = "#E8913A";
  ctx.beginPath();
  ctx.moveTo(-118, -78);
  ctx.lineTo(-96, -128);
  ctx.lineTo(-72, -86);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-72, -84);
  ctx.lineTo(-50, -130);
  ctx.lineTo(-30, -88);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  circle(ctx, -74, -52, 58);
  // eyes (wide, excited)
  ctx.fillStyle = "#FFFFFF";
  circle(ctx, -96, -64, 13);
  circle(ctx, -58, -64, 13);
  ctx.fillStyle = "#3E7C4F";
  circle(ctx, -98, -62, 7);
  circle(ctx, -60, -62, 7);
  ctx.fillStyle = "#1F2937";
  circle(ctx, -98, -62, 3.5);
  circle(ctx, -60, -62, 3.5);
  // nose + mouth (open, excited)
  ctx.fillStyle = "#D43D2A";
  ctx.beginPath();
  ctx.moveTo(-128, -34);
  ctx.lineTo(-112, -34);
  ctx.lineTo(-120, -24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#7C2D12";
  ctx.beginPath();
  ctx.ellipse(-112, -16, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  // whiskers
  ctx.strokeStyle = "#5A3A22";
  ctx.lineWidth = 2;
  for (const [y0, y1] of [[-46, -50], [-38, -38], [-30, -26]]) {
    ctx.beginPath();
    ctx.moveTo(-126, y0);
    ctx.lineTo(-158, y1);
    ctx.stroke();
  }
  // red collar + gold bell
  ctx.strokeStyle = "#D43D2A";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(-122, -8);
  ctx.quadraticCurveTo(-74, 6, -28, -6);
  ctx.stroke();
  ctx.fillStyle = "#F7C948";
  circle(ctx, -74, 10, 11);
  ctx.fillStyle = "#D9A03A";
  ctx.fillRect(-77, 8, 6, 4);
  ctx.restore();
}

// Dust puff: born at (x0, y0) at t0, expands and fades over 0.5s.
function dustPuff(ctx, x0, y0, t0, t, r0) {
  const k = (t - t0) / 0.5;
  if (k < 0 || k > 1) return;
  ctx.save();
  ctx.globalAlpha = 0.6 * (1 - k);
  ctx.fillStyle = "#EFD9A7";
  ctx.beginPath();
  ctx.arc(x0, y0 - k * 18, r0 * (0.6 + k), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

module.exports.draw = async (ctx, t, W, H, assets, M) => {
  const fx = M.lib.fx;
  const cam = M.lib.camera;
  const floorY = H * 0.28; // wall/floor boundary
  // Runners' ground line — above the burned-caption band (~0.69H),
  // so the characters are never hidden behind the subtitle.
  const runY = H * 0.60;

  // --- background: cream wall + wood floor planks ---
  ctx.fillStyle = "#F6E3C1";
  ctx.fillRect(0, 0, W, floorY);
  ctx.fillStyle = "#E8CFA8";
  ctx.fillRect(0, floorY - H * 0.012, W, H * 0.012); // skirting
  ctx.fillStyle = "#D9A066";
  ctx.fillRect(0, floorY, W, H - floorY);
  ctx.strokeStyle = "#C98F52";
  ctx.lineWidth = 3;
  for (let i = 1; i <= 5; i++) {
    const y = floorY + ((H - floorY) * i) / 6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  // fallen spoon, bottom-left (like the AI frames)
  ctx.save();
  ctx.translate(W * 0.1, H * 0.88);
  ctx.rotate(0.7);
  ctx.fillStyle = "#9AA0A6";
  ctx.beginPath();
  ctx.ellipse(0, 0, 16, 44, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-5, 34, 10, 90);
  ctx.restore();
  // cheese crumbs
  ctx.fillStyle = "#F7C948";
  const crumbRng = fx.rng(11);
  for (let i = 0; i < 14; i++) {
    const cx = crumbRng() * W;
    const cy = floorY + crumbRng() * (H - floorY);
    ctx.beginPath();
    ctx.arc(cx, cy, 4 + crumbRng() * 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- camera: slow push-in over the whole shot ---
  const shots = [cam.shot({ t0: 0, t1: M.duration, from: [0.5, 0.55], to: [0.5, 0.55], zoom: [1.0, 1.06] })];
  const tr = cam.at(shots, t);
  ctx.save();
  cam.apply(ctx, W, H, tr);

  // --- the run: 0-0.5s anticipation, 0.5-3.475s chase, then end hold ---
  const p = fx.prog(t, 0.5, 3.475, fx.ease.linear);
  const phase = t * Math.PI * 2 * 2.4; // ~2.4 strides/second
  // Gap between the runners shrinks as the cat gains: 0.17W at the
  // start, 0.14W at the end — the cat's nose nearly reaches the
  // mouse's tail, the flipbook's frame-3 beat.
  const mouseX = W * (0.80 - 0.52 * p);
  const catX = W * (0.97 - 0.53 * p);
  const speed = p > 0 && p < 1 ? 1 : 0;

  // motion lines behind the runners (only while running)
  if (speed) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "#FFF3E0";
    ctx.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      const ly = runY - 140 + i * 70;
      const lx = mouseX + 180 + i * 40;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + 150 + Math.sin(t * 9 + i) * 20, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  // dust puffs at footfalls: one every ~0.42s of the run, at the
  // runner's position then. Deterministic: birth time and place are
  // pure functions of t.
  for (let k = 0; k < 8; k++) {
    const tb = 0.5 + k * 0.42;
    const pk = fx.prog(tb, 0.5, 3.475, fx.ease.linear);
    dustPuff(ctx, W * (0.80 - 0.52 * pk) + 30, runY + 55, tb, t, 26);
    dustPuff(ctx, W * (0.97 - 0.53 * pk) - 40, runY + 65, tb + 0.21, t, 30);
  }

  // Cat first, mouse after: the mouse is the protagonist and must
  // never be hidden behind the cat when the gap closes.
  drawCat(ctx, catX, runY - 10, 1.05, phase + 0.9);
  drawMouse(ctx, mouseX, runY, 1.05, phase, fx);
  ctx.restore();
};
