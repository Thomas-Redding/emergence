import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { basicNpc } from "../npcs/basic.js";
import { forager, foragerNoWaste, makeForager } from "../npcs/forager.js";
import { runOne, scalars } from "../tools/harness.mjs";

// A meadow with one NPC facing south, a deer well in view ahead, and whatever the test gives it.
function scene(brain, { food, items = [], deer = true }) {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  const a = s.addActor(brain, 40, 40);
  a.food = food;
  for (const kind of items) { const e = s.spawn(kind, a.x, a.y, kind === "spear" ? { sharpness: 200 } : { cook: 60 }); e.holder = a.id; }
  if (deer) s.spawn("deer", a.x, a.y + 6, { facing: [0, 1], age: 5000, energy: 1000, lifespan: 1e9, breedCooldown: 0, grazing: false, target: null });
  return { s, a };
}
const firstAction = (brain, opts) => {
  const { s, a } = scene(brain, opts);
  s.step();
  return a.lastResult.action;
};

test("observations tell a brain the rules it needs (a meal's value)", () => {
  const { s, a } = scene(function* () {}, { food: 900 });
  const obs = s.observe(a.id);
  assert.equal(obs.rules.mealFood, 500);
  assert.equal(obs.rules.foodPerTick, 0.5);
  assert.equal(obs.self.foodMax, 1000);
});

test("eating: basic eats at food 700 and wastes half the meal; the forager waits until a meal fits", () => {
  const items = ["spear", "cooked_meat"];
  assert.equal(firstAction(basicNpc, { food: 700, items, deer: false }), "eat", "basic: food < 800");
  assert.equal(firstAction(forager, { food: 700, items, deer: false }), "wait", "forager: only 300 would be used");
  assert.equal(firstAction(forager, { food: 500, items, deer: false }), "eat", "a meal exactly fits at 500");
  assert.equal(firstAction(forager, { food: 120, items, deer: false }), "eat");
});

test("hunting: basic hunts at food 850 even with cooked meat in the pack; the forager doesn't", () => {
  const items = ["spear", "cooked_meat"];
  assert.equal(firstAction(basicNpc, { food: 850, items }), "move", "basic sets off after the deer");
  assert.equal(firstAction(forager, { food: 850, items }), "wait", "850 + a 500 meal is well above the reserve");
});

test("the forager does hunt when its reserve is low, and only then", () => {
  assert.equal(firstAction(forager, { food: 800, items: ["spear"] }), "move", "800 in the belly, nothing in the pack: below 2 meals");
  assert.equal(firstAction(forager, { food: 1000, items: ["spear"] }), "wait", "full stomach = 2 meals of energy: no need");
  assert.equal(firstAction(forager, { food: 600, items: ["spear", "cooked_meat"] }), "wait", "600 + 500 = 1100 >= 1000");
  assert.equal(firstAction(forager, { food: 400, items: ["spear", "cooked_meat"] }), "eat", "hungry enough that the meal fits: eat first");
});

test("variants isolate their changes: 'no-waste' keeps basic's hunting gate", () => {
  const items = ["spear", "cooked_meat"];
  assert.equal(firstAction(foragerNoWaste, { food: 850, items }), "move", "legacy gate: hunts below 900");
  assert.notEqual(firstAction(foragerNoWaste, { food: 700, items, deer: false }), "eat", "but doesn't waste the meal (it goes looking for deer instead)");
  assert.equal(firstAction(foragerNoWaste, { food: 450, items, deer: false }), "eat", "and eats once the meal fits");
  const r3 = makeForager({ reserve: 3 });
  assert.equal(firstAction(r3, { food: 850, items }), "move", "a bigger reserve keeps hunting: 850 + 500 < 1500");
});

// The point of all this, end to end but small: at a few NPCs each, the forager eats what it needs and no more.
test("the forager kills about what it eats, and about what it needs; basic overhunts", () => {
  const cfg = { ticks: 6000, npcs: 4 };
  const runs = (brain) => [1, 2, 3].map((seed) => scalars(runOne({ ...cfg, brains: [{ name: "x", fn: brain }] }, seed)));
  const f = runs(forager), b = runs(basicNpc);
  const avg = (rows, k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  assert.ok(avg(f, "mealsPer1000") < 1.15, `forager eats ${avg(f, "mealsPer1000").toFixed(2)} meals per 1000 ticks (needs 1.0)`);
  assert.ok(avg(b, "mealsPer1000") > 1.4, `basic eats ${avg(b, "mealsPer1000").toFixed(2)} per 1000: it wastes food`);
  assert.equal(avg(f, "survival"), 1, "and nobody starves");
  assert.ok(avg(f, "herdMean") > avg(b, "herdMean"), "leaving a bigger herd behind");
});
