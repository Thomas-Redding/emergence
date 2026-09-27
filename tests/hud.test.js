import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { makeInput, inputBrain } from "../sim/brains.js";
import { actionPlans, ACTION_KEYS } from "../ui/controls.js";
import { buildHud } from "../ui/inventory.js";

const REACH = { pickup: 1, stab: 1.2, fire: 1.5, give: 1.5, talk: 4, stabFacingCos: 0.5 };
const mock = (inv, { ents = [], food = 800, facing = [0, 1], children = [], outgoing = null, tick = 0 } = {}) => ({
  tick,
  reach: REACH,
  self: { id: 1, x: 10, y: 10, facing, food, foodMax: 1000, inventory: inv, children },
  view: { entities: ents },
  proposals: { incoming: [], outgoing },
});
const I = (id, kind, extra = {}) => ({ id, kind, x: 10, y: 10, ...extra });

test("identical items stack; items with progress get their own slot and bar", () => {
  const h = buildHud(mock([
    I(1, "stick", { sharpness: 0 }), I(2, "stick", { sharpness: 0 }),
    I(3, "stick", { sharpness: 50 }),
    I(4, "spear", { sharpness: 200 }),
    I(5, "raw_meat", { cook: 30 }), I(6, "raw_meat", { cook: 0 }), I(7, "cooked_meat", { cook: 60 }),
  ]), { isPlayer: false });
  const byKey = Object.fromEntries(h.slots.map((s) => [s.key, s]));
  assert.equal(byKey.stick.count, 2, "two fresh sticks stack");
  assert.equal(byKey.stick.frac, null);
  assert.equal(byKey["stick#3"].count, 1);
  assert.equal(byKey["stick#3"].frac, 0.25, "50 of 200 sharpening");
  assert.equal(byKey["raw_meat#5"].frac, 0.5, "30 of 60 cooking");
  assert.equal(byKey.raw_meat.frac, null);
  assert.deepEqual(h.slots.map((s) => s.kind), ["spear", "stick", "stick", "raw_meat", "raw_meat", "cooked_meat"], "spear first, in-progress before fresh");
  assert.equal(h.slots[1].key, "stick#3");
  assert.deepEqual(h.actions, [], "no action row for a non-player");
});

test("food level: ok, low, critical", () => {
  const level = (food) => buildHud(mock([], { food }), { isPlayer: false }).food.level;
  assert.equal(level(900), "ok");
  assert.equal(level(300), "low");
  assert.equal(level(100), "critical");
  assert.equal(level(-5), "critical");
  assert.equal(buildHud(mock([], { food: 250 }), { isPlayer: false }).food.frac, 0.25);
});

test("the fire card shows the nearest fire in reach, lit or building", () => {
  const near = (kind, extra) => ({ id: 9, kind, x: 10.8, y: 10, ...extra });
  let h = buildHud(mock([], { ents: [near("fire", { lit: false, progress: 15 })] }), { isPlayer: false });
  assert.equal(h.fire.lit, false);
  assert.equal(h.fire.frac, 0.5);
  h = buildHud(mock([], { ents: [near("fire", { lit: true, fuel: 400 })] }), { isPlayer: false });
  assert.equal(h.fire.lit, true);
  assert.equal(h.fire.frac, 0.5);
  h = buildHud(mock([], { ents: [{ id: 9, kind: "fire", x: 14, y: 10, lit: true, fuel: 800 }] }), { isPlayer: false });
  assert.equal(h.fire, null, "out of reach");
});

test("action availability, with reasons", () => {
  const plans = (inv, opts) => actionPlans(mock(inv, opts));
  let p = plans([]);
  assert.deepEqual(ACTION_KEYS.filter((k) => p[k].action), [], "nothing possible with empty hands and nothing near");
  assert.match(p.q.why, /stick/);
  assert.match(p.x.why, /spear/);

  p = plans([I(1, "stick", { sharpness: 5 }), I(2, "stick", { sharpness: 90 }), I(3, "stick", { sharpness: 0 })]);
  assert.equal(p.q.action.item, 2, "sharpens the most progressed stick");
  assert.deepEqual(p.r.action.items, [3, 1], "fire uses the two least-sharpened");

  p = plans([], { ents: [{ id: 5, kind: "stick", x: 10.5, y: 10 }, { id: 6, kind: "stick", x: 10.2, y: 10 }] });
  assert.equal(p.e.action.item, 6, "picks up the nearest, not the first");
  assert.match(p.e.label, /stick/);
  p = plans([], { ents: [{ id: 5, kind: "stick", x: 12, y: 10 }] });
  assert.match(p.e.why, /reach/);

  const deerAt = (x, y) => ({ id: 8, kind: "deer", x, y });
  p = plans([I(1, "spear")], { ents: [deerAt(11, 10)], facing: [0, 1] }); // deer to the east, I face south
  assert.match(p.x.why, /face/);
  p = plans([I(1, "spear")], { ents: [deerAt(11, 10)], facing: [1, 0] });
  assert.equal(p.x.action.target, 8);
  p = plans([I(1, "spear")], { ents: [deerAt(14, 10)], facing: [1, 0] });
  assert.match(p.x.why, /reach/);

  p = plans([I(1, "raw_meat", { cook: 0 })], { ents: [{ id: 4, kind: "fire", x: 10.5, y: 10, lit: false, progress: 3 }] });
  assert.ok(p.t.action, "unlit fire can be tended");
  assert.match(p.c.why, /lit fire/);
  p = plans([I(1, "raw_meat", { cook: 0 })], { ents: [{ id: 4, kind: "fire", x: 10.5, y: 10, lit: true, fuel: 700 }] });
  assert.ok(p.c.action && p.c.hold);
  assert.equal(p.t.action, undefined, "a lit fire can't be tended");
  p = plans([I(1, "cooked_meat")]);
  assert.equal(p.g.action.item, 1);
});

test("the HUD's action row matches the plans", () => {
  const h = buildHud(mock([I(1, "stick", { sharpness: 0 })]), { isPlayer: true });
  assert.deepEqual(h.actions.map((a) => a.key), ["E", "Q", "X", "R", "T", "C", "G", "M", "H"]);
  const q = h.actions.find((a) => a.key === "Q");
  assert.equal(q.enabled, true);
  assert.equal(q.hold, true);
  const r = h.actions.find((a) => a.key === "R");
  assert.equal(r.enabled, false);
  assert.match(r.why, /two sticks/);
});

test("propose (mate): needs an adult within talking range, and only one outstanding at a time", () => {
  const adult = { id: 8, kind: "human", x: 10.5, y: 12, adult: true };
  const child = { id: 9, kind: "human", x: 10.5, y: 12, adult: false };
  let p = actionPlans(mock([], {}));
  assert.match(p.m.why, /talking range/);
  p = actionPlans(mock([], { ents: [child] }));
  assert.match(p.m.why, /talking range/, "a child doesn't count as a partner");
  p = actionPlans(mock([], { ents: [adult] }));
  assert.deepEqual(p.m.action, { type: "wait", propose: { to: 8, kind: "mate" } });
  p = actionPlans(mock([], { ents: [adult], outgoing: { to: 8, kind: "mate", expires: 50 }, tick: 10 }));
  assert.equal(p.m.action, undefined);
  assert.match(p.m.why, /waiting for an answer \(40 ticks left\)/);
  const far = { id: 8, kind: "human", x: 20, y: 12, adult: true };
  assert.match(actionPlans(mock([], { ents: [far] })).m.why, /talking range/);
});

test("give: your own child in reach comes before a stranger; cooked meat is offered first", () => {
  const stranger = { id: 8, kind: "human", x: 10.5, y: 10.9, adult: true };
  const kid = { id: 9, kind: "human", x: 10.5, y: 10.9, adult: false };
  let p = actionPlans(mock([I(1, "cooked_meat")]));
  assert.match(p.h.why, /no one/, "carrying something, but nobody nearby");
  p = actionPlans(mock([], { ents: [stranger] }));
  assert.match(p.h.why, /nothing to give/);
  p = actionPlans(mock([I(1, "cooked_meat")], { ents: [stranger] }));
  assert.deepEqual(p.h.action, { type: "give", item: 1, to: 8 });
  assert.match(p.h.label, /human#8/);
  p = actionPlans(mock([I(1, "cooked_meat")], { ents: [stranger, kid], children: [9] }));
  assert.equal(p.h.action.to, 9, "the child, not the (closer, same-distance) stranger");
  assert.match(p.h.label, /your child/);
  p = actionPlans(mock([I(1, "stick"), I(2, "cooked_meat")], { ents: [stranger] }));
  assert.equal(p.h.action.item, 2, "cooked meat offered first, even if picked up later");
  p = actionPlans(mock([I(1, "stick")], { ents: [stranger] }));
  assert.equal(p.h.action.item, 1, "otherwise, whatever you have");
});

// The important one: whatever the UI says is possible must really succeed in the sim, and
// whatever it says is impossible for facing reasons must really be refused.
test("every action the UI offers succeeds in the sim (and the stab facing rule agrees)", () => {
  const scenario = (setup) => {
    const s = new Sim({ seed: 1 });
    s.world.treeAt.fill(0);
    s.entities = [];
    s.byIdMap.clear();
    const input = makeInput();
    const a = s.addActor(inputBrain(input), 40, 40);
    const own = (kind, extra = {}) => { const e = s.spawn(kind, a.x, a.y, extra); e.holder = a.id; return e; };
    setup(s, a, own);
    return { s, a, input };
  };
  const run = ({ s, a, input }, key) => {
    const obs = s.observe(a.id);
    const plan = actionPlans(obs)[key];
    return { plan, obs, act() { input.push(plan.action); s.step(); return a.lastResult; } };
  };
  const cases = {
    e: (s, a) => s.spawn("stick", a.x + 0.6, a.y, { sharpness: 0 }),
    q: (s, a, own) => own("stick", { sharpness: 0 }),
    x: (s, a, own) => { own("spear", { sharpness: 200 }); a.facing = [1, 0]; s.spawn("deer", a.x + 1, a.y, { facing: [1, 0] }); },
    r: (s, a, own) => { own("stick", { sharpness: 0 }); own("stick", { sharpness: 9 }); },
    t: (s, a) => s.spawn("fire", a.x + 1, a.y, { lit: false, progress: 0, fuel: 0 }),
    c: (s, a, own) => { own("raw_meat", { cook: 0 }); s.spawn("fire", a.x + 1, a.y, { lit: true, progress: 30, fuel: 800 }); },
    g: (s, a, own) => own("cooked_meat", { cook: 60 }),
  };
  for (const [key, setup] of Object.entries(cases)) {
    const r = run(scenario(setup), key);
    assert.ok(r.plan.action, `${key} should be available: ${r.plan.why}`);
    assert.equal(r.act().ok, true, `${key} offered but the sim refused it`);
  }
  // facing: the UI says "face it first" exactly when the sim would refuse
  for (const [facing, offered] of [[[1, 0], true], [[0, 1], false], [[-1, 0], false], [[0.8, 0.6], true]]) {
    const sc = scenario((s, a, own) => { own("spear", { sharpness: 200 }); a.facing = facing; s.spawn("deer", a.x + 1, a.y, { facing: [1, 0] }); });
    const plan = actionPlans(sc.s.observe(sc.a.id)).x;
    assert.equal(!!plan.action, offered, `facing ${facing}`);
    sc.input.push({ type: "stab", target: [...sc.s.entities].find((e) => e.kind === "deer").id });
    sc.s.step();
    assert.equal(sc.a.lastResult.ok, offered, `sim agrees for facing ${facing}`);
  }
});
