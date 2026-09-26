// Baseline NPC: make a spear, hunt a deer, build a fire, cook the meat, eat it.
import { dist, held, around, nearest, walkNear, explore, facingToward, withMemory } from "./lib.js";

// `mem` is the NPC's own memory (unreachable ids, where it built its fire): plain generator-local state.
// It has to remember, because it only ever sees what's in front of it.
function* getSticks(obs, rng, count, mem) {
  while (held(obs, "stick").length < count) {
    const s = nearest(obs, around(obs, "stick").filter((e) => !mem.bad.has(e.id)));
    if (!s) { obs = yield* explore(obs, rng, 24, (o) => around(o, "stick").some((e) => !mem.bad.has(e.id))); continue; }
    obs = yield* walkNear(obs, s.x, s.y, { within: obs.reach.pickup * 0.9 });
    obs = yield { type: "pickup", item: s.id };
    if (!obs.lastResult.ok) { mem.bad.add(s.id); obs = yield* explore(obs, rng, 12); } // unreachable: try elsewhere
  }
  return obs;
}

function* makeSpear(obs, rng, mem) {
  obs = yield* getSticks(obs, rng, 1, mem);
  // Commit to one stick (most progressed) so partial work is never split across sticks.
  const stick = held(obs, "stick").reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
  const id = stick.id;
  while (obs.self.inventory.some((e) => e.id === id && e.kind === "stick")) {
    obs = yield { type: "sharpen", item: id };
  }
  return obs;
}

function* hunt(obs, rng) {
  const deer = nearest(obs, around(obs, "deer"));
  if (!deer) return yield* explore(obs, rng, 24, (o) => around(o, "deer").length > 0);
  const id = deer.id;
  let last = { x: deer.x, y: deer.y };
  for (let i = 0; i < 200; i++) {
    let d = around(obs, "deer").find((e) => e.id === id);
    if (!d) {
      // Out of my cone: turn toward where it was, and look again.
      if (facingToward(obs, last.x, last.y)) return obs; // already looking there: it's gone
      obs = yield { type: "face", dx: last.x - obs.self.x, dy: last.y - obs.self.y };
      d = around(obs, "deer").find((e) => e.id === id);
      if (!d) return obs;
    }
    last = { x: d.x, y: d.y };
    if (dist(obs.self, d) <= obs.reach.stab) {
      if (!facingToward(obs, d.x, d.y, obs.reach.stabFacingCos + 0.2)) { // must face it to stab
        obs = yield { type: "face", dx: d.x - obs.self.x, dy: d.y - obs.self.y };
        continue;
      }
      obs = yield { type: "stab", target: id };
      if (obs.lastResult.ok) return obs;
    } else {
      const before = obs.tick;
      obs = yield* walkNear(obs, d.x, d.y, { within: obs.reach.stab * 0.9, sneak: dist(obs.self, d) <= 8, maxTicks: 1 });
      if (obs.tick === before) return yield* explore(obs, rng, 12); // unreachable: never spin without yielding
    }
  }
  return obs;
}

function* cook(obs, rng, mem) {
  const meatId = held(obs, "raw_meat")[0].id;
  if (!mem.fire) {
    const seen = nearest(obs, around(obs, "fire"));
    if (seen) mem.fire = { id: seen.id, x: seen.x, y: seen.y };
  }
  if (!mem.fire) {
    obs = yield* getSticks(obs, rng, 2, mem);
    const [a, b] = held(obs, "stick");
    obs = yield { type: "make_fire", items: [a.id, b.id] };
    const built = nearest(obs, around(obs, "fire"));
    if (!built) return obs;
    mem.fire = { id: built.id, x: built.x, y: built.y };
  }
  const { id: fid, x, y } = mem.fire;
  obs = yield* walkNear(obs, x, y, { within: obs.reach.fire * 0.9 });
  // Within 1 tile I always see it: if it's gone, it burned out.
  if (!around(obs, "fire").some((f) => f.id === fid)) { mem.fire = null; return obs; }
  while (around(obs, "fire").some((f) => f.id === fid && !f.lit)) {
    obs = yield { type: "tend", item: fid };
  }
  while (obs.self.inventory.some((e) => e.id === meatId && e.kind === "raw_meat") &&
         around(obs, "fire").some((f) => f.id === fid && f.lit)) {
    obs = yield { type: "cook", item: meatId, fire: fid };
  }
  return obs;
}

function* basicBrain(obs, rng) {
  const mem = { bad: new Set(), fire: null };
  while (true) {
    const cooked = held(obs, "cooked_meat")[0];
    const raw = held(obs, "raw_meat")[0];
    const groundMeat = nearest(obs, around(obs, "raw_meat").filter((e) => !mem.bad.has(e.id)));
    if (cooked && obs.self.food < 800) {
      obs = yield { type: "eat", item: cooked.id };
    } else if (raw) {
      obs = yield* cook(obs, rng, mem);
    } else if (groundMeat) {
      obs = yield* walkNear(obs, groundMeat.x, groundMeat.y, { within: obs.reach.pickup * 0.9 });
      obs = yield { type: "pickup", item: groundMeat.id };
      if (!obs.lastResult.ok) { mem.bad.add(groundMeat.id); obs = yield* explore(obs, rng, 12); }
    } else if (held(obs, "stick").length < 2 && nearest(obs, around(obs, "stick").filter((e) => !mem.bad.has(e.id) && dist(obs.self, e) < 8))) {
      // Keep two spare sticks on hand (for the next fire) whenever some are close by.
      obs = yield* getSticks(obs, rng, held(obs, "stick").length + 1, mem);
    } else if (!held(obs, "spear").length) {
      obs = yield* makeSpear(obs, rng, mem);
    } else if (obs.self.food < 900) {
      obs = yield* hunt(obs, rng);
    } else {
      obs = yield { type: "wait" };
    }
  }
}

// The baseline NPC: the brain above, with terrain memory so it doesn't forget what it just saw.
export const basicNpc = withMemory(basicBrain);
