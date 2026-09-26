import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { withMemory, walkNear } from "../npcs/lib.js";

test("withMemory fills unseen tiles from what the brain saw earlier", () => {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.world.treeAt[54 * s.world.width + 40] = 1; // a tree 3 tiles south of the NPC
  s.entities = [];
  s.byIdMap.clear();
  const seen = [];
  const brain = withMemory(function* (obs) {
    for (;;) {
      const R = obs.view.radius;
      seen.push({ south: obs.view.tiles[R + 3][R], facing: obs.self.facing, hasMemory: !!obs.memory });
      obs = yield seen.length === 1 ? { type: "face", dx: 0, dy: -1 } : { type: "wait" };
    }
  });
  s.addActor(brain, 40, 51); // faces south at first: sees the tree
  s.run(3);
  assert.equal(seen[0].south, "T", "visible to begin with");
  assert.deepEqual(seen[1].facing, [0, -1], "now looking north");
  assert.equal(seen[1].south, "T", "still known after turning away");
  assert.ok(seen.every((o) => o.hasMemory));
});

test("without the wrapper the same tile reads as unseen after turning away", () => {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.world.treeAt[54 * s.world.width + 40] = 1;
  s.entities = [];
  s.byIdMap.clear();
  const seen = [];
  s.addActor(function* (obs) {
    for (;;) {
      const R = obs.view.radius;
      seen.push(obs.view.tiles[R + 3][R]);
      obs = yield seen.length === 1 ? { type: "face", dx: 0, dy: -1 } : { type: "wait" };
    }
  }, 40, 51);
  s.run(3);
  assert.deepEqual(seen.slice(0, 2), ["T", "?"]);
});

test("walkNear gives up when it stops getting closer instead of dithering for the full cap", () => {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  let ticks = 0;
  // A target on the far side of a solid wall the NPC can see the whole length of, so it can't get closer.
  for (let x = 30; x < 60; x++) for (let y = 44; y <= 46; y++) s.world.treeAt[y * s.world.width + x] = 1;
  const brain = withMemory(function* (obs) {
    obs = yield* walkNear(obs, 40.5, 41.5, { maxTicks: 1000 }); // unreachable within view
    ticks = obs.tick;
    for (;;) obs = yield { type: "wait" };
  });
  s.addActor(brain, 40, 48);
  s.run(400);
  assert.ok(ticks > 0 && ticks < 300, `gave up at tick ${ticks}`);
});
