import { makeRng, deriveSeed } from "./rng.js";
import { generateWorld } from "./worldgen.js";
import { observe } from "./observe.js";
import { applyAction } from "./actions.js";
import { canSeePoint } from "./vision.js";
import * as C from "./constants.js";

const DEER_PER_1000_TILES = 4;
const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

export class Sim {
  constructor({ seed, width = 96, height = 96 }) {
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
    this.stats = { kills: 0, meals: 0, fires: 0, deaths: 0 };
    this.deerTarget = Math.floor((width * height * DEER_PER_1000_TILES) / 1000);
    for (let i = 0; i < this.deerTarget; i++) this.spawnDeerRandom();
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

  spawnDeerRandom() {
    const { width, height } = this.world;
    for (let tries = 0; tries < 50; tries++) {
      const x = this.rng.int(width), y = this.rng.int(height);
      if (this.isFree(x, y)) return this.spawn("deer", x + 0.5, y + 0.5, { facing: [0, 1] });
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
    for (const d of this.entities) {
      if (d.kind !== "deer" || d.removed) continue;
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
      } else if (d.moveTicks > 0) {
        d.moveTicks--;
        if (!this.moveBody(d, d.facing[0] * C.DEER_WANDER_SPEED, d.facing[1] * C.DEER_WANDER_SPEED)) d.moveTicks = 0;
      } else if (this.rng.chance(C.DEER_WANDER_CHANCE)) {
        d.facing = this.rng.unit();
        d.moveTicks = 8 + this.rng.int(24);
      }
    }
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
    if (this.tick % C.DEER_RESPAWN_EVERY === 0 &&
        this.entities.filter((e) => e.kind === "deer" && !e.removed).length < this.deerTarget) {
      this.spawnDeerRandom();
    }
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
