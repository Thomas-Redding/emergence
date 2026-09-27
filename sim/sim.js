import { makeRng, deriveSeed } from "./rng.js";
import { generateWorld } from "./worldgen.js";
import { observe } from "./observe.js";
import { applyAction } from "./actions.js";
import { canSeePoint } from "./vision.js";
import * as C from "./constants.js";

// What a child does if neither parent has a brain that can be handed down: wait (and starve unless fed).
function* idleBrain(obs) {
  for (;;) obs = yield { type: "wait" };
}

const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

export class Sim {
  // startingDeer: how many deer at tick 0 (default scales with map area); startingGrass: the fraction of
  // each tile's grass capacity present at tick 0. Both only shape the opening: the herd then finds its own size.
  // humanLifespanMin/Spread: the range old-age death is rolled from (overridable, e.g. tiny in tests).
  constructor({ seed, width = 96, height = 96, startingDeer = null, startingGrass = C.GRASS_START_FRACTION,
                humanLifespanMin = C.HUMAN_LIFESPAN_MIN, humanLifespanSpread = C.HUMAN_LIFESPAN_SPREAD, humanMax = C.HUMAN_MAX }) {
    this.seed = seed;
    this.tick = 0;
    this.humanLifespanMin = humanLifespanMin;
    this.humanLifespanSpread = humanLifespanSpread;
    this.humanMax = humanMax;
    this.world = generateWorld(seed, width, height);
    this.rng = makeRng(deriveSeed(seed, "sim"));
    this.entities = []; // ascending id order; removal is deferred to end of step
    this.byIdMap = new Map();
    this.nextId = 1;
    this.brains = new Map(); // actor id -> { fn, gen, dead, record }
    this.humanIds = []; // actors added with { record: true }: the ones a person (or a replay) drives
    this.inputLog = []; // [{ tick, actor, action }] of every non-wait action by a recorded brain:
    //                     with the seed and the setup, everything needed to replay a session
    this.stats = { kills: 0, meals: 0, fires: 0, deaths: 0, deathsStarved: 0, deathsOld: 0, births: 0, grewUp: 0, childStarved: 0, deerBorn: 0, deerStarved: 0, deerOld: 0 };
    // Speech: pending proposals, and who is on a "no" cooldown. (Both are world state, so both are hashed.)
    this.proposals = []; // [{ id, kind, from, to, createdTick, expires }] in creation order
    this.nextProposalId = 1;
    this.declineUntil = new Map(); // "from:to" -> tick before which `from` can't ask `to` again
    this.speechQueue = []; // speech from this tick's actions, resolved after everyone has acted
    this.notices = []; // [person, event] notifications caused by this tick's actions, delivered at its end
    // What each kind of proposal does when accepted. accept(sim, proposer, recipient) -> { ok, reason? }.
    // (Tests can register their own kinds here.)
    this.proposalKinds = new Map([["mate", { accept: (sim, proposer, recipient) => sim.mate(proposer, recipient) }]]);
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
  // age: how old they are at the start (default: a fresh adult). lifespan: overrides the rolled old-age
  // death (a test hook); normally it is rolled from a per-person stream so that adding people never
  // perturbs the random draws that drive the world and the deer.
  // Births use the rest: `at` places someone at an exact position (instead of the nearest free tile to
  // (x, y)), `food` sets their starting food, and `parents` / `generation` record who they came from.
  addActor(brainFn, x, y, { record = false, age = C.HUMAN_ADULT_TICKS, lifespan = null, at = null, food = C.FOOD_START, parents = null, generation = 0 } = {}) {
    if (!at) { [x, y] = this.findFreeNear(x, y); at = [x + 0.5, y + 0.5]; }
    // tally: what this actor has achieved (for benchmarking brains against each other). It only counts
    // things that already happened in the world, so it isn't part of the state hash.
    const a = this.spawn("human", at[0], at[1], {
      facing: [0, 1], food, noisy: false, lastResult: { ok: true }, tally: { kills: 0, meals: 0, fires: 0 }, inbox: [],
      parents, children: [], generation, birthCooldown: 0,
    });
    a.born = this.tick - age; // age is this.tick - born
    a.lifespan = lifespan ?? this.humanLifespanMin + makeRng(deriveSeed(this.seed, "life" + a.id)).int(this.humanLifespanSpread);
    // inheritable: a brain driven from outside (a person at the keyboard, a replay) can't be handed down.
    this.brains.set(a.id, { fn: brainFn, gen: null, dead: false, record, inheritable: !record });
    if (record) this.humanIds.push(a.id);
    return a;
  }

  humanCount() {
    let n = 0;
    for (const e of this.entities) if (e.kind === "human" && !e.removed) n++;
    return n;
  }

  // A "mate" proposal was accepted. Both must be adult, fed, and off cooldown; if so each pays a cost and a
  // child is born next to them, running one parent's brain. Returns { ok, reason? } (reason names who failed).
  mate(a, b) {
    const problem = (p, who) => {
      if (this.tick - p.born < C.HUMAN_ADULT_TICKS) return `${who}_child`;
      if (p.food < C.HUMAN_MATE_MIN_FOOD) return `${who}_hungry`;
      if (p.birthCooldown > 0) return `${who}_cooldown`;
      return null;
    };
    const why = problem(a, "proposer") ?? problem(b, "recipient");
    if (why) return { ok: false, reason: why };
    if (this.humanCount() >= this.humanMax) return { ok: false, reason: "population_cap" };

    a.food -= C.HUMAN_BIRTH_COST;
    b.food -= C.HUMAN_BIRTH_COST;
    a.birthCooldown = b.birthCooldown = C.HUMAN_BIRTH_COOLDOWN;

    // The child runs a parent's brain. Among the parents whose brain can be handed down, pick one at
    // random (from the seeded stream); if neither can (people at the keyboard), the child just waits.
    const heirs = [a, b].filter((p) => this.brains.get(p.id).inheritable);
    const from = heirs.length === 2 ? heirs[this.rng.chance(0.5) ? 0 : 1] : heirs[0];
    const brainFn = from ? this.brains.get(from.id).fn : idleBrain;

    const [ux, uy] = this.rng.unit();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const at = this.canStand(mx + ux * 0.8, my + uy * 0.8) ? [mx + ux * 0.8, my + uy * 0.8] : [a.x, a.y];
    const child = this.addActor(brainFn, 0, 0, { at, age: 0, food: C.HUMAN_CHILD_FOOD, parents: [a.id, b.id], generation: Math.max(a.generation, b.generation) + 1 });
    a.children.push(child.id);
    b.children.push(child.id);
    this.stats.births++;
    this.emit(a, { type: "birth", child: child.id, with: b.id });
    this.emit(b, { type: "birth", child: child.id, with: a.id });
    return { ok: true };
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
    a.inbox.length = 0; // one-shot events are delivered exactly once, with this observation
    let action;
    try {
      let r;
      if (!b.gen) {
        b.gen = b.fn(obs, makeRng(deriveSeed(this.seed, "npc" + a.id)));
        r = b.gen.next();
      } else r = b.gen.next(obs);
      if (r.done) { b.dead = true; return { type: "wait" }; }
      action = r.value;
      const speaks = action && typeof action === "object" && (action.propose !== undefined || action.respond !== undefined);
      if (b.record && action && (action.type !== "wait" || speaks)) { // (a wait can still carry speech)
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
    if (a.birthCooldown > 0) a.birthCooldown--;
    if (a.parents && this.tick - a.born === C.HUMAN_ADULT_TICKS) this.stats.grewUp++; // a child reaches adulthood
    const action = this.think(a);
    a.lastResult = applyAction(this, a, action);
    if (action && typeof action === "object" && (action.propose !== undefined || action.respond !== undefined)) {
      this.speechQueue.push({ from: a.id, action }); // speech rides along with the action; resolved at the end of the tick
    }
    if (this.tick % C.FOOD_DECAY_EVERY === 0 && --a.food <= 0) this.killPerson(a, "starvation");
    else if (this.tick - a.born >= a.lifespan) this.killPerson(a, "old_age");
  }

  // A person dies: they leave the world, and what they carried drops where they fell.
  killPerson(a, cause) {
    a.removed = true;
    a.diedAt = this.tick;
    a.cause = cause; // "starvation" | "old_age" (also stays on the object, for whoever holds a reference)
    this.stats.deaths++;
    if (cause === "starvation") {
      this.stats.deathsStarved++;
      if (a.parents && this.tick - a.born < C.HUMAN_ADULT_TICKS) this.stats.childStarved++;
    }
    else this.stats.deathsOld++;
    for (const e of this.entities) if (e.holder === a.id) { e.holder = null; e.x = a.x; e.y = a.y; }
    for (const p of this.proposals.filter((q) => q.from === a.id || q.to === a.id)) this.closeProposal(p, "gone");
  }

  // ---------------- speech: propose / respond ----------------
  // Queue an event for someone's next observation (private to them).
  emit(person, event) {
    person.inbox.push(event);
    if (person.inbox.length > C.INBOX_MAX) person.inbox.shift();
  }

  // Like emit, but delivered at the end of the tick, so it arrives on the next tick whether or not the
  // person happened to act after whoever caused it. (The item itself changes hands at once, in acting order,
  // like every other action; this is only the notification.)
  emitLater(person, event) {
    this.notices.push([person, event]);
  }

  // End a pending proposal with an outcome, telling both people (whoever is still around).
  closeProposal(p, outcome, reason) {
    this.proposals.splice(this.proposals.indexOf(p), 1);
    const note = (who, other) => {
      const person = this.byId(who);
      if (person && !person.removed) this.emit(person, { type: "proposal_result", id: p.id, kind: p.kind, with: other, outcome, ...(reason ? { reason } : {}) });
    };
    note(p.from, p.to);
    note(p.to, p.from);
  }

  expireProposals() {
    for (const p of this.proposals.filter((q) => this.tick >= q.expires)) this.closeProposal(p, "expired");
  }

  // Speech takes effect after everyone has acted, so it doesn't matter who happened to act first.
  resolveSpeech() {
    const queue = this.speechQueue;
    this.speechQueue = [];
    for (const { from, action } of queue) {
      const a = this.byId(from);
      if (!a || a.removed) continue;
      const proposes = action.propose !== undefined, responds = action.respond !== undefined;
      if (proposes && responds) this.emit(a, { type: "speech_failed", speech: "both", reason: "one_message_per_tick" });
      else if (proposes) this.propose(a, action.propose);
      else this.respond(a, action.respond);
    }
  }

  propose(a, p) {
    const fail = (reason) => this.emit(a, { type: "speech_failed", speech: "propose", reason });
    if (!p || typeof p !== "object" || !Number.isInteger(p.to) || typeof p.kind !== "string") return fail("bad_speech");
    if (!this.proposalKinds.has(p.kind)) return fail("unknown_kind");
    const b = this.byId(p.to);
    if (!b || b.removed || b.kind !== "human" || b === a) return fail("no_such_person");
    if (dist2(a, b) > C.TALK_RANGE * C.TALK_RANGE) return fail("out_of_range");
    if (!canSeePoint(this, a, b.x, b.y, C.TALK_RANGE)) return fail("not_visible");
    if (this.proposals.some((q) => q.from === a.id)) return fail("already_pending");
    const until = this.declineUntil.get(a.id + ":" + b.id);
    if (until !== undefined && this.tick < until) return fail("cooldown");
    const proposal = { id: this.nextProposalId++, kind: p.kind, from: a.id, to: b.id, createdTick: this.tick, expires: this.tick + C.PROPOSAL_TICKS };
    this.proposals.push(proposal);
    this.emit(b, { type: "proposal", id: proposal.id, kind: proposal.kind, from: a.id, expires: proposal.expires });
    this.emit(a, { type: "proposal_sent", id: proposal.id, kind: proposal.kind, to: b.id, expires: proposal.expires });
  }

  // `to` names the person who asked. (Each person has at most one proposal out, so it is unambiguous.)
  respond(a, r) {
    const fail = (reason) => this.emit(a, { type: "speech_failed", speech: "respond", reason });
    if (!r || typeof r !== "object" || !Number.isInteger(r.to) || typeof r.accept !== "boolean") return fail("bad_speech");
    // (a proposal made this very tick can't be answered yet: its recipient hasn't heard it)
    const p = this.proposals.find((q) => q.from === r.to && q.to === a.id && q.createdTick < this.tick);
    if (!p) return fail("no_such_proposal");
    const asker = this.byId(p.from);
    if (dist2(a, asker) > C.TALK_RANGE * C.TALK_RANGE) return fail("out_of_range"); // stays pending until it expires
    if (!r.accept) {
      this.declineUntil.set(p.from + ":" + p.to, this.tick + C.DECLINE_COOLDOWN);
      return this.closeProposal(p, "declined");
    }
    const result = this.proposalKinds.get(p.kind).accept(this, asker, a);
    this.closeProposal(p, result.ok ? "accepted" : "invalid", result.ok ? undefined : result.reason);
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
    this.expireProposals();
    for (const a of humans) if (!a.removed) this.stepActor(a); // id order
    this.resolveSpeech();
    for (const [person, event] of this.notices) if (!person.removed) this.emit(person, event);
    this.notices = [];
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
