import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import * as C from "../sim/constants.js";

// A giver at (40,40) carrying `items`, and a receiver at `receiverAt`. The giver's `act(ctx, obs)` returns
// its action each tick, where ctx = { ids, find(kind) } so it can name the receiver and the items it holds.
function scene({ act, receiverAt = [40, 41], items = ["cooked_meat"], receiverAge } = {}) {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  const ctx = { ids: {}, find: (kind) => s.entities.find((e) => e.kind === kind && !e.removed) };
  const seen = { giver: [], receiver: [] };
  const brain = (who, decide) => function* (obs) { for (;;) { seen[who].push(obs); obs = yield decide(obs) ?? { type: "wait" }; } };
  const giver = s.addActor(brain("giver", (obs) => act?.(ctx, obs)), 40, 40);
  const receiver = s.addActor(brain("receiver", () => null), receiverAt[0], receiverAt[1], receiverAge === undefined ? {} : { age: receiverAge });
  ctx.ids = { giver: giver.id, receiver: receiver.id };
  const carried = items.map((kind) => { const e = s.spawn(kind, giver.x, giver.y, kind === "spear" ? { sharpness: 200 } : { cook: 60 }); e.holder = giver.id; return e; });
  return { s, ctx, giver, receiver, carried, seen };
}
const giveAt0 = (kind) => (ctx, obs) => (obs.tick === 0 ? { type: "give", item: ctx.find(kind).id, to: ctx.ids.receiver } : null);

test("giving hands an item to a person within reach, and tells them", () => {
  const { s, giver, receiver, carried, seen } = scene({ act: giveAt0("cooked_meat") });
  s.run(3);
  const [meat] = carried;
  assert.equal(meat.holder, receiver.id, "it's theirs now");
  assert.deepEqual([meat.x, meat.y], [receiver.x, receiver.y]);
  assert.equal(seen.giver[1].lastResult.action, "give");
  assert.equal(seen.giver[1].lastResult.ok, true);
  assert.deepEqual(seen.receiver[1].events.filter((e) => e.type === "gift"), [{ type: "gift", from: giver.id, item: meat.id, kind: "cooked_meat" }]);
  assert.deepEqual(seen.receiver[1].self.inventory.map((i) => i.kind), ["cooked_meat"], "it shows in their inventory");
  assert.deepEqual(seen.giver[1].self.inventory, [], "and is gone from the giver's");
  assert.equal(seen.receiver[2].events.length, 0, "the notice arrives once");
  assert.equal(seen.giver[1].reach.give, C.REACH.give, "brains can see how close they need to be");
});

test("a gift moves with its new owner", () => {
  const { s, receiver, carried } = scene({ act: giveAt0("cooked_meat") });
  s.step();
  receiver.x += 3; // (moved directly: this is only about where the carried item is drawn)
  const before = [carried[0].x, carried[0].y];
  s.step();
  assert.equal(carried[0].holder, receiver.id);
  assert.deepEqual(before, [receiver.x - 3, receiver.y], "it was with them when they were given it");
});

test("giving fails, with a reason, when it can't be done", () => {
  const result = (opts, act) => { const sc = scene({ ...opts, act }); sc.s.run(2); return { ...sc, r: sc.seen.giver[1].lastResult }; };

  let t = result({}, (ctx, obs) => (obs.tick === 0 ? { type: "give", item: 999999, to: ctx.ids.receiver } : null));
  assert.deepEqual([t.r.ok, t.r.reason], [false, "not_held"], "something you don't have");

  t = result({ receiverAt: [40, 44] }, giveAt0("cooked_meat"));
  assert.deepEqual([t.r.ok, t.r.reason], [false, "out_of_reach"], "3 tiles away");
  assert.equal(t.carried[0].holder, t.giver.id, "and nothing changed hands");
  assert.equal(t.seen.receiver[1].events.length, 0, "and nobody was told");

  t = result({}, (ctx, obs) => (obs.tick === 0 ? { type: "give", item: ctx.find("cooked_meat").id, to: ctx.ids.giver } : null));
  assert.equal(t.r.reason, "no_such_person", "not to yourself");

  t = result({}, (ctx, obs) => (obs.tick === 0 ? { type: "give", item: ctx.find("cooked_meat").id, to: 424242 } : null));
  assert.equal(t.r.reason, "no_such_person", "not to nobody");

  const dead = scene({ act: giveAt0("cooked_meat") });
  dead.s.killPerson(dead.receiver, "starvation");
  dead.s.run(2);
  assert.equal(dead.seen.giver[1].lastResult.reason, "no_such_person", "not to the dead");
});

test("you can give anything you carry, including to a child", () => {
  for (const kind of ["spear", "stick", "raw_meat", "cooked_meat"]) {
    const { s, receiver, carried } = scene({ items: [kind], receiverAge: 10, act: giveAt0(kind) });
    s.run(2);
    assert.equal(carried[0].holder, receiver.id, kind);
    assert.equal(carried[0].kind, kind, "and it is still what it was");
  }
});

test("a child that has been given cooked meat can eat it", () => {
  const { s, receiver, carried } = scene({ receiverAge: 10, act: giveAt0("cooked_meat") });
  receiver.food = 300;
  s.run(2);
  assert.equal(carried[0].holder, receiver.id);
  // the receiver's brain is a plain waiter here: eat on its behalf through the same action a brain would use
  const s2 = new Sim({ seed: 1 });
  s2.world.treeAt.fill(0);
  s2.entities = [];
  s2.byIdMap.clear();
  const kid = s2.addActor(function* (obs) { for (;;) { const meal = obs.self.inventory.find((i) => i.kind === "cooked_meat"); obs = yield meal ? { type: "eat", item: meal.id } : { type: "wait" }; } }, 40, 41, { age: 10 });
  kid.food = 300;
  const parent = s2.addActor(function* (obs) { obs = yield { type: "give", item: s2.entities.find((e) => e.kind === "cooked_meat").id, to: kid.id }; for (;;) obs = yield { type: "wait" }; }, 40, 40);
  const meat = s2.spawn("cooked_meat", parent.x, parent.y, { cook: 60 });
  meat.holder = parent.id;
  s2.run(4);
  assert.ok(kid.food > 700, `the child ate it (food ${kid.food})`);
  assert.equal(meat.removed, true);
});

test("a gift is world state (it changes the hash)", () => {
  const idle = scene({});
  const gave = scene({ act: giveAt0("cooked_meat") });
  idle.s.run(3);
  gave.s.run(3);
  assert.notEqual(hashState(idle.s), hashState(gave.s));
});

test("the gift notice arrives on the next tick whichever of the two acts first", () => {
  for (const receiverFirst of [false, true]) {
    const s = new Sim({ seed: 1 });
    s.world.treeAt.fill(0);
    s.entities = [];
    s.byIdMap.clear();
    const seen = [];
    let giverId, receiverId;
    const receiverBrain = function* (obs) { for (;;) { seen.push(obs); obs = yield { type: "wait" }; } };
    const giverBrain = function* (obs) {
      for (;;) obs = yield obs.tick === 0 ? { type: "give", item: s.entities.find((e) => e.kind === "cooked_meat").id, to: receiverId } : { type: "wait" };
    };
    const add = { receiver: () => (receiverId = s.addActor(receiverBrain, 40, 41).id), giver: () => (giverId = s.addActor(giverBrain, 40, 40).id) };
    if (receiverFirst) { add.receiver(); add.giver(); } else { add.giver(); add.receiver(); }
    assert.equal(receiverFirst, receiverId < giverId);
    const meat = s.spawn("cooked_meat", 40.5, 40.5, { cook: 60 });
    meat.holder = giverId;
    s.run(3);
    assert.equal(seen[0].events.length, 0, `receiverFirst=${receiverFirst}: not on the same tick`);
    assert.deepEqual(seen[1].events.map((e) => e.type), ["gift"], `receiverFirst=${receiverFirst}: on the next`);
  }
});
