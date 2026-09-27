import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import * as C from "../sim/constants.js";
import { forager, foragerFamily } from "../npcs/forager.js";
import { loadBrain } from "../tools/harness.mjs";

// An open meadow with no deer (so nobody needs to hunt), and adults who are already well stocked.
function meadow(seed = 1) {
  const s = new Sim({ seed });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  return s;
}
const stock = (s, p, { spear = true, meals = 2, food = 1000 } = {}) => {
  p.food = food;
  const carry = (kind, extra) => { const e = s.spawn(kind, p.x, p.y, extra); e.holder = p.id; return e; };
  if (spear) carry("spear", { sharpness: 200 });
  for (let i = 0; i < meals; i++) carry("cooked_meat", { cook: 60 });
};
const couple = ({ seed = 1, brain = foragerFamily, apart = 3 } = {}) => {
  const s = meadow(seed);
  const a = s.addActor(brain, 40, 40), b = s.addActor(brain, 40, 40 + apart);
  stock(s, a); stock(s, b);
  return { s, a, b };
};
const kidsOf = (s) => s.entities.filter((e) => e.kind === "human" && e.parents);

test("the family forager loads by name", async () => {
  const b = await loadBrain("forager-family");
  assert.equal(b.name, "forager-family");
  assert.equal(typeof b.fn, "function");
});

test("two well-stocked adults who can see each other agree to have a child", () => {
  const { s, a, b } = couple();
  s.run(300);
  assert.ok(s.stats.births >= 1, `births: ${s.stats.births}`);
  const [kid] = kidsOf(s);
  assert.deepEqual(kid.parents, [a.id, b.id]);
  assert.equal(kid.generation, 1);
  assert.ok(a.birthCooldown > 0 && b.birthCooldown > 0, "both paid");
  assert.equal(s.stats.births, 1, "just the one: the cooldown and 'one growing child' stop a second");
});

test("the plain forager never asks and never agrees", () => {
  const { s } = couple({ brain: forager });
  s.run(600);
  assert.equal(s.stats.births, 0);
});

test("parents feed the child, which grows without ever starving", () => {
  const { s } = couple();
  s.run(300);
  const [kid] = kidsOf(s);
  assert.ok(kid, "a child was born");
  const alive = () => !kid.removed;
  for (let t = 0; t < 2000; t++) {
    s.step();
    assert.ok(alive(), `the child died at tick ${s.tick}`);
    for (const p of s.entities.filter((e) => e.kind === "human" && !e.parents)) p.food = Math.max(p.food, 700); // (the adults' own hunger is not what is being tested)
  }
  assert.equal(s.stats.childStarved, 0);
  assert.ok(kid.tally.meals >= 1, `the child ate ${kid.tally.meals} meals that its parents gave it`);
  assert.ok(kid.food > 200, `child food ${kid.food}`);
});

test("a child never tries to hunt, and stays close to parents who stay put", () => {
  const { s, a, b } = couple({ apart: 2 });
  for (const p of [a, b]) stock(s, p, { meals: 4 }); // plenty in the pack: they have no reason to go off hunting
  s.run(300);
  const [kid] = kidsOf(s);
  let tooYoung = 0, maxAway = 0;
  for (let t = 0; t < 600; t++) {
    s.step();
    if (kid.lastResult.reason === "too_young") tooYoung++;
    if (t > 40) maxAway = Math.max(maxAway, Math.min(Math.hypot(kid.x - a.x, kid.y - a.y), Math.hypot(kid.x - b.x, kid.y - b.y)));
    a.food = b.food = Math.max(a.food, 700);
  }
  assert.equal(tooYoung, 0, "it doesn't try to stab");
  assert.equal(kid.tally.kills, 0);
  assert.ok(maxAway < 6, `it wandered ${maxAway.toFixed(1)} tiles from its nearest parent`);
});

test("a child that loses its parents turns round to look for them before it wanders off", () => {
  const { s, a, b } = couple({ apart: 2 });
  for (const p of [a, b]) stock(s, p, { meals: 4 });
  s.run(300);
  const [kid] = kidsOf(s);
  s.run(20);
  // the parents are now 7 tiles BEHIND the child, where its forward view can't see them
  const back = { x: kid.x, y: kid.y - 7 };
  a.x = back.x; a.y = back.y; b.x = back.x; b.y = back.y + 0.6;
  kid.facing = [0, 1];
  const start = [kid.x, kid.y];
  let found = null;
  for (let t = 0; t < 40 && found === null; t++) {
    s.step();
    a.food = b.food = 1000;
    if (s.observe(kid.id).view.entities.some((e) => e.id === a.id || e.id === b.id)) found = t;
  }
  assert.ok(found !== null && found < 30, `it saw them again after ${found} ticks`);
  assert.ok(Math.abs(kid.x - start[0]) + Math.abs(kid.y - start[1]) < 1.5, "by turning round, not by wandering off");
});

test("a child takes over its parent's whole life at adulthood: it is a forager like its parents", () => {
  const { s } = couple();
  s.run(300);
  const [kid] = kidsOf(s);
  kid.born = s.tick - C.HUMAN_ADULT_TICKS + 20; // nearly grown
  kid.food = 1000;
  s.run(40);
  assert.ok(s.tick - kid.born >= C.HUMAN_ADULT_TICKS);
  assert.equal(s.brains.get(kid.id).fn, s.brains.get(kidsOf(s)[0].parents[0]).fn, "the same brain");
  assert.equal(s.observe(kid.id).view.entities.length >= 0, true);
});

test("someone with a growing child keeps a spare meal for it when deciding whether to hunt", () => {
  const firstAction = (brain, { withChild }) => {
    const s = meadow();
    const a = s.addActor(brain, 40, 40), b = s.addActor(brain, 41, 40);
    stock(s, a, { meals: 1, food: 900 }); // 900 + 500 = 1400 energy on hand: above the plain 2-meal reserve (1000)
    stock(s, b, { meals: 1, food: 900 });
    if (withChild) { s.run(1); s.tick -= 1; s.mate(a, b); s.tick += 1; } // (a child, born the way a real birth happens)
    a.food = 900;
    s.spawnDeer(a.x, a.y + 5, { age: 5000, energy: 1000 }); // a deer in view, in front
    s.run(3);
    return a.lastResult.action;
  };
  // with a dependent child: the reserve grows by a meal (3 total = 1500), so 1400 isn't enough yet: it hunts
  const withChild = firstAction(foragerFamily, { withChild: true });
  assert.ok(["move", "stab", "face"].includes(withChild), `with a dependent child (1400 < 3 meals): it hunts (${withChild})`);
});

// Regression: an earlier version raised the hunting target for EVERY childless, cooldown-free adult up to
// mateReserve (not just the plain 2-meal reserve) the moment it became merely eligible to have a child, long
// before it actually wanted one. Since nearly the whole adult population is "eligible" nearly all the time,
// that meant almost everyone hunted for a permanent surplus at once — which crashed the deer herd on its
// own, before any child was ever born. Wanting a child must stay opportunistic: a side effect of sometimes
// having more than you need, not something everyone is constantly grinding toward.
test("an eligible-but-childless adult with the ordinary 2-meal reserve doesn't go on hunting toward mateReserve", () => {
  // food + one held meal = 1100: past the plain reserve (1000, so it should be content) but short of
  // mateReserve (1300, so under the old bug it would still have gone hunting for more).
  const firstAction = (food) => {
    const s = meadow();
    const a = s.addActor(foragerFamily, 40, 40);
    stock(s, a, { meals: 1, food }); // already has a spear (stock()'s default) and two spare sticks
    s.spawnDeer(a.x, a.y + 3, { age: 5000, energy: 1000, facing: [0, 1] }); // right there, facing away: an easy, tempting kill
    s.run(2);
    return a.lastResult;
  };
  const r = firstAction(600); // 600 + 500 = 1100
  assert.notEqual(r.action, "stab", `went for the easy kill at 1100 energy, past the ordinary reserve: ${JSON.stringify(r)}`);
  assert.notEqual(r.action, "move", `walked toward it at 1100 energy: ${JSON.stringify(r)}`);
});

test("it turns down a proposal it doesn't want, saying so, and never freezes waiting for it", () => {
  const s = meadow();
  const a = s.addActor(foragerFamily, 40, 40);
  const seen = [];
  const asker = s.addActor(function* (obs) {
    for (;;) { seen.push(obs); obs = yield obs.tick === 0 ? { type: "wait", propose: { to: a.id, kind: "mate" } } : { type: "wait" }; }
  }, 40, 42);
  asker.facing = [0, -1];
  stock(s, a, { food: 300, meals: 0, spear: false }); // hungry and empty-handed: doesn't want a child
  s.run(30);
  assert.equal(s.tick, 30, "the sim kept running");
  const result = seen.flatMap((o) => o.events).find((e) => e.type === "proposal_result");
  assert.equal(result.outcome, "declined");
  assert.equal(s.stats.births, 0);
});

test("it accepts one it does want, without stopping what it was doing", () => {
  const s = meadow();
  const a = s.addActor(foragerFamily, 40, 40);
  const asker = s.addActor(function* (obs) {
    for (;;) obs = yield obs.tick === 0 ? { type: "wait", propose: { to: a.id, kind: "mate" } } : { type: "wait" };
  }, 40, 42);
  asker.facing = [0, -1];
  stock(s, a); stock(s, asker);
  s.run(10);
  assert.equal(s.stats.births, 1);
});

test("a family of foragers is deterministic", () => {
  const run = () => { const { s } = couple({ seed: 5 }); s.run(1500); return s; };
  const x = run(), y = run();
  assert.equal(hashState(x), hashState(y));
  assert.equal(x.stats.births, y.stats.births);
});
