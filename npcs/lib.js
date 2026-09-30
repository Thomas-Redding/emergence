// Helpers for NPC authors. Pure functions over an observation; nothing here touches the sim.
// Positions are real numbers in tile units; terrain is a grid, so pathing works on tiles and
// steers toward real positions.

import { TileMemory } from "../sim/memory.js";

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

// Give any brain a memory of the terrain it has seen. The wrapped brain gets observations whose
// unseen tiles ('?') are filled in from memory where it has been before, so what it saw a moment
// ago doesn't vanish when it turns its head. (Without this an NPC dithers: it looks south, sees a
// tree and turns back; looks north, forgets the tree and turns south again.) The merged
// observation also carries obs.memory (a TileMemory) for brains that want more. Entities are not
// remembered here: only terrain.
export function withMemory(brainFn) {
  return function* (obs, rng) {
    const memory = new TileMemory();
    memory.update(obs);
    const inner = brainFn(mergeMemory(obs, memory), rng);
    let r = inner.next();
    while (!r.done) {
      obs = yield r.value;
      memory.update(obs);
      r = inner.next(mergeMemory(obs, memory));
    }
    return r.value;
  };
}

function mergeMemory(obs, memory) {
  const { x0, y0, tiles } = obs.view;
  const merged = tiles.map((row, j) => {
    if (!row.includes("?")) return row;
    let out = "";
    for (let i = 0; i < row.length; i++) out += row[i] !== "?" ? row[i] : memory.get(x0 + i, y0 + j)?.c ?? "?";
    return out;
  });
  return { ...obs, view: { ...obs.view, tiles: merged }, memory };
}

// One step of walking toward the point (tx,ty): a move action, or null if you are already within `within`
// of it or there is no way there. Because it never blocks, a loop like
//   const a = moveToward(...); obs = yield a ?? { type: "wait" };
// yields exactly once per iteration (a brain loop that can go round without yielding hangs the whole game).
export function moveToward(obs, tx, ty, { within = 0.9, sneak = false } = {}) {
  if (dist(obs.self, { x: tx, y: ty }) <= within) return null;
  const step = pathNext(obs, (x, y) => (x + 0.5 - tx) * (x + 0.5 - tx) + (y + 0.5 - ty) * (y + 0.5 - ty) <= within * within);
  if (!step) return null;
  const [gx, gy] = step === "here" ? [tx, ty] : [step[0] + 0.5, step[1] + 0.5];
  return { type: "move", dx: gx - obs.self.x, dy: gy - obs.self.y, sneak };
}

// Generator helpers: use with `obs = yield* ...`. They return the latest observation.

// Walk until within `within` of the point (tx,ty). Gives up if unreachable, after maxTicks, or if
// it stops getting closer for `stall` ticks (dithering, or stuck behind something).
export function* walkNear(obs, tx, ty, { within = 0.9, sneak = false, maxTicks = 200, stall = 80 } = {}) {
  let best = Infinity, sinceBest = 0;
  for (let i = 0; i < maxTicks; i++) {
    const d = dist(obs.self, { x: tx, y: ty });
    if (d <= within) return obs;
    if (d < best - 0.25) { best = d; sinceBest = 0; } else if (++sinceBest > stall) return obs;
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

// ---------- families ----------

// Give an adult brain what it needs to be a parent, and let it answer proposals without interrupting what it is
// doing (speech is a side channel, so a reply rides along with whatever action the brain yields).
// The wrapped brain's observations gain `obs.family`:
//   kids:  [{ id, bornTick, dependent, foodEst, lastFedTick, lastSeen: {x,y,tick}|null }]  your living children.
//          foodEst is a running ESTIMATE of the child's food (you can't see it): it starts at the newborn's food,
//          falls at the ordinary rate, and rises by a meal each time a `give` of cooked meat succeeds.
//          dependent: still a child (younger than the adulthood age).
//   lastBirthTick: when you last had a child (null if never).
//   people: { [id]: { x, y, tick, adult, sex } } everyone you have seen, and where and when you last saw them.
// reply(obs): called each tick a reply is possible; return { to, accept } to answer a proposal, or null.
export function withFamily(brainFn, { reply = null } = {}) {
  return function* (obs, rng) {
    const fam = { kids: [], lastBirthTick: null, people: {} };
    let prev = null, lastAction = null;
    const view = (o) => ({ ...o, family: fam });

    const update = (o) => {
      const { foodPerTick, mealFood, adultAge, mate } = o.rules;
      const dt = prev ? o.tick - prev.tick : 1;
      for (const k of fam.kids) k.foodEst = Math.max(0, k.foodEst - dt * foodPerTick);
      // a gift of cooked meat that went through: the child will eat it
      if (prev && lastAction && lastAction.type === "give" && o.lastResult.ok && o.lastResult.action === "give") {
        const kid = fam.kids.find((k) => k.id === lastAction.to);
        const item = prev.self.inventory.find((i) => i.id === lastAction.item);
        if (kid && item && item.kind === "cooked_meat") {
          kid.foodEst = Math.min(o.self.foodMax, kid.foodEst + mealFood);
          kid.lastFedTick = o.tick;
        }
      }
      for (const e of o.events) {
        if (e.type === "birth") { // (delivered the tick after the birth)
          fam.kids.push({ id: e.child, bornTick: o.tick - 1, dependent: true, foodEst: mate.childFood - foodPerTick, lastFedTick: null, lastSeen: null });
          fam.lastBirthTick = o.tick - 1;
        }
      }
      const living = new Set(o.self.children);
      fam.kids = fam.kids.filter((k) => living.has(k.id));
      for (const id of living) { // a child we never heard the birth of (e.g. this brain was swapped in later)
        if (!fam.kids.some((k) => k.id === id)) fam.kids.push({ id, bornTick: o.tick, dependent: true, foodEst: mate.childFood, lastFedTick: null, lastSeen: null });
      }
      for (const k of fam.kids) k.dependent = o.tick - k.bornTick < adultAge;
      for (const e of o.view.entities) {
        if (e.kind !== "human") continue;
        fam.people[e.id] = { x: e.x, y: e.y, tick: o.tick, adult: e.adult, sex: e.sex };
        const kid = fam.kids.find((k) => k.id === e.id);
        if (kid) kid.lastSeen = { x: e.x, y: e.y, tick: o.tick };
      }
      prev = o;
    };

    update(obs);
    const inner = brainFn(view(obs), rng);
    let r = inner.next();
    while (!r.done) {
      let action = r.value;
      if (reply && action && typeof action === "object" && action.propose === undefined && action.respond === undefined) {
        const answer = reply(view(obs));
        if (answer) action = { ...action, respond: answer };
      }
      lastAction = action;
      obs = yield action;
      update(obs);
      r = inner.next(view(obs));
    }
    return r.value;
  };
}

// Childhood, built in: until adulthood a person is given this life instead of running the wrapped brain
// (a child can't hunt, and can't ask for food), and then the wrapped brain takes over. A child
//   - eats cooked meat it is carrying, as soon as a whole meal (nearly) fits;
//   - picks up cooked meat lying around;
//   - stays near a parent, and waits there (a moving child alarms deer; a still one hardly does).
// Parents feed it with `give` (see makeForager).
export function withChildhood(brainFn) {
  return function* (obs, rng) {
    obs = yield* childLife(obs, rng);
    return yield* brainFn(obs, rng);
  };
}

const CHILD_EAT_SLACK = 100; // eats once at most this much of a meal would be wasted
const CHILD_STAY_NEAR = 4; // follows once a parent is further than this...
const CHILD_CLOSE_ENOUGH = 3; // ...until within this

const SCAN_DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const SCAN_TICKS_EACH = 3; // how long it faces each way while looking for a parent
const SCAN_ROUNDS = 4; // ...and how many times round before it gives up and wanders

function* childLife(obs, rng) {
  let lastParent = null, scanned = 0;
  while (obs.self.age < obs.rules.adultAge) {
    const me = obs.self, r = obs.rules;
    const parents = me.parents ?? [];
    const cooked = held(obs, "cooked_meat")[0];
    const parent = nearest(obs, obs.view.entities.filter((e) => e.kind === "human" && parents.includes(e.id)));
    if (parent) { lastParent = { x: parent.x, y: parent.y }; scanned = 0; }

    let action;
    if (cooked && me.food <= me.foodMax - r.mealFood + CHILD_EAT_SLACK) {
      action = { type: "eat", item: cooked.id };
    } else {
      const spare = nearest(obs, around(obs, "cooked_meat"));
      if (spare) {
        action = dist(obs.self, spare) <= obs.reach.pickup ? { type: "pickup", item: spare.id } : moveToward(obs, spare.x, spare.y, { within: obs.reach.pickup * 0.8 });
      } else if (parent) {
        action = dist(obs.self, parent) > CHILD_STAY_NEAR ? moveToward(obs, parent.x, parent.y, { within: CHILD_CLOSE_ENOUGH }) : null;
      } else if (lastParent && dist(obs.self, lastParent) > 2) {
        action = moveToward(obs, lastParent.x, lastParent.y, { within: 2 }); // went out of sight: go to where it was
      } else if (lastParent) {
        // Where it last saw them, and they aren't in view. You only see what is in front of you, so turn on the
        // spot to look all round; only if that fails, wander.
        const round = Math.floor(scanned / (SCAN_TICKS_EACH * SCAN_DIRS.length));
        if (round < SCAN_ROUNDS) {
          const [dx, dy] = SCAN_DIRS[Math.floor(scanned / SCAN_TICKS_EACH) % SCAN_DIRS.length];
          action = { type: "face", dx, dy };
        } else {
          const d = randomDir(rng);
          action = { type: "move", dx: d[0], dy: d[1] };
        }
        scanned++;
      }
    }
    obs = yield action ?? { type: "wait" };
  }
  return obs;
}
