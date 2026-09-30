import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import * as C from "../sim/constants.js";
import { foragerFamily } from "../npcs/forager.js";

const meadow = (seed = 1) => {
  const s = new Sim({ seed });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  return s;
};
const idle = function* () { for (;;) yield { type: "wait" }; };

test("every person is assigned a sex at birth, deterministically, and it can be overridden", () => {
  const roll = (seed, n) => { const s = meadow(seed); return Array.from({ length: n }, (_, i) => s.addActor(idle, 20 + i * 2, 20).sex); };
  const a = roll(1, 30), b = roll(1, 30);
  assert.deepEqual(a, b, "same seed, same sexes");
  assert.ok(a.every((s) => s === "male" || s === "female"));
  assert.ok(a.includes("male") && a.includes("female"), "a mix, over 30 people");
  assert.notDeepEqual(roll(2, 30), a, "and depend on the seed");
  const s = meadow();
  assert.equal(s.addActor(idle, 40, 40, { sex: "female" }).sex, "female");
});

test("adding people's sex doesn't perturb the sim's own random stream", () => {
  const a = new Sim({ seed: 9 }), b = new Sim({ seed: 9 });
  for (let i = 0; i < 10; i++) a.addActor(idle, 20 + i * 4, 30);
  for (let i = 0; i < 5; i++) assert.equal(a.rng.next(), b.rng.next());
});

test("a mate proposal between two people of the same sex is refused as invalid", () => {
  const s = meadow();
  const a = s.addActor(idle, 40, 40, { sex: "male" }), b = s.addActor(idle, 40, 42, { sex: "male" });
  assert.deepEqual(s.mate(a, b), { ok: false, reason: "same_sex" });
  assert.equal(s.stats.births, 0);
  b.sex = "female";
  assert.deepEqual(s.mate(a, b), { ok: true });
});

test("same-sex is checked after the ordinary per-person conditions, so the more basic reason wins", () => {
  const s = meadow();
  const a = s.addActor(idle, 40, 40, { sex: "male", age: 100 }), b = s.addActor(idle, 40, 42, { sex: "male" });
  assert.equal(s.mate(a, b).reason, "proposer_child", "too young is reported before same_sex");
});

test("sex is exposed in observations, for yourself and others in view", () => {
  const s = meadow();
  const a = s.addActor(idle, 40, 40, { sex: "male" });
  const b = s.addActor(idle, 40, 42, { sex: "female" });
  const obs = s.observe(a.id);
  assert.equal(obs.self.sex, "male");
  assert.equal(obs.view.entities.find((e) => e.id === b.id).sex, "female");
});

test("sex is part of the state hash", () => {
  const make = (sex) => { const s = meadow(); s.addActor(idle, 40, 40, { sex }); return s; };
  assert.equal(hashState(make("male")), hashState(make("male")));
  assert.notEqual(hashState(make("male")), hashState(make("female")));
});

test("deer breeding needs an opposite-sex partner within range, and only the female bears the fawn", () => {
  const s = meadow();
  s.world.grassCap.fill(C.GRASS_CAP_PLAINS);
  s.world.grassGrowth.fill(0);
  s.grass.fill(C.GRASS_CAP_PLAINS);
  const spawn = (x, y, sex) => s.spawnDeer(x + 0.5, y + 0.5, { age: C.DEER_FAWN_TICKS + 100, energy: 1000, sex });
  // two males: never breeds
  let d1 = spawn(40, 40, "male"), d2 = spawn(41, 40, "male");
  d1.lifespan = d2.lifespan = 1e9;
  for (let t = 0; t < 3000; t++) { d1.energy = d2.energy = 1000; s.step(); }
  assert.equal(s.stats.deerBorn, 0, "two bucks can't have a fawn");

  s.entities = []; s.byIdMap.clear();
  // a male and a female: breeds
  const buck = spawn(40, 40, "male"), doe = spawn(41, 40, "female");
  buck.lifespan = doe.lifespan = 1e9;
  for (let t = 0; t < 3000 && s.stats.deerBorn === 0; t++) { buck.energy = doe.energy = 1000; s.step(); }
  assert.ok(s.stats.deerBorn >= 1, "a buck and a doe can");
  assert.ok(doe.breedCooldown > 0, "the doe paid the cost / is on cooldown");
});

test("the family forager only proposes to, and accepts, the opposite sex", () => {
  const stock = (s, p) => {
    p.food = 1000;
    const e = s.spawn("spear", p.x, p.y, { sharpness: 200 });
    e.holder = p.id;
    for (let i = 0; i < 2; i++) { const m = s.spawn("cooked_meat", p.x, p.y, { cook: 60 }); m.holder = p.id; }
  };
  // same-sex pair: no births, no accepted proposals, for a good long while
  let s = meadow();
  const a = s.addActor(foragerFamily, 40, 40, { sex: "male" }), b = s.addActor(foragerFamily, 41, 40, { sex: "male" });
  stock(s, a); stock(s, b);
  s.run(1500);
  assert.equal(s.stats.births, 0, "two men: nothing happens");

  // opposite-sex pair, otherwise identical: has a child
  s = meadow();
  const c = s.addActor(foragerFamily, 40, 40, { sex: "male" }), d = s.addActor(foragerFamily, 41, 40, { sex: "female" });
  stock(s, c); stock(s, d);
  s.run(1500);
  assert.ok(s.stats.births >= 1, "a man and a woman: a child");
});
