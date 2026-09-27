import { makeRng, deriveSeed } from "./rng.js";
import { generateWorld } from "./worldgen.js";
import { observe } from "./observe.js";
import { applyAction } from "./actions.js";
import { canSeePoint } from "./vision.js";
import * as C from "./constants.js";

const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

export class Sim {
  // startingDeer: how many deer at tick 0 (default scales with map area); startingGrass: the fraction of
  // each tile's grass capacity present at tick 0. Both only shape the opening: the herd then finds its own size.
  constructor({ seed, width = 96, height = 96, startingDeer = null, startingGrass = C.GRASS_START_FRACTION }) {
    this.seed = seed;
    this.tick = 0;
    this.world = generateWorld(seed, width, height);
    this.rng = makeRng(deriveSeed(seed, "sim"));
    this.entities = []; // ascending id order; removal is deferred to end of step
    this.byIdMap = new Map();
    this.nextId = 1;
    this.brains = new Map(); // actor id -> { fn, gen, dead, record }
    this.humanIds = []; // actors added with { record: true }: the ones a person (or a replay) drives
    this.inputLog = []; // [{ tick, actor, action }] of every non-wait action by a recorded brain:
    //                     with the seed and the setup, everything needed to replay a session
    this.stats = { kills: 0, meals: 0, fires: 0, deaths: 0, deerBorn: 0, deerStarved: 0, deerOld: 0 };
    this.grass = Uint8Array.from(this.world.grassCap, (c) => Math.round(c * startingGrass));
    const herd = startingDeer ?? Math.floor((width * height * C.DEER_START_PER_1000_TILES) / 1000);
    for (let i = 0; i < herd; i++) this.spawnDeerRandom();
    for (let i = 0; i < C.INITIAL_STICKS; i++) this.dropStick(); // the forest floor starts with some
  }

  byId(id) { return this.byIdMap.get(id); }

  spawn(kind, x, y, extra = {}) {
    const e = { id: this.nextId++, kind, x, y, ...extra };
    this.entities.push(e);
    this.byIdMap.set(e.id, e);
    return e;
  }

  isFree(x, y) {
    const w = this.world;
    return x >= 0 && y >= 0 && x < w.width && y < w.height && !w.treeAt[y * w.width + x];
  }

  // Can a creature's body (a square of half-width BODY_HALF) stand centred at (x,y)?
  canStand(x, y) {
    const h = C.BODY_HALF;
    for (let ty = Math.floor(y - h); ty <= Math.floor(y + h); ty++) {
      for (let tx = Math.floor(x - h); tx <= Math.floor(x + h); tx++) if (!this.isFree(tx, ty)) return false;
    }
    return true;
  }

  // Move by (dx,dy), sliding along obstacles (each axis tried separately). True if it moved at all.
  // Steps are far smaller than a tree plus a body, so nothing tunnels through.
  moveBody(e, dx, dy) {
    let moved = false;
    if (dx !== 0 && this.canStand(e.x + dx, e.y)) { e.x += dx; moved = true; }
    if (dy !== 0 && this.canStand(e.x, e.y + dy)) { e.y += dy; moved = true; }
    return moved;
  }

  // A deer with its own life: energy, age, and a lifespan rolled now (deterministically).
  spawnDeer(x, y, { age, energy }) {
    return this.spawn("deer", x, y, {
      facing: [0, 1], age, energy, lifespan: C.DEER_LIFESPAN_MIN + this.rng.int(C.DEER_LIFESPAN_SPREAD),
      breedCooldown: 0, grazing: false, target: null,
    });
  }

  // The starting herd: adults of assorted ages and fullness, scattered.
  spawnDeerRandom() {
    const { width, height } = this.world;
    for (let tries = 0; tries < 50; tries++) {
      const x = this.rng.int(width), y = this.rng.int(height);
      if (this.isFree(x, y)) {
        const age = C.DEER_FAWN_TICKS + this.rng.int(C.DEER_LIFESPAN_MIN / 2);
        return this.spawnDeer(x + 0.5, y + 0.5, { age, energy: 600 + this.rng.int(400) });
      }
    }
  }

  // Nearest free tile to (x,y), scanning square rings in fixed order.
  findFreeNear(x, y) {
    for (let r = 0; r < Math.max(this.world.width, this.world.height); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && this.isFree(x + dx, y + dy)) return [x + dx, y + dy];
        }
      }
    }
  }

  // Every actor, NPC or person, is driven the same way: a brain, i.e. a function*(obs, rng) that
  // yields one action per tick and receives the next observation. (x, y) is a tile; the actor
  // starts at the centre of the nearest free tile.
  // opts.record: log this brain's actions to inputLog (use it for human-driven actors, so a
  // session can be replayed by feeding the log back through scriptedBrain).
  addActor(brainFn, x, y, { record = false } = {}) {
    [x, y] = this.findFreeNear(x, y);
    const a = this.spawn("human", x + 0.5, y + 0.5, { facing: [0, 1], food: C.FOOD_START, noisy: false, lastResult: { ok: true } });
    this.brains.set(a.id, { fn: brainFn, gen: null, dead: false, record });
    if (record) this.humanIds.push(a.id);
    return a;
  }

  // Swap who drives an actor (e.g. hand a replayed actor back to a live player).
  setBrain(actorId, brainFn) {
    const b = this.brains.get(actorId);
    b.fn = brainFn;
    b.gen = null;
    b.dead = false;
  }

  // What the actor's brain would be given right now. The UI uses this too, so a player's screen
  // shows exactly what their character can perceive and no more.
  observe(actorId) {
    const a = this.byId(actorId);
    return a && !a.removed ? observe(this, a) : null;
  }

  think(a) {
    const b = this.brains.get(a.id);
    if (!b || b.dead) return { type: "wait" };
    const obs = observe(this, a);
    let action;
    try {
      let r;
      if (!b.gen) {
        b.gen = b.fn(obs, makeRng(deriveSeed(this.seed, "npc" + a.id)));
        r = b.gen.next();
      } else r = b.gen.next(obs);
      if (r.done) { b.dead = true; return { type: "wait" }; }
      action = r.value;
      if (b.record && action && action.type !== "wait") {
        this.inputLog.push({ tick: this.tick, actor: a.id, action: JSON.parse(JSON.stringify(action)) });
      }
    } catch (err) {
      b.dead = true; // a crashing brain idles; it must never take the sim down
      b.error = err;
      return { type: "wait" };
    }
    return action;
  }

  stepActor(a) {
    a.noisy = false;
    a.lastResult = applyAction(this, a, this.think(a));
    if (this.tick % C.FOOD_DECAY_EVERY === 0 && --a.food <= 0) {
      a.removed = true;
      this.stats.deaths++;
      for (const e of this.entities) if (e.holder === a.id) { e.holder = null; e.x = a.x; e.y = a.y; }
    }
  }

  stepFires() {
    for (const f of this.entities) {
      if (f.kind === "fire" && f.lit && --f.fuel <= 0) f.removed = true;
    }
  }

  stepDeer(humans) {
    const deer = this.entities.filter((e) => e.kind === "deer" && !e.removed); // snapshot: newborns act next tick
    this.liveDeer = deer.length;
    for (const d of deer) {
      // ---- life: age, hunger, death ----
      d.age++;
      if ((this.tick + d.id) % C.DEER_METAB_EVERY === 0) d.energy--;
      if (d.breedCooldown > 0) d.breedCooldown--;
      if (d.energy <= 0) { d.removed = true; this.stats.deerStarved++; continue; }
      if (d.age >= d.lifespan) { d.removed = true; this.stats.deerOld++; continue; }

      // ---- noticing humans ----
      if (!d.fleeTicks) {
        for (const h of humans) {
          const r = h.noisy ? C.NOISY_RADIUS : C.QUIET_RADIUS;
          // Footsteps are heard from any direction; a quiet human must be seen (cone + line of sight).
          const aware = dist2(d, h) <= r * r && (h.noisy || canSeePoint(this, d, h.x, h.y, r, C.DEER_FOV_COS));
          if (aware && this.rng.chance(h.noisy ? C.NOISY_NOTICE : C.QUIET_NOTICE)) {
            d.fleeTicks = C.FLEE_TICKS;
            break;
          }
        }
      }

      // ---- what to do this tick: flee > finish a walk > graze if hungry > rest/wander ----
      if (d.fleeTicks) {
        d.fleeTicks--;
        let threat = null;
        for (const h of humans) if (!threat || dist2(d, h) < dist2(d, threat)) threat = h;
        if (threat) {
          const vx = d.x - threat.x, vy = d.y - threat.y, l2 = vx * vx + vy * vy;
          const k = l2 === 0 ? 0 : 1 / Math.sqrt(l2);
          const ux = l2 === 0 ? d.facing[0] : vx * k, uy = l2 === 0 ? d.facing[1] : vy * k;
          if (this.moveBody(d, ux * C.DEER_FLEE_SPEED, uy * C.DEER_FLEE_SPEED)) d.facing = [ux, uy];
        }
      } else if (this.updateHunger(d) && this.eatHere(d)) {
        d.moveTicks = 0; // hungry and standing on grass: eat it, whatever else it was doing
      } else if (d.moveTicks > 0) {
        d.moveTicks--;
        if (!this.moveBody(d, d.facing[0] * C.DEER_WANDER_SPEED, d.facing[1] * C.DEER_WANDER_SPEED)) d.moveTicks = 0;
      } else if (d.grazing) this.graze(d);
      else if (this.rng.chance(C.DEER_WANDER_CHANCE)) this.startWander(d, 8, 24);

      this.maybeBreed(d);
    }
  }

  startWander(d, base, spread) {
    d.facing = this.rng.unit();
    d.moveTicks = base + this.rng.int(spread);
  }

  // Hysteresis: start grazing when hungry, stop when full. Returns whether it is grazing now.
  updateHunger(d) {
    if (d.energy < C.DEER_HUNGRY) d.grazing = true;
    else if (d.energy >= C.DEER_FULL) d.grazing = false;
    return d.grazing;
  }

  // Take a bite from the tile it is standing on, if it has any grass. Returns whether it ate.
  eatHere(d) {
    const ti = Math.floor(d.y) * this.world.width + Math.floor(d.x);
    if (this.grass[ti] <= 0) return false;
    const bite = Math.min(C.DEER_BITE, this.grass[ti]);
    this.grass[ti] -= bite;
    d.energy = Math.min(C.DEER_ENERGY_MAX, d.energy + bite * C.DEER_ENERGY_PER_GRASS);
    d.target = null;
    return true;
  }

  // Hungry and not on grass: walk to the nearest decent patch (or, if none is near, roam far).
  graze(d) {
    const w = this.world;
    if (!d.target || this.grass[d.target[1] * w.width + d.target[0]] < C.DEER_MIN_PATCH) d.target = this.findGrass(d);
    if (!d.target) { this.startWander(d, C.DEER_ROAM_TICKS, C.DEER_ROAM_TICKS); return; } // nothing near: set off across the map
    const dx = d.target[0] + 0.5 - d.x, dy = d.target[1] + 0.5 - d.y, l2 = dx * dx + dy * dy;
    if (l2 === 0) { d.target = null; return; }
    const k = 1 / Math.sqrt(l2), ux = dx * k, uy = dy * k;
    if (this.moveBody(d, ux * C.DEER_GRAZE_SPEED, uy * C.DEER_GRAZE_SPEED)) d.facing = [ux, uy];
    else { d.target = null; this.startWander(d, 6, 10); } // blocked (a tree in the way): step aside, then look again
  }

  // The nearest tile with enough grass, looking near first and then farther; null if none.
  // Ties (very common in an even meadow) go to the lusher tile, then to a random one. Breaking ties
  // by scan order instead would send every deer marching the same way, eating a straight line.
  findGrass(d) {
    const w = this.world, cx = Math.floor(d.x), cy = Math.floor(d.y);
    for (const R of [C.DEER_SEARCH_NEAR, C.DEER_SEARCH_FAR]) {
      let bestD = Infinity, bestGrass = -1, ties = [];
      for (let y = Math.max(0, cy - R); y <= Math.min(w.height - 1, cy + R); y++) {
        for (let x = Math.max(0, cx - R); x <= Math.min(w.width - 1, cx + R); x++) {
          const g = this.grass[y * w.width + x];
          if (g < C.DEER_MIN_PATCH) continue;
          const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy);
          if (dd < bestD || (dd === bestD && g > bestGrass)) { bestD = dd; bestGrass = g; ties = [[x, y]]; }
          else if (dd === bestD && g === bestGrass) ties.push([x, y]);
        }
      }
      if (ties.length) return ties.length === 1 ? ties[0] : ties[this.rng.int(ties.length)];
    }
    return null;
  }

  // A well-fed adult with another adult nearby may have a fawn. The herd's size is limited only by
  // the grass: no food, no energy to breed.
  maybeBreed(d) {
    if (d.age < C.DEER_FAWN_TICKS || d.breedCooldown > 0 || d.energy < C.DEER_BREED_ENERGY || d.fleeTicks) return;
    if (this.liveDeer >= C.DEER_MAX || !this.rng.chance(C.DEER_BREED_CHANCE)) return;
    const r2 = C.DEER_MATE_RADIUS * C.DEER_MATE_RADIUS;
    let mate = false;
    for (const o of this.entities) {
      if (o !== d && o.kind === "deer" && !o.removed && o.age >= C.DEER_FAWN_TICKS && dist2(o, d) <= r2) { mate = true; break; }
    }
    if (!mate) return;
    d.energy -= C.DEER_BIRTH_COST;
    d.breedCooldown = C.DEER_BREED_COOLDOWN;
    const [ux, uy] = this.rng.unit();
    const fx = d.x + ux * 0.8, fy = d.y + uy * 0.8;
    const at = this.canStand(fx, fy) ? [fx, fy] : [d.x, d.y];
    this.spawnDeer(at[0], at[1], { age: 0, energy: C.DEER_FAWN_ENERGY });
    this.liveDeer++;
    this.stats.deerBorn++;
  }

  // A few tiles regain grass each tick, each tile once per GRASS_REGROW_PERIOD ticks (staggered).
  growGrass() {
    const cap = this.world.grassCap, growth = this.world.grassGrowth, g = this.grass, P = C.GRASS_REGROW_PERIOD;
    for (let i = this.tick % P; i < g.length; i += P) if (g[i] < cap[i]) g[i] = Math.min(cap[i], g[i] + growth[i]);
  }

  dropStick() {
    const trees = this.world.trees;
    if (!trees.length) return;
    const t = trees[this.rng.int(trees.length)];
    const [dx, dy] = C.DIRS[this.rng.int(4)];
    if (this.isFree(t.x + dx, t.y + dy)) this.spawn("stick", t.x + dx + 0.5, t.y + dy + 0.5, { sharpness: 0 });
  }

  dropSticks() {
    if (this.rng.chance(C.STICK_DROP_CHANCE)) this.dropStick();
  }

  step() {
    const humans = this.entities.filter((e) => e.kind === "human");
    for (const a of humans) this.stepActor(a); // id order
    this.stepFires();
    this.stepDeer(humans.filter((h) => !h.removed));
    this.dropSticks();
    this.growGrass();
    if (this.entities.some((e) => e.removed)) {
      for (const e of this.entities) if (e.removed) this.byIdMap.delete(e.id);
      this.entities = this.entities.filter((e) => !e.removed);
    }
    this.tick++;
  }

  run(ticks) {
    for (let i = 0; i < ticks; i++) this.step();
  }
}
