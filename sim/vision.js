import { VIEW_RADIUS, HUMAN_FOV_COS, SENSE_RADIUS } from "./constants.js";

// True if a tree tile lies between (x0,y0) and (x1,y1) (grid traversal of the segment).
// The tiles containing the two endpoints never block, so a tree can itself be seen.
export function segmentBlocked(world, x0, y0, x1, y1) {
  let tx = Math.floor(x0), ty = Math.floor(y0);
  const ex = Math.floor(x1), ey = Math.floor(y1);
  const dx = x1 - x0, dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Infinity : 1 / Math.abs(dx);
  const tDeltaY = dy === 0 ? Infinity : 1 / Math.abs(dy);
  let tMaxX = dx === 0 ? Infinity : (dx > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : (dy > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY;
  for (let guard = 0; guard < 256 && (tx !== ex || ty !== ey); guard++) {
    if (tMaxX < tMaxY) { tx += stepX; tMaxX += tDeltaX; } else { ty += stepY; tMaxY += tDeltaY; }
    if (tx === ex && ty === ey) return false;
    if (tx < 0 || ty < 0 || tx >= world.width || ty >= world.height) return true;
    if (world.treeAt[ty * world.width + tx]) return true;
  }
  return false;
}

// Can `viewer` (needs x, y, facing) see the point (px,py)? Within range, inside the cone, not behind a tree.
export function canSeePoint(sim, viewer, px, py, range = VIEW_RADIUS, cosHalf = HUMAN_FOV_COS) {
  const dx = px - viewer.x, dy = py - viewer.y;
  const d2 = dx * dx + dy * dy;
  if (d2 <= SENSE_RADIUS * SENSE_RADIUS) return true;
  if (d2 > range * range) return false;
  const [fx, fy] = viewer.facing;
  if ((fx * dx + fy * dy) / Math.sqrt(d2) < cosHalf) return false;
  return !segmentBlocked(sim.world, viewer.x, viewer.y, px, py);
}

// Visibility of the tiles in the (2R+1)^2 window around the viewer's tile, judged at tile centres:
// grid[(ty-y0)*N + (tx-x0)].
export function visionGrid(sim, viewer, range = VIEW_RADIUS, cosHalf = HUMAN_FOV_COS) {
  const N = 2 * range + 1, x0 = Math.floor(viewer.x) - range, y0 = Math.floor(viewer.y) - range;
  const w = sim.world, grid = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = x0 + i, y = y0 + j;
      if (x >= 0 && y >= 0 && x < w.width && y < w.height && canSeePoint(sim, viewer, x + 0.5, y + 0.5, range, cosHalf)) grid[j * N + i] = 1;
    }
  }
  return { grid, N, x0, y0, at: (tx, ty) => tx >= x0 && ty >= y0 && tx < x0 + N && ty < y0 + N && grid[(ty - y0) * N + (tx - x0)] === 1 };
}
