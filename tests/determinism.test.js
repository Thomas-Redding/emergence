import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";

test("same seed -> identical simulation", () => {
  const a = new Sim({ seed: 42 }), b = new Sim({ seed: 42 });
  for (let i = 0; i < 20; i++) {
    a.run(500);
    b.run(500);
    assert.equal(hashState(a), hashState(b), `diverged at tick ${a.tick}`);
  }
});

test("different seeds -> different worlds", () => {
  const a = new Sim({ seed: 1 }), b = new Sim({ seed: 2 });
  a.run(1000);
  b.run(1000);
  assert.notEqual(hashState(a), hashState(b));
});

test("world has both forest and plains, deer, and sticks appear", () => {
  const s = new Sim({ seed: 7 });
  s.run(2000);
  assert.ok(s.world.trees.length > 0);
  assert.ok(s.world.terrain.includes(0) && s.world.terrain.includes(1));
  assert.ok(s.entities.some((e) => e.kind === "deer"));
  assert.ok(s.entities.some((e) => e.kind === "stick"));
});
