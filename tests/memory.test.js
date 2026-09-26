import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { TileMemory } from "../sim/memory.js";
import { makeInput, inputBrain, scriptedBrain } from "../sim/brains.js";
import { basicNpc } from "../npcs/basic.js";

const obsWith = (x0, y0, tiles, tick = 0) => ({ tick, view: { x0, y0, tiles } });

test("records visible tiles, ignores unseen '?' and out-of-world '#'", () => {
  const m = new TileMemory();
  m.update(obsWith(10, 20, ["T.,", "?.#"], 5));
  assert.equal(m.size, 4);
  assert.deepEqual(m.get(10, 20), { c: "T", tick: 5 });
  assert.deepEqual(m.get(11, 20), { c: ".", tick: 5 });
  assert.deepEqual(m.get(12, 20), { c: ",", tick: 5 });
  assert.equal(m.get(10, 21), null, "'?' was never seen");
  assert.equal(m.get(12, 21), null, "'#' is not a tile");
  assert.equal(m.get(0, 0), null);
});

test("remembers a tile after it leaves view, and keeps the most recent state when seen again", () => {
  const m = new TileMemory();
  m.update(obsWith(0, 0, ["T."], 1));
  m.update(obsWith(0, 0, ["??"], 2)); // out of view now
  assert.deepEqual(m.get(0, 0), { c: "T", tick: 1 }, "old knowledge survives");
  m.update(obsWith(0, 0, [".."], 9)); // the tree is gone when seen again
  assert.deepEqual(m.get(0, 0), { c: ".", tick: 9 });
  assert.equal(m.size, 2);
});

test("toObject gives a plain dictionary keyed by 'x,y'", () => {
  const m = new TileMemory();
  m.update(obsWith(3, 4, ["T"], 7));
  assert.deepEqual(m.toObject(), { "3,4": { c: "T", tick: 7 } });
});

test("a brain's memory holds only tiles it has actually seen", () => {
  const m = new TileMemory();
  const input = makeInput();
  const s = new Sim({ seed: 1 });
  const a = s.addActor(inputBrain(input, (o) => m.update(o)), 48, 48, { record: true });
  s.run(20); // standing still, facing south
  assert.ok(m.size > 20, "sees something");
  assert.ok(m.size < 200, `only a cone, not the whole world (${m.size})`);
  assert.equal(m.get(0, 0), null, "a far corner has never been seen");
  assert.equal(m.get(48, 30), null, "and neither has the ground behind the character");
  // every remembered tile is what the world actually has (nothing invented)
  for (const [k, v] of Object.entries(m.toObject())) {
    const [x, y] = k.split(",").map(Number);
    const i = y * s.world.width + x;
    const truth = s.world.treeAt[i] ? "T" : s.world.terrain[i] === 1 ? "," : ".";
    assert.equal(v.c, truth, k);
  }
  // walking reveals more, and old tiles are kept
  const before = m.size;
  for (let i = 0; i < 60; i++) { input.push({ type: "move", dx: 1, dy: 0 }); s.step(); }
  assert.ok(m.size > before, "walking discovered new tiles");
  assert.ok(m.get(48, 50)?.tick < s.tick - 30, "tiles seen earlier are still remembered");
});

test("a replayed session ends with the same memory as the live one", () => {
  const build = (brain) => {
    const s = new Sim({ seed: 9 });
    for (let y = 40; y < 60; y++) for (let x = 40; x < 70; x++) s.world.treeAt[y * s.world.width + x] = 0; // room to walk
    s.addActor(basicNpc, 40, 48);
    s.addActor(brain, 50, 48, { record: true });
    return s;
  };
  const liveMem = new TileMemory(), input = makeInput();
  const live = build(inputBrain(input, (o) => liveMem.update(o)));
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let t = 0; t < 600; t++) {
    if (t % 3 !== 2) input.push({ type: "move", dx: dirs[(t >> 5) % 4][0], dy: dirs[(t >> 5) % 4][1] });
    live.step();
  }
  const repMem = new TileMemory();
  const rep = build(scriptedBrain(live.inputLog, (o) => repMem.update(o)));
  rep.run(600);
  assert.ok(liveMem.size > 100);
  assert.deepEqual(repMem.toObject(), liveMem.toObject());
});
