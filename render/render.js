import { getAtlas, hash2, TUNIC_COUNT } from "./sprites.js";
import { Animator } from "./animator.js";
import { DEER_FAWN_TICKS, HUMAN_ADULT_TICKS } from "../sim/constants.js";

// Lush ground colours (three variants for texture) and the bare colour a tile fades to when grazed out.
const LUSH = { ".": [[143, 191, 90], [139, 186, 86], [148, 195, 95]], ",": [[76, 138, 58], [71, 132, 53], [81, 143, 63]] };
const BARE = { ".": [186, 166, 106], ",": [112, 118, 70] };
const groundColor = (kind, variant, frac) => {
  // Perceived lushness isn't linear in grass amount: a tile with a fifth of its grass still reads as green.
  // (sqrt keeps thin grass looking green and only turns a tile bare as it is almost eaten out.)
  const a = LUSH[kind][variant], b = BARE[kind], t = 1 - Math.sqrt(Math.max(0, Math.min(1, frac)));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
};
const GROUND_ITEMS = new Set(["fire", "stick", "spear", "raw_meat", "cooked_meat"]);

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

// Free-fly the camera: hold a direction (dirX, dirY in {-1,0,1}, diagonals are normalized).
// Speed is constant on screen (PAN_SPEED px/s, x3 when fast), so it feels the same at any zoom, and it
// scales with dt so it doesn't depend on frame rate. Stays inside `bounds` ({ width, height } of the
// world) if given. Returns true if the camera was asked to move.
export const PAN_SPEED = 600;
export function panCamera(cam, dirX, dirY, dtSec, fast = false, bounds = null) {
  const l2 = dirX * dirX + dirY * dirY;
  if (!l2) return false;
  const k = (PAN_SPEED * (fast ? 3 : 1) * dtSec) / cam.zoom / Math.sqrt(l2);
  cam.x += dirX * k;
  cam.y += dirY * k;
  if (bounds) {
    cam.x = Math.min(bounds.width, Math.max(0, cam.x));
    cam.y = Math.min(bounds.height, Math.max(0, cam.y));
  }
  return true;
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
  const A = getAtlas();
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
      // How much grass is there? Straight from the sim in god view; from the character's observation
      // when the tile is in view; remembered tiles just show a neutral-lush ground.
      let frac = 0.8;
      if (!memory) frac = sim.world.grassCap[y * width + x] ? sim.grass[y * width + x] / sim.world.grassCap[y * width + x] : 1;
      else if (live) {
        const gc = obs.view.grass[y - obs.view.y0][x - obs.view.x0];
        frac = gc >= "0" && gc <= "9" ? Number(gc) / 9 : 1;
      }
      ctx.fillStyle = groundColor(ground, hh % 3, frac);
      // +1 overlap avoids hairline seams between tiles at fractional zooms.
      ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(z) + 1, Math.ceil(z) + 1);
      if (z >= 10) { // ground detail
        if (c === "." && hh % 5 === 0 && frac > 0.35) blit(A.tuft, sx + ((hh >> 8) % 10) * z / 12 + 0.1 * z, sy + ((hh >> 12) % 8) * z / 12 + 0.2 * z, 0, 0);
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
    // Fawns and children are drawn smaller. (Others' `adult` is in the observation; your own comes from your age.)
    const adult = e.kind === "deer"
      ? e.adult ?? e.age >= DEER_FAWN_TICKS
      : e.adult ?? (e.age !== undefined ? e.age >= HUMAN_ADULT_TICKS : sim.tick - e.born >= HUMAN_ADULT_TICKS);
    drawables.push({ key: iy + 0.3, fn: () => {
      if (e.kind === "deer") return drawDeer(st, sx, sy, adult);
      if (adult) return drawHuman(e, st, sx, sy);
      const feet = sy + 0.3 * z; // shrink everything about the feet
      ctx.save();
      ctx.translate(sx, feet);
      ctx.scale(0.7, 0.7);
      ctx.translate(-sx, -feet);
      drawHuman(e, st, sx, sy);
      ctx.restore();
    } });
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

  function drawDeer(st, sx, sy, adult) {
    if (Math.abs(st.fx) > 0.3) st.deerFlip = st.fx < 0; // sprite is side-on: face the last horizontal heading
    const k = adult ? 1 : 0.62; // a fawn is a smaller deer
    shadow(sx, sy + 0.3 * z, 0.5 * k);
    const bob = st.moving ? Math.abs(Math.sin(st.phase * Math.PI * 2)) * 0.03 * z : 0;
    const img = A.deer[st.frame], fy = sy + 0.3 * z - bob, sk = s * k;
    if (st.deerFlip) {
      ctx.save();
      ctx.translate(sx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -9 * sk, fy - 14 * sk, img.width * sk, img.height * sk);
      ctx.restore();
    } else ctx.drawImage(img, sx - 9 * sk, fy - 14 * sk, img.width * sk, img.height * sk);
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
