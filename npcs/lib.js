// Helpers for NPC authors. Pure functions over an observation; nothing here touches the sim.
// Positions are real numbers in tile units; terrain is a grid, so pathing works on tiles and
// steers toward real positions.

const TILE_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export const dist = (a, b) => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));

// Terrain at an integer tile coordinate ('?' = not visible now, '#' = outside the world).
export function tileAt(obs, tx, ty) {
  const { x0, y0, tiles } = obs.view;
  return tiles[ty - y0]?.[tx - x0] ?? "#";
}
export const passable = (obs, tx, ty) => {
  const t = tileAt(obs, tx, ty);
  return t !== "T" && t !== "#"; // unseen ('?') tiles are assumed walkable
};
export const myTile = (obs) => [Math.floor(obs.self.x), Math.floor(obs.self.y)];

// Is the point ahead of me, i.e. inside (roughly) my line of sight direction?
export function facingToward(obs, x, y, minCos = 0.95) {
  const dx = x - obs.self.x, dy = y - obs.self.y, l = Math.sqrt(dx * dx + dy * dy);
  if (l === 0) return true;
  return (obs.self.facing[0] * dx + obs.self.facing[1] * dy) / l >= minCos;
}

export const held = (obs, kind) => obs.self.inventory.filter((e) => e.kind === kind);
export const around = (obs, kind) => obs.view.entities.filter((e) => e.kind === kind);

export function nearest(obs, list) {
  let best = null;
  for (const e of list) if (!best || dist(obs.self, e) < dist(obs.self, best)) best = e;
  return best;
}

// Random unit vector from the NPC's own rng (rng.unit() is trig-free, so it is deterministic everywhere).
export const randomDir = (rng) => rng.unit();

// BFS over the visible tile window from my tile. goal(tx,ty) says which tiles count as arrived.
// Returns [tx,ty] of the first tile to step into, "here" if my tile already qualifies, or null.
export function pathNext(obs, goal) {
  const [sx, sy] = myTile(obs);
  if (goal(sx, sy)) return "here";
  const N = 2 * obs.view.radius + 1;
  const key = (tx, ty) => (ty - obs.view.y0) * N + (tx - obs.view.x0);
  const seen = new Set([key(sx, sy)]);
  const queue = [[sx, sy, null]];
  for (let i = 0; i < queue.length; i++) {
    const [cx, cy, first] = queue[i];
    for (const [dx, dy] of TILE_DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < obs.view.x0 || ny < obs.view.y0 || nx >= obs.view.x0 + N || ny >= obs.view.y0 + N) continue;
      if (!passable(obs, nx, ny) || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      const f = first ?? [nx, ny];
      if (goal(nx, ny)) return f;
      queue.push([nx, ny, f]);
    }
  }
  return null;
}

// Generator helpers: use with `obs = yield* ...`. They return the latest observation.

// Walk until within `within` of the point (tx,ty). Gives up after maxTicks or if unreachable.
export function* walkNear(obs, tx, ty, { within = 0.9, sneak = false, maxTicks = 200 } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    if (dist(obs.self, { x: tx, y: ty }) <= within) return obs;
    const step = pathNext(obs, (x, y) => (x + 0.5 - tx) * (x + 0.5 - tx) + (y + 0.5 - ty) * (y + 0.5 - ty) <= within * within);
    if (!step) return obs;
    // In a qualifying tile: head straight for the point. Otherwise aim at the next tile's centre.
    const [gx, gy] = step === "here" ? [tx, ty] : [step[0] + 0.5, step[1] + 0.5];
    obs = yield { type: "move", dx: gx - obs.self.x, dy: gy - obs.self.y, sneak };
  }
  return obs;
}

// Wander in a straight-ish line, picking a new heading when blocked, and glancing in a
// random direction every few steps (you can't see behind or beside you while walking).
// Returns early as soon as until(obs) is true, so the caller can react to what it just spotted.
export function* explore(obs, rng, steps = 24, until = null) {
  let dir = randomDir(rng);
  for (let i = 0; i < steps; i++) {
    if (until && until(obs)) return obs;
    if (i % 8 === 7) {
      const g = randomDir(rng);
      obs = yield { type: "face", dx: g[0], dy: g[1] };
    }
    obs = yield { type: "move", dx: dir[0], dy: dir[1] };
    if (!obs.lastResult.ok) dir = randomDir(rng);
  }
  return obs;
}
