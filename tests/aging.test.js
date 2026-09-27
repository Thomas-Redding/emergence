import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import * as C from "../sim/constants.js";
import { forager } from "../npcs/forager.js";
import { idle } from "../npcs/idle.js";
import { runOne, scalars, worstSeeds } from "../tools/harness.mjs";
import { buildHud } from "../ui/inventory.js";

const meadow = (opts = {}) => {
  const s = new Sim({ seed: 1, ...opts });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  return s;
};

test("people start as fresh adults by default, and their age advances one per tick", () => {
  const s = meadow();
  const a = s.addActor(idle, 40, 40);
  assert.equal(s.tick - a.born, C.HUMAN_ADULT_TICKS);
  const first = s.observe(a.id).self.age;
  s.run(50);
  assert.equal(s.observe(a.id).self.age, first + 50);
  const kid = s.addActor(idle, 44, 40, { age: 100 });
  assert.equal(s.observe(kid.id).self.age, 100);
});

test("lifespans are rolled per person within the range, differ, and are deterministic", () => {
  const roll = (seed, n) => {
    const s = new Sim({ seed });
    return Array.from({ length: n }, (_, i) => s.addActor(idle, 20 + i * 2, 20).lifespan);
  };
  const a = roll(3, 30), b = roll(3, 30);
  assert.deepEqual(a, b, "same seed, same lifespans");
  assert.ok(a.every((l) => l >= C.HUMAN_LIFESPAN_MIN && l < C.HUMAN_LIFESPAN_MIN + C.HUMAN_LIFESPAN_SPREAD));
  assert.ok(new Set(a).size > 25, "they differ");
  assert.notDeepEqual(roll(4, 30), a, "and depend on the seed");
});

test("adding people does not disturb the random stream that drives the world", () => {
  const a = new Sim({ seed: 7 }), b = new Sim({ seed: 7 });
  for (let i = 0; i < 12; i++) a.addActor(idle, 20 + i * 4, 30); // rolls twelve lifespans
  for (let i = 0; i < 5; i++) assert.equal(a.rng.next(), b.rng.next(), "the sim's own stream is untouched");
});

test("old age kills at the lifespan, drops what they carried, and is counted separately from starvation", () => {
  const s = meadow();
  const a = s.addActor(idle, 40, 40, { age: 0, lifespan: 100 });
  a.food = 5000; // not hungry
  const spear = s.spawn("spear", a.x, a.y, { sharpness: 200 });
  spear.holder = a.id;
  s.run(100);
  assert.equal(a.removed, undefined, "still alive at age 99...");
  s.step();
  assert.equal(a.removed, true, "...dead at age 100");
  assert.equal(a.cause, "old_age");
  assert.equal(a.diedAt, 100);
  assert.deepEqual([s.stats.deaths, s.stats.deathsOld, s.stats.deathsStarved], [1, 1, 0]);
  assert.equal(spear.holder, null, "the spear is on the ground");
  assert.deepEqual([spear.x, spear.y], [a.x, a.y], "where they fell");
});

test("starvation is recorded as its own cause, and wins if both happen on the same tick", () => {
  const s = meadow();
  const a = s.addActor(idle, 40, 40);
  s.run(2100);
  assert.equal(a.cause, "starvation");
  assert.deepEqual([s.stats.deaths, s.stats.deathsStarved, s.stats.deathsOld], [1, 1, 0]);

  const t = meadow();
  const b = t.addActor(idle, 40, 40, { age: 0, lifespan: 1998 }); // starves at tick 1998 too
  t.run(2100);
  assert.equal(b.cause, "starvation");
});

test("brains see their own age, the rules, and whether others are adults", () => {
  const s = meadow();
  const seen = [];
  const me = s.addActor(function* (obs) { for (;;) { seen.push(obs); obs = yield { type: "wait" }; } }, 40, 40);
  const adult = s.addActor(idle, 40, 44, { age: C.HUMAN_ADULT_TICKS });
  const child = s.addActor(idle, 41, 44, { age: C.HUMAN_ADULT_TICKS - 1 });
  const flags = () => Object.fromEntries(s.observe(me.id).view.entities.filter((e) => e.kind === "human").map((e) => [e.id, e.adult]));
  assert.equal(flags()[adult.id], true);
  assert.equal(flags()[child.id], false, "one tick short of adulthood");
  s.step();
  const o = seen[0];
  assert.equal(o.self.age, C.HUMAN_ADULT_TICKS);
  assert.equal(o.rules.adultAge, C.HUMAN_ADULT_TICKS);
  assert.deepEqual(o.rules.lifespan, [C.HUMAN_LIFESPAN_MIN, C.HUMAN_LIFESPAN_MIN + C.HUMAN_LIFESPAN_SPREAD - 1]);
  assert.equal(o.self.lifespan, undefined, "nobody, themselves included, knows their own lifespan");
  assert.equal(flags()[child.id], true, "and an adult a tick later");
  assert.equal(s.observe(me.id).view.entities.find((e) => e.id === adult.id).lifespan, undefined, "others' lifespans are hidden too");
});

test("age and lifespan are part of the state hash, and aging is deterministic", () => {
  const make = (lifespan) => { const s = meadow(); s.addActor(idle, 40, 40, { lifespan }); return s; };
  assert.equal(hashState(make(9000)), hashState(make(9000)));
  assert.notEqual(hashState(make(9000)), hashState(make(9001)));
  const run = () => { const s = new Sim({ seed: 2, humanLifespanMin: 3000, humanLifespanSpread: 2000 }); for (let i = 0; i < 4; i++) s.addActor(forager, 30 + i * 12, 40); s.run(9000); return s; };
  const a = run(), b = run();
  assert.equal(hashState(a), hashState(b));
  assert.equal(a.stats.deathsOld, 4, "with lifespans this short everyone has died of old age by 9000 ticks");
});

test("the HUD shows a character's age as game time, and whether they are still a child", () => {
  const obs = (age) => ({ reach: {}, rules: { adultAge: 4000 }, self: { age, food: 500, foodMax: 1000, facing: [0, 1], x: 1, y: 1, inventory: [] }, view: { entities: [] } });
  assert.deepEqual(buildHud(obs(20 * 125), { isPlayer: false }).age, { ticks: 2500, adult: false, text: "2:05" });
  assert.equal(buildHud(obs(4000), { isPlayer: false }).age.adult, true);
  assert.equal(buildHud(obs(20 * 3600 + 20 * 7), { isPlayer: false }).age.text, "60:07");
});

test("benchmarks: old age is not a brain failing; starvation is", () => {
  // a fed NPC and a lifespan that ends at tick 2000 (age = 4000 + tick): it dies of old age, not failure
  const opts = { humanLifespanMin: 6000, humanLifespanSpread: 1 };
  const fed = runOne({ ticks: 3000, npcs: 1, brains: [{ name: "f", fn: forager }], sim: opts }, 1);
  assert.equal(fed.npcs[0].cause, "old_age");
  assert.equal(fed.npcs[0].diedAt, 2000);
  const sf = scalars(fed);
  assert.equal(sf.survival, 1, "did not starve");
  assert.equal(sf.oldAge, 1);
  assert.equal(sf.lifetime, 1, "counts as having lived the whole run");
  assert.ok(sf.mealsPer1000 > 0, "rates are still per tick actually alive");
  assert.deepEqual(worstSeeds({ runs: [fed] }), [], "and it isn't a 'worst seed'");

  const starving = runOne({ ticks: 3000, npcs: 1, brains: [{ name: "i", fn: idle }], sim: opts }, 1);
  assert.equal(starving.npcs[0].cause, "starvation", "the idle brain starves at ~1998, before old age at 2000");
  const si = scalars(starving);
  assert.equal(si.survival, 0);
  assert.equal(si.oldAge, 0);
  assert.ok(si.lifetime < 0.7);
  assert.equal(worstSeeds({ runs: [starving] }).length, 1);
});
