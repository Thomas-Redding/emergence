import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import { basicNpc } from "../npcs/basic.js";

function game(seed, npcs) {
  const s = new Sim({ seed });
  npcs.forEach((fn, i) => s.addActor(fn, 40 + i * 6, 48));
  return s;
}

test("full game with NPCs is deterministic", () => {
  const a = game(11, [basicNpc, basicNpc]), b = game(11, [basicNpc, basicNpc]);
  for (let i = 0; i < 10; i++) {
    a.run(500);
    b.run(500);
    assert.equal(hashState(a), hashState(b), `diverged at tick ${a.tick}`);
  }
  assert.deepEqual(a.stats, b.stats);
});

test("baseline NPC completes the whole loop: spear, kill, fire, cook, eat", () => {
  const s = game(1, [basicNpc]);
  s.run(6000);
  assert.ok(s.stats.kills > 0 && s.stats.fires > 0 && s.stats.meals > 0, JSON.stringify(s.stats));
});

test("baseline NPC usually survives across seeds", () => {
  let deaths = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const s = game(seed, [basicNpc]);
    s.run(6000);
    deaths += s.stats.deaths;
  }
  assert.ok(deaths <= 2, `${deaths} of 5 starved`);
});

test("a crashing NPC idles without breaking the sim", () => {
  const boom = function* () { yield { type: "wait" }; throw new Error("boom"); };
  const s = game(3, [boom, basicNpc]);
  s.run(500);
  assert.equal(s.tick, 500);
  assert.equal(s.brains.get(s.entities.find((e) => e.kind === "human").id).dead, true);
});

test("garbage actions fail harmlessly", () => {
  const junk = function* () {
    for (const a of [null, 5, {}, { type: "nope" }, { type: "move", dx: 3, dy: 0 }, { type: "stab", target: 9999 }]) {
      yield a;
    }
  };
  const s = game(3, [junk]);
  const before = hashState(s);
  s.run(10);
  assert.notEqual(before, hashState(s));
});

test("observations are copies: mutating one cannot change the sim", () => {
  const vandal = function* (obs) {
    while (true) {
      obs.self.x = -999;
      obs.self.food = 1e9;
      obs.view.entities.length = 0;
      for (const e of obs.self.inventory) e.kind = "hacked";
      obs = yield { type: "wait" };
    }
  };
  const s = game(3, [vandal]);
  s.run(50);
  const me = s.entities.find((e) => e.kind === "human");
  assert.ok(me.x > 0 && me.food < 1000);
});

test("headless run at full speed is fast", () => {
  const s = game(2, [basicNpc, basicNpc, basicNpc]);
  const t0 = performance.now();
  s.run(20000);
  const ms = performance.now() - t0;
  console.log(`  20000 ticks, 3 NPCs: ${ms.toFixed(0)}ms`);
  assert.ok(ms < 10000);
});

test("stab requires facing the deer", () => {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  const results = [];
  const h = s.addActor(function* (obs) {
    const deer = obs.view.entities.find((e) => e.kind === "deer");
    const spear = obs.self.inventory.find((e) => e.kind === "spear");
    obs = yield { type: "stab", target: deer.id }; // facing south, deer is east
    results.push(obs.lastResult.reason);
    obs = yield { type: "face", dx: 1, dy: 0 };
    obs = yield { type: "stab", target: deer.id };
    results.push(obs.lastResult.ok);
    while (true) yield { type: "wait" };
  }, 40, 40);
  const sp = s.spawn("spear", h.x, h.y, { sharpness: 200 });
  sp.holder = h.id;
  const d = s.spawn("deer", h.x + 1, h.y, { facing: [1, 0] });
  s.run(4);
  assert.deepEqual(results, ["not_facing_target", true]);
  assert.ok(d.removed || !s.byId(d.id));
});

// Regression: an NPC used to dither forever when a target sat behind a tree. It forgot the tree
// whenever it turned away (unseen tiles read as walkable), so it flip-flopped between "go around"
// and "go straight" on alternate ticks.
test("baseline NPCs don't dither back and forth", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const s = game(seed, [basicNpc, basicNpc, basicNpc]);
    const humans = s.entities.filter((e) => e.kind === "human");
    const last = new Map(), reversals = new Map(humans.map((h) => [h.id, 0]));
    const prev = new Map(humans.map((h) => [h.id, [h.x, h.y]]));
    for (let t = 0; t < 800; t++) {
      s.step();
      for (const h of humans) {
        if (h.removed) continue;
        const [px, py] = prev.get(h.id), dx = h.x - px, dy = h.y - py;
        prev.set(h.id, [h.x, h.y]);
        if (dx === 0 && dy === 0) continue;
        const l = last.get(h.id);
        if (l && l[0] * dx + l[1] * dy < 0) reversals.set(h.id, reversals.get(h.id) + 1); // turned around
        last.set(h.id, [dx, dy]);
      }
    }
    for (const [id, n] of reversals) assert.ok(n < 60, `seed ${seed} npc ${id}: ${n} reversals in 800 ticks`);
  }
});
