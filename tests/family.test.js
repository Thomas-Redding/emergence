import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import * as C from "../sim/constants.js";
import { moveToward, withFamily, withChildhood, dist } from "../npcs/lib.js";

const meadow = (seed = 1) => {
  const s = new Sim({ seed });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  return s;
};
// A brain that does whatever `act(obs)` says (default: wait) and records every observation it gets.
const scripted = (log, act = () => null) => function* (obs) { for (;;) { log.push(obs); obs = yield act(obs) ?? { type: "wait" }; } };
const feed = (a) => { a.food = 1000; };
// A child inherits its parent's brain, and these test brains share a log, so pick out one person's observations.
const lastFor = (log, who) => log.filter((o) => o.self.id === who.id).at(-1);
// Have a child, the way a real birth happens: at the END of a tick (so the notice reaches the parents next tick).
const mateAtEndOfTick = (s, a, b) => {
  if (s.tick < 1) s.step(); // (at tick -1 the founders would be a tick short of adulthood)
  s.tick -= 1;
  const r = s.mate(a, b);
  s.tick += 1;
  return r;
};

test("moveToward gives one step toward a point, or null when there is nothing to do", () => {
  const s = meadow();
  const a = s.addActor(scripted([]), 40, 40);
  const obs = () => s.observe(a.id);
  const step = moveToward(obs(), 40.5, 45.5);
  assert.equal(step.type, "move");
  assert.ok(step.dy > 0 && Math.abs(step.dx) < 1e-9, "straight south");
  assert.equal(moveToward(obs(), 40.5, 40.9), null, "already within reach of it");
  assert.equal(moveToward(obs(), 40.5, 45.5, { within: 6 }), null, "and within a wider reach");
  assert.equal(moveToward(obs(), 40.5, 45.5, { sneak: true }).sneak, true);
});

test("withFamily: an adult learns of a birth, and its estimate of the child's food tracks the truth", () => {
  const s = meadow();
  const logA = [], logB = [];
  const a = s.addActor(withFamily(scripted(logA)), 40, 40, { sex: "male" }), b = s.addActor(withFamily(scripted(logB)), 40, 42, { sex: "female" });
  s.run(3);
  assert.deepEqual(logA[2].family.kids, [], "no children yet");
  assert.deepEqual(mateAtEndOfTick(s, a, b), { ok: true });
  const kid = a.children.map((id) => s.byId(id))[0];
  s.run(2);
  const seen = lastFor(logA, a).family;
  assert.equal(seen.kids.length, 1);
  assert.equal(seen.kids[0].id, kid.id);
  assert.equal(seen.kids[0].bornTick, kid.born, "born when the sim says");
  assert.equal(seen.lastBirthTick, kid.born);
  assert.equal(seen.kids[0].dependent, true);
  assert.deepEqual(lastFor(logB, b).family.kids.map((k) => k.id), [kid.id], "both parents know");
  for (let i = 0; i < 100; i++) {
    s.step();
    const est = lastFor(logA, a).family.kids[0].foodEst;
    assert.ok(Math.abs(est - kid.food) <= 1.6, `estimate ${est} vs actual ${kid.food}`);
  }
});

test("withFamily: a gift of cooked meat raises the estimate by a meal; the child, run by the same brain, eats it", () => {
  const s = meadow();
  const logA = [];
  let handOver = false;
  const parentBrain = (log) => withFamily(scripted(log, (obs) => {
    const meal = obs.self.inventory.find((i) => i.kind === "cooked_meat");
    const kid = obs.family.kids[0];
    return handOver && meal && kid ? { type: "give", item: meal.id, to: kid.id } : null;
  }));
  const a = s.addActor(withChildhood(parentBrain(logA)), 40, 40, { sex: "male" }), b = s.addActor(withChildhood(parentBrain([])), 40, 42, { sex: "female" });
  mateAtEndOfTick(s, a, b);
  const kid = s.byId(a.children[0]);
  s.run(2);
  const meat = s.spawn("cooked_meat", a.x, a.y, { cook: 60 });
  meat.holder = a.id;
  const before = lastFor(logA, a).family.kids[0].foodEst;
  kid.x = a.x; kid.y = a.y + 1; // next to the parent
  handOver = true;
  s.run(3);
  handOver = false;
  const after = lastFor(logA, a).family.kids[0];
  assert.ok(after.foodEst > before + 400, `estimate went from ${before.toFixed(0)} to ${after.foodEst.toFixed(0)}`);
  assert.ok(after.lastFedTick > 0);
  s.run(3);
  assert.equal(meat.removed, true, "the child ate the meat it was given");
  assert.ok(kid.food > 900, `child food ${kid.food}`);
  assert.ok(Math.abs(lastFor(logA, a).family.kids[0].foodEst - kid.food) < 5, "and the estimate is still about right");
});

test("withFamily: children stop being dependent at adulthood, and are forgotten if they die", () => {
  const s = meadow();
  const logA = [];
  const a = s.addActor(withFamily(scripted(logA)), 40, 40, { sex: "male" }), b = s.addActor(withFamily(scripted([])), 40, 42, { sex: "female" });
  mateAtEndOfTick(s, a, b);
  const kid = s.byId(a.children[0]);
  s.run(2);
  assert.equal(lastFor(logA, a).family.kids[0].dependent, true);
  kid.born -= C.HUMAN_ADULT_TICKS - 5; // nearly grown
  const bornTick = lastFor(logA, a).family.kids[0].bornTick;
  assert.equal(bornTick, kid.born + C.HUMAN_ADULT_TICKS - 5, "(the parent still counts from the real birth)");
  s.run(3);
  assert.equal(lastFor(logA, a).family.kids[0].dependent, true);
  s.step(); // the parent's own count reaches adulthood after HUMAN_ADULT_TICKS since the birth
  a.food = b.food = 1000;
  for (let i = 0; i < C.HUMAN_ADULT_TICKS; i++) { feed(a); feed(b); kid.food = 1000; s.step(); }
  assert.equal(lastFor(logA, a).family.kids[0].dependent, false, "grown up");
  s.killPerson(kid, "starvation");
  s.step();
  assert.deepEqual(lastFor(logA, a).family.kids, [], "a dead child is dropped");
});

test("withFamily: remembers who it has seen, and where and when", () => {
  const s = meadow();
  const log = [];
  s.addActor(withFamily(scripted(log)), 40, 40);
  const other = s.addActor(scripted([]), 40, 43);
  s.run(3);
  const p = log.at(-1).family.people[other.id];
  assert.ok(p, "saw them");
  assert.equal(p.adult, true);
  assert.equal(p.tick, log.at(-1).tick);
  assert.ok(Math.abs(p.y - other.y) < 1e-9);
  other.y += 20; // out of sight now
  s.run(3);
  const later = log.at(-1).family.people[other.id];
  assert.ok(later.tick < log.at(-1).tick, "the memory keeps when it was last seen");
});

test("withFamily: a reply rides along on whatever action the brain takes, unless that action already speaks", () => {
  const answer = (obs) => { const inc = obs.proposals.incoming[0]; return inc ? { to: inc.from, accept: true } : null; };
  const build = (innerAct) => {
    const s = meadow();
    const a = s.addActor(withFamily(scripted([], innerAct), { reply: answer }), 40, 40, { sex: "male" });
    const b = s.addActor(scripted([], (obs) => (obs.tick === 0 ? { type: "wait", propose: { to: a.id, kind: "mate" } } : null)), 40, 42, { sex: "female" });
    b.facing = [0, -1]; // face a
    return { s, a, b };
  };
  // the brain is busy walking: the reply still goes out with the walking
  let { s, a } = build((obs) => ({ type: "move", dx: 0, dy: 1 }));
  const y0 = a.y;
  s.run(4);
  assert.equal(s.stats.births, 1, "answered, and a child was born");
  assert.ok(a.y > y0, "while it kept walking");

  // the brain's own action carries speech: no reply is added on top (one message per tick)
  ({ s, a } = build((obs) => ({ type: "wait", propose: { to: 999999, kind: "mate" } })));
  s.run(4);
  assert.equal(s.stats.births, 0, "it never got to answer");
  assert.equal(s.proposals.length, 1, "the proposal to it is still waiting");
});

// A parent brain that just stands there, and lets the child (running the same brain) do its thing.
function family() {
  const s = meadow();
  const parentLog = [], grownLog = [];
  const brain = withChildhood(function* (obs) { for (;;) { grownLog.push(obs); obs = yield { type: "wait" }; } });
  const a = s.addActor(brain, 40, 40, { sex: "male" }), b = s.addActor(brain, 40, 41, { sex: "female" });
  mateAtEndOfTick(s, a, b);
  const kid = s.byId(a.children[0]);
  return { s, a, b, kid, grownLog, parentLog };
}

test("withChildhood: a child stays near a parent, walking to catch up when it falls behind", () => {
  const { s, a, b, kid } = family();
  s.run(2);
  a.y = b.y = kid.y + 9; a.x = b.x = kid.x; // the parents are 9 tiles south, in the child's view (it faces south)
  const d0 = dist(kid, a);
  s.run(40);
  const d1 = dist(kid, a);
  assert.ok(d0 > 8 && d1 <= 4.5, `distance to the parent ${d0.toFixed(1)} -> ${d1.toFixed(1)}`);
  const at = [kid.x, kid.y];
  s.run(20);
  assert.ok(Math.abs(kid.x - at[0]) + Math.abs(kid.y - at[1]) < 1e-9, "and then it waits, instead of pacing about (a still child alarms nothing)");
});

test("withChildhood: a child eats meat it is carrying once a whole meal fits, and picks up meat lying about", () => {
  const { s, kid } = family();
  kid.food = 900;
  const meat = s.spawn("cooked_meat", kid.x, kid.y, { cook: 60 });
  meat.holder = kid.id;
  s.run(3);
  assert.equal(meat.removed, undefined, "not hungry enough: keeps it (eating now would waste most of it)");
  kid.food = 550;
  s.run(3);
  assert.equal(meat.removed, true, "eats at 550");
  assert.ok(kid.food > 950);

  const t = family();
  t.kid.food = 200;
  const ground = t.s.spawn("cooked_meat", t.kid.x + 0.6, t.kid.y + 1, { cook: 60 });
  t.s.run(8);
  assert.ok(ground.removed || ground.holder === t.kid.id, "it picked up the meal on the ground (and ate it)");
});

test("withChildhood: at adulthood the wrapped brain takes over, seeing an adult", () => {
  const { s, a, b, kid, grownLog } = family();
  s.run(1);
  const parentsSeen = grownLog.length; // (each adult parent's brain logs from the start)
  const before = grownLog.filter((o) => o.self.id === kid.id).length;
  assert.equal(before, 0, "the wrapped brain hasn't run for the child");
  kid.born = s.tick - C.HUMAN_ADULT_TICKS + 3;
  for (let i = 0; i < 6; i++) { feed(a); feed(b); kid.food = 1000; s.step(); }
  const mine = grownLog.filter((o) => o.self.id === kid.id);
  assert.ok(mine.length >= 1, "and now it has");
  assert.equal(mine[0].self.age, C.HUMAN_ADULT_TICKS, "first observation: exactly the tick it grew up");
  void parentsSeen;
});
