import { buildAtlas, hash2, TUNIC_COUNT } from "./sprites.js";
import { Animator } from "./animator.js";

const GROUND = { ".": ["#8fbf5a", "#8bba56", "#94c35f"], ",": ["#4c8a3a", "#478435", "#518f3f"] };
const GROUND_ITEMS = new Set(["fire", "stick", "spear", "raw_meat", "cooked_meat"]);

let atlas = null;
const animator = new Animator();
let frameCount = 0;

// Camera: (x, y) is the world point (in tile units) at the canvas centre; zoom is pixels per tile.
export const MIN_ZOOM = 4, MAX_ZOOM = 80;

export function worldToScreen(cam, w, h, wx, wy) {
  return [(wx - cam.x) * cam.zoom + w / 2, (wy - cam.y) * cam.zoom + h / 2];
}
export function screenToWorld(cam, w, h, sx, sy) {
  return [(sx - w / 2) / cam.zoom + cam.x, (sy - h / 2) / cam.zoom + cam.y];
}

// Zoom keeping the world point under screen (sx, sy) fixed.
export function zoomAt(cam, w, h, sx, sy, factor) {
  const [wx, wy] = screenToWorld(cam, w, h, sx, sy);
  cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  cam.x = wx - (sx - w / 2) / cam.zoom;
  cam.y = wy - (sy - h / 2) / cam.zoom;
}

// Where to draw an entity: between where it was before the latest tick and where it is now.
// interp = { prev: Map(id -> [x, y]), alpha in [0,1] }. Purely visual; never touches the sim.
export function interpPos(e, interp) {
  const p = interp && interp.prev.get(e.id);
  return p ? [p[0] + (e.x - p[0]) * interp.alpha, p[1] + (e.y - p[1]) * interp.alpha] : [e.x, e.y];
}

// Two ways to draw:
//  - god's-eye (observer mode / reveal): everything, straight from the sim.
//  - a character's view (opts.memory given): terrain is what the character sees right now
//    (opts.viewObs, its current observation) plus what it remembers (opts.memory); tiles it has
//    never seen stay blank, and only creatures/items it currently sees are drawn. viewObs is
//    null when the character is dead: then only the remembered map is shown.
// opts.time (ms) drives animation; opts.playerId marks the human player's character.
export function draw(ctx, sim, cam, w, h, opts = {}) {
  const A = (atlas ??= buildAtlas());
  const time = opts.time ?? 0;
  const obs = opts.viewObs, memory = opts.memory;
  const z = cam.zoom, s = z / 16; // s = screen pixels per sprite pixel
  const { width, height } = sim.world;
  ctx.imageSmoothingEnabled = s < 1; // crisp pixels when magnified, smooth when shrunk
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, w, h);

  // Only the tiles on screen.
  const [wx0, wy0] = screenToWorld(cam, w, h, 0, 0);
  const [wx1, wy1] = screenToWorld(cam, w, h, w, h);
  const x0 = Math.max(0, Math.floor(wx0)), x1 = Math.min(width - 1, Math.floor(wx1));
  const y0 = Math.max(0, Math.floor(wy0)), y1 = Math.min(height - 1, Math.floor(wy1));
  const pos = (x, y) => worldToScreen(cam, w, h, x, y);
  const blit = (img, cx, cy, ax, ay) => ctx.drawImage(img, cx - ax * s, cy - ay * s, img.width * s, img.height * s);

  // ---- 1. ground ----
  const trees = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let c, live = true; // c: tile state char; live: seen right now (vs remembered)
      if (!memory) {
        const i = y * width + x;
        c = sim.world.treeAt[i] ? "T" : sim.world.terrain[i] === 1 ? "," : ".";
      } else {
        const oc = obs?.view.tiles[y - obs.view.y0]?.[x - obs.view.x0];
        if (oc && oc !== "?" && oc !== "#") c = oc;
        else {
          live = false;
          c = memory.get(x, y)?.c ?? null;
        }
      }
      if (c == null) continue; // never seen: leave blank
      const [sx, sy] = pos(x, y);
      const hh = hash2(x, y);
      const ground = c === "." ? "." : ",";
      ctx.fillStyle = GROUND[ground][hh % 3];
      // +1 overlap avoids hairline seams between tiles at fractional zooms.
      ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(z) + 1, Math.ceil(z) + 1);
      if (z >= 10) { // ground detail
        if (c === "." && hh % 5 === 0) blit(A.tuft, sx + ((hh >> 8) % 10) * z / 12 + 0.1 * z, sy + ((hh >> 12) % 8) * z / 12 + 0.2 * z, 0, 0);
        else if (c !== "." && hh % 4 === 0) blit(A.leaves, sx + ((hh >> 8) % 10) * z / 12 + 0.1 * z, sy + ((hh >> 12) % 8) * z / 12 + 0.2 * z, 0, 0);
      }
      if (!live) { // remembered, not currently in view
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(z) + 1, Math.ceil(z) + 1);
      }
      if (c === "T") trees.push({ x, y, live });
    }
  }

  // ---- what to draw besides terrain ----
  const holds = new Map(); // god's-eye only: holder id -> kinds carried
  let things;
  if (memory) {
    things = obs ? [{ ...obs.self, kind: "human", lastResult: obs.lastResult, holdsKinds: obs.self.inventory.map((i) => i.kind) }, ...obs.view.entities] : [];
  } else {
    things = [];
    for (const e of sim.entities) {
      if (e.removed) continue;
      if (e.holder != null) {
        if (!holds.has(e.holder)) holds.set(e.holder, []);
        holds.get(e.holder).push(e.kind);
      } else things.push(e);
    }
  }
  const heldKinds = (e) => e.holdsKinds ?? holds.get(e.id) ?? [];

  const creatures = [];
  const inView = (e, ix, iy) => ix >= x0 - 1 && ix <= x1 + 2 && iy >= y0 - 1 && iy <= y1 + 2;

  // ---- 2. items and fires on the ground ----
  for (const e of things) {
    if (!GROUND_ITEMS.has(e.kind)) continue;
    const [ix, iy] = interpPos(e, opts.interp);
    if (!inView(e, ix, iy)) continue;
    const [sx, sy] = pos(ix, iy);
    if (e.kind === "fire") {
      const fi = Math.floor(time / 110 + e.id) % 3;
      if (e.lit) {
        const r = z * (1.5 + 0.12 * Math.sin(time / 130 + e.id));
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        g.addColorStop(0, "rgba(255,170,60,0.38)");
        g.addColorStop(1, "rgba(255,170,60,0)");
        ctx.fillStyle = g;
        ctx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
        blit(A.fireLit[fi], sx, sy + 0.3 * z, 6, 14);
      } else blit(A.fireOut[fi % 2], sx, sy + 0.3 * z, 6, 14);
    } else {
      const img = { stick: A.stick, spear: A.spear, raw_meat: A.rawMeat, cooked_meat: A.cookedMeat }[e.kind];
      blit(img, sx, sy, img.width / 2, img.height / 2);
    }
  }

  // ---- 3. trees and creatures, sorted by depth so things walk behind trees ----
  const drawables = [];
  for (const t of trees) {
    drawables.push({ key: t.y + 0.95, fn: () => {
      const [bx, by] = pos(t.x + 0.5, t.y + 1);
      const sway = z >= 8 ? Math.sin(time / 900 + (hash2(t.x, t.y) % 100)) * 0.035 * z : 0;
      const v = hash2(t.x, t.y, 3) % A.canopy.length;
      blit(t.live ? A.trunk : A.trunkDim, bx, by, 8, 22);
      blit(t.live ? A.canopy[v] : A.canopyDim[v], bx + sway, by, 8, 22);
    } });
  }

  let selected = null;
  for (const e of things) {
    if (e.kind !== "human" && e.kind !== "deer") continue;
    const [ix, iy] = interpPos(e, opts.interp);
    if (!inView(e, ix, iy)) continue;
    const st = animator.track(e.id, ix, iy, e.facing ?? null, time);
    if (e.kind === "human") animator.setAction(st, e.lastResult, time);
    const [sx, sy] = pos(ix, iy);
    if (e.id === opts.selectedId) selected = [sx, sy];
    drawables.push({ key: iy + 0.3, fn: () => (e.kind === "human" ? drawHuman(e, st, sx, sy) : drawDeer(st, sx, sy)) });
  }
  drawables.sort((a, b) => a.key - b.key);
  for (const d of drawables) d.fn();

  // ---- 4. overlays ----
  if (selected) { // selection ring
    ctx.strokeStyle = "#ffe14a";
    ctx.lineWidth = Math.max(2, z / 8);
    ctx.beginPath();
    ctx.arc(selected[0], selected[1], z * 0.65, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (++frameCount % 120 === 0) animator.prune(time);

  // ---------------- creature drawing ----------------
  function shadow(cx, cy, rx) {
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * z, rx * 0.4 * z, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDeer(st, sx, sy) {
    if (Math.abs(st.fx) > 0.3) st.deerFlip = st.fx < 0; // sprite is side-on: face the last horizontal heading
    shadow(sx, sy + 0.3 * z, 0.5);
    const bob = st.moving ? Math.abs(Math.sin(st.phase * Math.PI * 2)) * 0.03 * z : 0;
    const img = A.deer[st.frame], fy = sy + 0.3 * z - bob;
    if (st.deerFlip) {
      ctx.save();
      ctx.translate(sx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -9 * s, fy - 14 * s, img.width * s, img.height * s);
      ctx.restore();
    } else ctx.drawImage(img, sx - 9 * s, fy - 14 * s, img.width * s, img.height * s);
  }

  function drawHuman(e, st, sx, sy) {
    const act = animator.activeAction(st, time);
    let ox = 0, oy = 0;
    if (!st.moving) oy += Math.sin(time / 380 + e.id) * 0.012 * z; // idle breathing
    if (act?.type === "stab") { // lunge toward the target
      const k = Math.sin(Math.PI * act.p) * 0.22 * z;
      ox += st.fx * k;
      oy += st.fy * k;
    }
    if (act?.type === "pickup") oy -= Math.sin(Math.PI * act.p) * 0.14 * z; // little hop
    shadow(sx, sy + 0.3 * z, 0.32);

    const fx = sx + ox, fy = sy + oy + 0.3 * z; // feet
    const tunic = e.id === opts.playerId ? 0 : 1 + (e.id % (TUNIC_COUNT - 1));
    const img = A.humans[tunic][st.dir][st.frame];
    if (st.flip) {
      ctx.save();
      ctx.translate(fx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -8 * s, fy - 16 * s, img.width * s, img.height * s);
      ctx.restore();
    } else ctx.drawImage(img, fx - 8 * s, fy - 16 * s, img.width * s, img.height * s);

    // the hand (screen position), depending on which way the sprite faces
    const side = st.dir === "side" ? (st.flip ? -1 : 1) * 0.14 : st.dir === "up" ? -0.3 : 0.3;
    const hx = fx + side * z, hy = fy - 6 * s;

    if (heldKinds(e).includes("spear")) {
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1, 1.6 * s);
      ctx.strokeStyle = "#6b4a2a";
      ctx.beginPath();
      let tx, ty;
      if (act?.type === "stab") { // thrust along the facing direction
        const len = (0.5 + 0.9 * Math.sin(Math.PI * act.p)) * z;
        ctx.moveTo(hx - st.fx * 0.2 * z, hy - st.fy * 0.2 * z);
        tx = hx + st.fx * len;
        ty = hy + st.fy * len;
        ctx.lineTo(tx, ty);
      } else { // carried upright
        ctx.moveTo(hx, hy + 4 * s);
        tx = hx;
        ty = hy - 10 * s;
        ctx.lineTo(tx, ty);
      }
      ctx.stroke();
      ctx.fillStyle = "#d8d8d8";
      ctx.beginPath();
      ctx.arc(tx, ty, Math.max(1, 1.7 * s), 0, Math.PI * 2);
      ctx.fill();
    }

    if (act && (act.type === "sharpen" || act.type === "tend" || act.type === "make_fire" || act.type === "cook" || act.type === "eat")) {
      effects(act, fx, fy, hx, hy, st);
    }

    if (e.id === opts.playerId) { // small marker above the player's own head
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(fx, fy - 18 * s);
      ctx.lineTo(fx - 2.5 * s, fy - 21.5 * s);
      ctx.lineTo(fx + 2.5 * s, fy - 21.5 * s);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Little particle effects for what the character is doing.
  function effects(act, fx, fy, hx, hy, st) {
    const dot = (px, py, size, color, alpha) => {
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = color;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      ctx.globalAlpha = 1;
    };
    for (let i = 0; i < 3; i++) {
      const ph = (act.t * 2.6 + i / 3) % 1;
      if (act.type === "sharpen") { // wood chips flick off the stick
        dot(hx + (i - 1) * 2 * s + ph * (i % 2 ? 6 : -6) * s, hy - 2 * s - ph * 8 * s + ph * ph * 12 * s, 1.6 * s, "#d2b07a", 1 - ph);
      } else if (act.type === "tend" || act.type === "make_fire") { // sparks
        dot(fx + st.fx * 0.45 * z + (i - 1) * 2 * s, fy - 3 * s - ph * 9 * s, 1.6 * s, i % 2 ? "#ffb347" : "#ff7a1a", 1 - ph);
      } else if (act.type === "cook") { // steam
        dot(fx + st.fx * 0.4 * z + (i - 1) * 3 * s + Math.sin(ph * 6 + i) * s, fy - 10 * s - ph * 10 * s, 2.4 * s, "#ffffff", 0.55 * (1 - ph));
      } else if (act.type === "eat") { // crumbs
        dot(fx + (i - 1) * 3 * s, fy - 11 * s + ph * 7 * s, 1.4 * s, "#8a4a22", 1 - ph);
      }
    }
  }
}
