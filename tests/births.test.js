import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import { replay } from "../sim/replay.js";
import { makeInput, inputBrain } from "../sim/brains.js";
import * as C from "../sim/constants.js";

const A = [40, 40], B = [40, 42]; // a faces south, so b two tiles away is in front of a
const propose = (to) => ({ type: "wait", propose: { to, kind: "mate" } });
const respond = (to, accept = true) => ({ type: "wait", respond: { to, accept } });
const ofType = (obs, type) => obs.events.filter((e) => e.type === type);

// Scripted people (script[tick] = action; every observation recorded in logs[name][tick]). A person can be
// given a `brain` instead, to test inheritance, and `age` / `food` / `record` as needed.
function scene(people, simOpts = {}, seed = 1) {
  const s = new Sim({ seed, ...simOpts });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  const ids = {}, logs = {}, actors = {};
  for (const [name, spec] of Object.entries(people)) {
    const { at, script = {}, age, food, brain, record } = spec;
    logs[name] = [];
    const fn = brain ?? function* (obs) {
      for (;;) {
        logs[name].push(obs);
        const act = typeof script === "function" ? script(ids)[obs.tick] : script[obs.tick];
        obs = yield act ?? { type: "wait" };
      }
    };
    actors[name] = s.addActor(fn, at[0], at[1], { ...(age === undefined ? {} : { age }), ...(record ? { record } : {}) });
    if (food !== undefined) actors[name].food = food;
    ids[name] = actors[name].id;
  }
  return { s, ids, logs, actors };
}
// Two adults who mate at tick 1 (a proposes at tick 0, b accepts at tick 1).
const couple = (over = {}, simOpts = {}, seed = 1) => scene({
  a: { at: A, script: (id) => ({ 0: propose(id.b) }), ...over.a },
  b: { at: B, script: (id) => ({ 1: respond(id.a) }), ...over.b },
}, simOpts, seed);
const children = (s) => s.entities.filter((e) => e.kind === "human" && e.parents);

test("an accepted mate proposal produces a child next to its parents, and costs each parent", () => {
  const { s, ids, logs, actors } = couple();
  const foodBefore = { a: actors.a.food, b: actors.b.food };
  s.run(3);
  const kids = children(s);
  assert.equal(kids.length, 1);
  const kid = kids[0];
  assert.deepEqual(kid.parents, [ids.a, ids.b]);
  assert.equal(kid.generation, 1);
  assert.equal(s.tick - kid.born, 2, "born at the end of tick 1, so two ticks old after three steps");
  assert.ok(Math.abs(kid.x - 40.5) < 2 && Math.abs(kid.y - 41.5) < 2, "next to its parents");
  assert.ok(s.canStand(kid.x, kid.y), "and somewhere it can stand");
  assert.ok(kid.food <= C.HUMAN_CHILD_FOOD && kid.food > C.HUMAN_CHILD_FOOD - 3, "starts with about 500 food");
  for (const p of ["a", "b"]) {
    assert.ok(Math.abs(foodBefore[p] - C.HUMAN_BIRTH_COST - actors[p].food) <= 2, `${p} paid ${C.HUMAN_BIRTH_COST} (plus a little ordinary hunger)`);
    assert.ok(actors[p].birthCooldown > C.HUMAN_BIRTH_COOLDOWN - 5, `${p} is on cooldown`);
  }
  assert.equal(s.stats.births, 1);
  assert.equal(ofType(logs.a[2], "proposal_result")[0].outcome, "accepted");
  assert.deepEqual(ofType(logs.a[2], "birth"), [{ type: "birth", child: kid.id, with: ids.b }]);
  assert.deepEqual(ofType(logs.b[2], "birth"), [{ type: "birth", child: kid.id, with: ids.a }]);
});

test("mating is refused, with who failed and why, and costs nothing", () => {
  const cases = [
    ["proposer is a child", { a: { age: 100 } }, "proposer_child"],
    ["recipient is a child", { b: { age: C.HUMAN_ADULT_TICKS - 5 } }, "recipient_child"],
    ["proposer too hungry", { a: { food: C.HUMAN_MATE_MIN_FOOD - 1 } }, "proposer_hungry"],
    ["recipient too hungry", { b: { food: 50 } }, "recipient_hungry"],
  ];
  for (const [name, over, reason] of cases) {
    const { s, logs, actors } = couple(over);
    const before = [actors.a.food, actors.b.food];
    s.run(3);
    const r = ofType(logs.a[2], "proposal_result")[0];
    assert.deepEqual([r.outcome, r.reason], ["invalid", reason], name);
    assert.equal(children(s).length, 0, name);
    assert.ok(actors.a.food >= before[0] - 3 && actors.b.food >= before[1] - 3, `${name}: nothing was paid`);
  }
  // cooldown
  const { s, logs, actors } = couple();
  actors.b.birthCooldown = 50;
  s.run(3);
  assert.equal(ofType(logs.a[2], "proposal_result")[0].reason, "recipient_cooldown");
  // exactly at the food threshold is fine
  const ok = couple({ a: { food: C.HUMAN_MATE_MIN_FOOD + 2 }, b: { food: C.HUMAN_MATE_MIN_FOOD + 2 } });
  ok.s.run(3);
  assert.equal(children(ok.s).length, 1);
});

test("the population cap stops births", () => {
  const { s, logs } = couple({}, { humanMax: 2 });
  s.run(3);
  assert.equal(ofType(logs.a[2], "proposal_result")[0].reason, "population_cap");
  assert.equal(children(s).length, 0);
});

test("after a birth both parents wait out a cooldown, then can have another child", () => {
  const { s, actors } = couple();
  const { a, b } = actors;
  s.run(3);
  assert.equal(s.stats.births, 1);
  const keepFed = () => { a.food = b.food = 1000; };
  keepFed();
  assert.deepEqual(s.mate(a, b), { ok: false, reason: "proposer_cooldown" }, "right after a birth");
  while (a.birthCooldown > 1) { keepFed(); s.step(); }
  keepFed();
  assert.deepEqual(s.mate(a, b), { ok: false, reason: "proposer_cooldown" }, "one tick early");
  s.step();
  keepFed();
  assert.equal(a.birthCooldown, 0);
  assert.deepEqual(s.mate(a, b), { ok: true }, "cooldown over");
  assert.equal(s.stats.births, 2);
  assert.ok(s.tick > C.HUMAN_BIRTH_COOLDOWN - 10 && s.tick < C.HUMAN_BIRTH_COOLDOWN + 10, `after about ${C.HUMAN_BIRTH_COOLDOWN} ticks (${s.tick})`);
});

test("a child runs a parent's brain: a random one of the two when both can be handed down", () => {
  const makeBrain = (tag) => { const f = function* (obs) { for (;;) obs = yield { type: "wait" }; }; f.tag = tag; return f; };
  const seen = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const brainA = makeBrain("A"), brainB = makeBrain("B");
    const { s, actors } = scene({ a: { at: A, brain: brainA }, b: { at: B, brain: brainB } }, {}, seed);
    assert.deepEqual(s.mate(actors.a, actors.b), { ok: true });
    const kid = children(s)[0];
    const fn = s.brains.get(kid.id).fn;
    assert.ok(fn === brainA || fn === brainB, "one of the parents' brains");
    seen.add(fn.tag);
  }
  assert.deepEqual([...seen].sort(), ["A", "B"], "over many worlds, each parent's brain gets passed on");
  const same = makeBrain("X");
  const { s, actors } = scene({ a: { at: A, brain: same }, b: { at: B, brain: same } });
  s.mate(actors.a, actors.b);
  assert.equal(s.brains.get(children(s)[0].id).fn, same, "two parents with one brain: the child has it");
});

test("a person at the keyboard can't hand down a brain: the child takes the other parent's, or waits", () => {
  const npcBrain = function* (obs) { for (;;) obs = yield { type: "wait" }; };
  let r = scene({ a: { at: A, record: true, brain: inputBrain(makeInput()) }, b: { at: B, brain: npcBrain } });
  r.s.mate(r.actors.a, r.actors.b);
  assert.equal(r.s.brains.get(children(r.s)[0].id).fn, npcBrain, "the AI parent's brain");
  assert.equal(r.s.brains.get(children(r.s)[0].id).record, false, "and the child is not driven from outside");

  r = scene({ a: { at: A, record: true, brain: inputBrain(makeInput()) }, b: { at: B, record: true, brain: inputBrain(makeInput()) } });
  r.s.mate(r.actors.a, r.actors.b);
  const kid = children(r.s)[0];
  assert.equal(r.s.brains.get(kid.id).fn.name, "idleBrain", "neither can be inherited: the child just waits");
  r.s.run(20);
  assert.equal(kid.lastResult.action, "wait");
});

test("children are too weak to hunt, but can still pick things up", () => {
  const results = {};
  const seenBy = (name) => function* (obs) {
    for (;;) {
      results[name] = obs.lastResult;
      obs = yield obs.tick === 0 ? { type: "stab", target: results.deer } : obs.tick === 1 ? { type: "pickup", item: results.stick } : { type: "wait" };
    }
  };
  for (const [name, age] of [["child", 100], ["adult", C.HUMAN_ADULT_TICKS]]) {
    const s = new Sim({ seed: 1 });
    s.world.treeAt.fill(0);
    s.entities = [];
    s.byIdMap.clear();
    const p = s.addActor(seenBy(name), 40, 40, { age });
    const spear = s.spawn("spear", p.x, p.y, { sharpness: 200 });
    spear.holder = p.id;
    const deer = s.spawnDeer(p.x, p.y + 1, { age: 5000, energy: 1000 });
    results.deer = deer.id;
    results.stick = s.spawn("stick", p.x + 0.5, p.y, { sharpness: 0 }).id;
    s.run(3); // (tick 0: stab, tick 1: pick up; each result is seen one tick later)
    if (name === "child") {
      assert.deepEqual([results.child.ok, results.child.reason], [true, undefined], "picking up is fine");
      assert.equal(s.stats.kills, 0);
    } else assert.equal(s.stats.kills, 1, "an adult stabs it");
  }
  // and the reason is reported when it tries
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  let got;
  const p = s.addActor(function* (obs) { obs = yield { type: "stab", target: 1 }; got = obs.lastResult; for (;;) obs = yield { type: "wait" }; }, 40, 40, { age: 100 });
  const spear = s.spawn("spear", p.x, p.y, { sharpness: 200 }); spear.holder = p.id;
  s.run(2);
  assert.deepEqual([got.ok, got.reason], [false, "too_young"]);
});

test("a newborn starves in about 1000 ticks if nobody feeds it, and a fed one grows up", () => {
  const { s, actors } = couple();
  s.run(3);
  const [kid] = children(s);
  s.run(1100);
  assert.equal(kid.removed, true);
  assert.equal(kid.cause, "starvation");
  assert.ok(kid.diedAt > 900 && kid.diedAt < 1100, `died at ${kid.diedAt}`);
  assert.equal(s.stats.childStarved, 1);
  assert.equal(s.stats.grewUp, 0);

  const t = couple();
  t.s.run(3);
  const [fed] = children(t.s);
  for (let i = 0; i < C.HUMAN_ADULT_TICKS + 10; i++) { fed.food = 1000; for (const p of Object.values(t.actors)) p.food = 1000; t.s.step(); }
  assert.equal(t.s.stats.grewUp, 1);
  assert.equal(t.s.stats.childStarved, 0);
  assert.ok(t.s.tick - fed.born >= C.HUMAN_ADULT_TICKS);
  assert.equal(t.s.observe(t.actors.a.id).view.entities.find((e) => e.id === fed.id).adult, true, "and is now seen as an adult");
});

test("brains see their family: parents, living children, generation, and the rules of mating", () => {
  const { s, ids, actors } = couple();
  const founder = s.observe(ids.a);
  assert.equal(founder.self.parents, null);
  assert.deepEqual(founder.self.children, []);
  assert.deepEqual(founder.rules.mate, { minFood: 600, cost: 250, cooldown: 4000, childFood: 500 });
  s.run(3);
  const [kid] = children(s);
  assert.deepEqual(s.observe(kid.id).self.parents, [ids.a, ids.b]);
  assert.deepEqual(s.observe(ids.a).self.children, [kid.id]);
  assert.deepEqual(s.observe(ids.b).self.children, [kid.id]);
  assert.equal(s.observe(ids.a).self.lifespan, undefined, "still hidden");
  s.killPerson(kid, "starvation");
  assert.deepEqual(s.observe(ids.a).self.children, [], "a dead child is no longer listed");
  assert.equal(actors.a.children.length, 1, "(though the parent's own record keeps it)");
});

test("generations count up the family line", () => {
  const { s, ids, actors } = couple();
  s.run(3);
  const [kid] = children(s);
  kid.born = s.tick - C.HUMAN_ADULT_TICKS; // grown up
  kid.food = 1000;
  const grandchild = (() => { assert.deepEqual(s.mate(kid, actors.b), { ok: false, reason: "recipient_cooldown" }, "b is still on cooldown"); actors.b.birthCooldown = 0; assert.deepEqual(s.mate(kid, actors.b), { ok: true }); return children(s).find((c) => c.generation === 2); })();
  assert.ok(grandchild, "generation 1 + generation 0 -> generation 2");
  assert.deepEqual(grandchild.parents, [kid.id, ids.b]);
});

test("births are deterministic, part of the hash, and replay exactly", () => {
  const hash = (seed) => { const { s } = couple({}, {}, seed); s.run(50); return hashState(s); };
  assert.equal(hash(4), hash(4));
  const withBirth = couple(); withBirth.s.run(50);
  const noBirth = scene({ a: { at: A }, b: { at: B } }); noBirth.s.run(50);
  assert.notEqual(hashState(withBirth.s), hashState(noBirth.s));

  // a person at the keyboard asks an AI, who says yes; replaying the recorded log gives the same world
  const makeSim = (humanBrain) => {
    const s = new Sim({ seed: 3 });
    s.world.treeAt.fill(0);
    s.entities = [];
    s.byIdMap.clear();
    const human = s.addActor(humanBrain, 40, 40, { record: true });
    const other = s.addActor(function* (obs) {
      for (;;) { const inc = obs.proposals.incoming[0]; obs = yield inc ? respond(inc.from) : { type: "wait" }; }
    }, 40, 42);
    return { s, human, other };
  };
  const input = makeInput();
  const { s: live, other } = makeSim(inputBrain(input));
  for (let t = 0; t < 30; t++) { if (t === 2) input.push(propose(other.id)); live.step(); }
  assert.equal(live.stats.births, 1);
  const rep = replay((b) => makeSim(b).s, JSON.parse(JSON.stringify(live.inputLog)), 30);
  assert.equal(hashState(rep), hashState(live));
  assert.equal(rep.stats.births, 1);
});

test("claimAsPlayer hands an actor to a live brain and marks it as such", () => {
  const { s, ids, actors } = couple();
  s.run(3);
  const kid = children(s)[0];
  const input = makeInput();
  s.claimAsPlayer(kid.id, inputBrain(input));
  assert.equal(s.brains.get(kid.id).record, true);
  assert.equal(s.brains.get(kid.id).inheritable, false);
  assert.ok(s.humanIds.includes(kid.id));
  input.push({ type: "face", dx: 1, dy: 0 });
  s.step();
  assert.deepEqual(kid.facing, [1, 0]);
  assert.ok(s.inputLog.some((e) => e.actor === kid.id && e.action.type === "face"));
});
