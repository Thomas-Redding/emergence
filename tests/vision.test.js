import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { canSeePoint } from "../sim/vision.js";
import { observe } from "../sim/observe.js";

// An empty, treeless arena so tests control everything.
function arena() {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.world.trees.length = 0;
  s.entities = [];
  s.byIdMap.clear();
  return s;
}
const idle = function* () { while (true) yield { type: "wait" }; };

test("cone: sees ahead, not behind; nearby always sensed", () => {
  const s = arena();
  const h = s.addActor(idle, 40, 40); // at (40.5, 40.5) facing south (0,1)
  assert.ok(canSeePoint(s, h, 40.5, 46.5), "straight ahead");
  assert.ok(canSeePoint(s, h, 42.5, 46.5), "ahead, slightly off-axis");
  assert.ok(!canSeePoint(s, h, 40.5, 34.5), "straight behind");
  assert.ok(!canSeePoint(s, h, 46.5, 40.5), "directly to the side is outside a 140deg cone");
  assert.ok(canSeePoint(s, h, 40.5, 39.5), "very close behind is still sensed");
  assert.ok(!canSeePoint(s, h, 40.5, 60.5), "beyond range");
});

test("facing can be any direction, not just the four cardinals", () => {
  const s = arena();
  const h = s.addActor(idle, 40, 40);
  const k = Math.SQRT1_2;
  h.facing = [k, k]; // south-east
  assert.ok(canSeePoint(s, h, 46.5, 46.5), "dead ahead on the diagonal");
  assert.ok(!canSeePoint(s, h, 34.5, 34.5), "opposite diagonal");
  assert.ok(canSeePoint(s, h, 40.5 + 6, 40.5 + 2), "off-axis but inside the cone");
});

test("trees block line of sight but are themselves visible", () => {
  const s = arena();
  const h = s.addActor(idle, 40, 40);
  s.world.treeAt[43 * s.world.width + 40] = 1;
  assert.ok(canSeePoint(s, h, 40.5, 43.5), "the tree itself");
  assert.ok(!canSeePoint(s, h, 40.5, 46.5), "behind the tree");
});

test("observation hides entities outside the cone and marks tiles '?'", () => {
  const s = arena();
  const h = s.addActor(idle, 40, 40);
  const ahead = s.spawn("stick", 40.3, 45.7, { sharpness: 0 });
  const behind = s.spawn("stick", 40.3, 35.1, { sharpness: 0 });
  const obs = observe(s, h);
  const ids = obs.view.entities.map((e) => e.id);
  assert.ok(ids.includes(ahead.id));
  assert.ok(!ids.includes(behind.id));
  const R = obs.view.radius;
  assert.equal(obs.view.tiles[R + 5][R], ".");
  assert.equal(obs.view.tiles[R - 5][R], "?");
  assert.ok(Number.isInteger(obs.view.x0) && !Number.isInteger(obs.self.x));
});

test("face turns the actor (any direction) and changes what it sees", () => {
  const s = arena();
  const h = s.addActor(function* () { yield { type: "face", dx: 0, dy: -3 }; while (true) yield { type: "wait" }; }, 40, 40);
  const behind = s.spawn("stick", 40.5, 35.5, { sharpness: 0 });
  assert.ok(!observe(s, h).view.entities.some((e) => e.id === behind.id));
  s.step();
  assert.deepEqual(h.facing, [0, -1], "direction is normalized");
  assert.ok(observe(s, h).view.entities.some((e) => e.id === behind.id));
});

test("movement is continuous, speed-limited and direction-normalized", () => {
  const s = arena();
  const h = s.addActor(function* () {
    yield { type: "move", dx: 100, dy: 0 }; // huge vector: still just one step
    yield { type: "move", dx: 1, dy: 1 }; // diagonal: same speed, not sqrt(2) faster
    yield { type: "move", dx: 0, dy: 1, sneak: true };
    while (true) yield { type: "wait" };
  }, 40, 40);
  const x0 = h.x, y0 = h.y;
  s.step();
  assert.equal(h.x - x0, 0.5);
  assert.ok(Number.isInteger(x0 * 2) && !Number.isInteger(h.x + 0.1));
  const px = h.x, py = h.y;
  s.step();
  const d = Math.sqrt((h.x - px) ** 2 + (h.y - py) ** 2);
  assert.ok(Math.abs(d - 0.5) < 1e-12, `diagonal step length ${d}`);
  const qy = h.y;
  s.step();
  assert.ok(Math.abs(h.y - qy - 0.25) < 1e-12, "sneaking is slower");
  assert.equal(h.noisy, false);
});

test("bodies collide with trees and slide along them", () => {
  const s = arena();
  const h = s.addActor(function* () {
    while (true) yield { type: "move", dx: 1, dy: 1 }; // push diagonally into a wall
  }, 40, 40);
  for (let x = 30; x < 60; x++) s.world.treeAt[43 * s.world.width + x] = 1; // a wall along y=43
  const x0 = h.x;
  s.run(30); // 30 ticks of sliding stays within the 30-tile wall
  assert.ok(h.y + 0.3 <= 43 + 1e-9, `stopped at the wall, y=${h.y}`);
  assert.ok(h.x > x0 + 5, "kept sliding along it");
  const blocked = s.entities.find((e) => e.id === h.id);
  assert.ok(blocked.lastResult.ok, "still making progress while sliding");
});

test("a move straight into a wall fails with 'blocked'", () => {
  const s = arena();
  const h = s.addActor(function* () { while (true) yield { type: "move", dx: 0, dy: 1 }; }, 40, 40);
  for (let x = 30; x < 60; x++) s.world.treeAt[43 * s.world.width + x] = 1;
  s.run(30);
  assert.equal(h.lastResult.ok, false);
  assert.equal(h.lastResult.reason, "blocked");
});

test("reach is a distance: pickup works at 0.9 tiles, not 1.5", () => {
  const s = arena();
  const results = [];
  const h = s.addActor(function* (obs) {
    const [a, b] = [obs.view.entities.find((e) => e.kind === "stick" && e.sharpness === 0), null];
    obs = yield { type: "pickup", item: a.id };
    results.push(obs.lastResult.ok);
    while (true) yield { type: "wait" };
  }, 40, 40);
  s.spawn("stick", h.x + 0.9, h.y, { sharpness: 0 });
  s.step();
  assert.deepEqual(results, []); // first result is observed on the next call
  s.step();
  assert.deepEqual(results, [true]);

  const t = arena();
  const res2 = [];
  const g = t.addActor(function* (obs) {
    obs = yield { type: "wait" };
    const st = obs.view.entities.find((e) => e.kind === "stick");
    obs = yield { type: "pickup", item: st.id };
    res2.push(obs.lastResult);
    while (true) yield { type: "wait" };
  }, 40, 40);
  t.spawn("stick", g.x + 1.5, g.y, { sharpness: 0 }); // within sensing, out of reach
  t.run(3);
  assert.equal(res2[0].ok, false);
});

test("a quiet human is unseen from the deer's blind spot but noticed in front", () => {
  const noticed = (deerFacing, humanAt) => {
    let n = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = new Sim({ seed });
      s.world.treeAt.fill(0);
      s.entities = [];
      s.byIdMap.clear();
      const d = s.spawn("deer", 40.5, 40.5, { facing: deerFacing });
      const h = s.addActor(idle, humanAt[0], humanAt[1]);
      h.noisy = false;
      s.stepDeer([h]); // one tick: the deer hasn't wandered/turned before it looks
      if (d.fleeTicks) n++;
    }
    return n;
  };
  const inFront = noticed([1, 0], [42, 40]); // deer faces east, human 2 tiles east
  const behind = noticed([-1, 0], [42, 40]); // deer faces west, human directly behind
  assert.ok(inFront > 0, `front ${inFront}`);
  assert.equal(behind, 0);
});
