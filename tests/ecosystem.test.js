import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import * as C from "../sim/constants.js";

// An empty treeless meadow, lush everywhere, with no deer: tests place what they need.
function meadow(seed = 1, { grass = C.GRASS_CAP_PLAINS } = {}) {
  const s = new Sim({ seed });
  s.world.treeAt.fill(0);
  s.world.grassCap.fill(C.GRASS_CAP_PLAINS);
  s.world.grassGrowth.fill(C.GRASS_GROWTH_PLAINS);
  s.grass.fill(grass);
  s.entities = [];
  s.byIdMap.clear();
  return s;
}
const deerAt = (s, x, y, o = {}) => s.spawnDeer(x + 0.5, y + 0.5, { age: C.DEER_FAWN_TICKS + 100, energy: 1000, ...o });
const liveDeer = (s) => s.entities.filter((e) => e.kind === "deer" && !e.removed);

test("a hungry deer grazes the tile it stands on: grass falls, energy rises", () => {
  const s = meadow();
  const d = deerAt(s, 40, 40, { energy: 300 });
  const tile = 40 * s.world.width + 40;
  s.run(10);
  assert.ok(s.grass[tile] < C.GRASS_CAP_PLAINS, "it ate");
  assert.ok(d.energy > 300, `energy ${d.energy}`);
  assert.equal(d.grazing, true);
  // what it gained came from the grass it took (each unit is worth at most DEER_ENERGY_PER_GRASS_MAX energy)
  const eaten = s.grass.reduce((a, b) => a + (C.GRASS_CAP_PLAINS - b), 0);
  assert.ok(eaten > 0 && (d.energy - 300) <= eaten * C.DEER_ENERGY_PER_GRASS_MAX, `ate ${eaten}, gained ${d.energy - 300}`);
});

test("grazing stops once full (hysteresis) and a full deer doesn't eat", () => {
  const s = meadow();
  const d = deerAt(s, 40, 40, { energy: 590 });
  let fullAt = null;
  for (let t = 0; t < 2000 && fullAt === null; t++) {
    s.step();
    if (!d.grazing) fullAt = { tick: t, energy: d.energy };
  }
  assert.ok(fullAt, "it eventually stopped grazing");
  assert.ok(fullAt.energy >= C.DEER_FULL, `stopped at ${fullAt.energy}, not before it was full`);
  const before = s.grass.reduce((a, b) => a + b, 0);
  s.run(50);
  assert.equal(d.grazing, false, "still not grazing while it's between FULL and HUNGRY");
  assert.ok(s.grass.reduce((a, b) => a + b, 0) >= before - 5, "and it isn't eating (only the odd tile regrowing)");
});

test("a deer walks to grass when its own tile is bare", () => {
  const s = meadow(1, { grass: 0 });
  s.world.grassGrowth.fill(0);
  const patch = 44 * s.world.width + 40; // 4 tiles south
  s.grass[patch] = 20;
  const d = deerAt(s, 40, 40, { energy: 300 });
  const start = d.y;
  let closest = Infinity;
  for (let t = 0; t < 60; t++) { s.step(); closest = Math.min(closest, 44 - d.y); } // this is the "walks to it" window;
  // once it's eaten the only patch on this bare test map it has nothing left to do but roam randomly,
  // which isn't what this test is about
  assert.ok(closest < 1, `got within 1 tile of the patch (closest ${closest.toFixed(2)}, started ${44 - start})`);
  assert.ok(s.grass[patch] < 20, "and ate it");
});

test("bare tiles regrow slowly, a few at a time, and never past the cap", () => {
  const s = meadow(1, { grass: 0 });
  s.run(C.GRASS_REGROW_PERIOD);
  const total = s.grass.reduce((a, b) => a + b, 0);
  assert.ok(total > 0 && total <= s.grass.length * C.GRASS_GROWTH_PLAINS, `grew ${total} in one period`);
  s.run(C.GRASS_REGROW_PERIOD * 40);
  assert.ok(s.grass.every((g) => g <= C.GRASS_CAP_PLAINS), "never exceeds the cap");
});

test("with no grass a deer starves, and it is counted", () => {
  const s = meadow(1, { grass: 0 });
  s.world.grassGrowth.fill(0);
  const d = deerAt(s, 40, 40, { energy: 100 });
  s.run(100 * C.DEER_METAB_EVERY + 50);
  assert.equal(d.removed || !s.byId(d.id), true);
  assert.equal(s.stats.deerStarved, 1);
});

test("deer die of old age at their rolled lifespan", () => {
  const s = meadow();
  const d = deerAt(s, 40, 40, { age: 90 });
  d.lifespan = 100;
  s.run(20);
  assert.equal(s.stats.deerOld, 1);
  assert.equal(liveDeer(s).length, 0);
  // lifespans are rolled per deer within the configured range
  const t = meadow(2);
  for (let i = 0; i < 50; i++) deerAt(t, 30 + (i % 10), 30 + Math.floor(i / 10));
  const spans = liveDeer(t).map((x) => x.lifespan);
  assert.ok(Math.min(...spans) >= C.DEER_LIFESPAN_MIN && Math.max(...spans) < C.DEER_LIFESPAN_MIN + C.DEER_LIFESPAN_SPREAD);
  assert.ok(new Set(spans).size > 20, "they differ");
});

test("well-fed adults with a mate nearby have fawns; the fawn starts small and hungry", () => {
  const s = meadow();
  deerAt(s, 40, 40);
  deerAt(s, 43, 40);
  for (let t = 0; t < 4000 && s.stats.deerBorn === 0; t++) {
    for (const d of liveDeer(s)) d.energy = Math.max(d.energy, 900); // keep them fed: this test is about breeding
    s.step();
  }
  assert.ok(s.stats.deerBorn >= 1, "a fawn was born");
  const fawn = liveDeer(s).find((d) => d.age < C.DEER_FAWN_TICKS);
  assert.ok(fawn, "and it is a fawn");
  const parents = liveDeer(s).filter((d) => d.breedCooldown > 0);
  assert.ok(parents.length >= 1, "the parent is on cooldown");
});

test("a lone deer can't breed (no mate), and a fawn can't breed until it grows up", () => {
  const s = meadow();
  const lone = deerAt(s, 40, 40);
  for (let t = 0; t < 8000; t++) { lone.energy = 1000; lone.age = Math.min(lone.age, C.DEER_FAWN_TICKS + 100); lone.lifespan = 1e9; s.step(); }
  assert.equal(s.stats.deerBorn, 0);

  const t = meadow();
  deerAt(t, 40, 40, { age: 10 }); // two fawns: neither is an adult
  deerAt(t, 41, 40, { age: 10 });
  for (let i = 0; i < 1000; i++) { for (const d of liveDeer(t)) { d.energy = 1000; d.lifespan = 1e9; } t.step(); }
  assert.equal(t.stats.deerBorn, 0, `fawns bred: ${t.stats.deerBorn}`);
});

test("a fawn matures into an adult after DEER_FAWN_TICKS", () => {
  const s = meadow();
  const f = deerAt(s, 40, 40, { age: 0 });
  f.lifespan = 1e9;
  s.run(C.DEER_FAWN_TICKS - 5);
  assert.ok(f.age < C.DEER_FAWN_TICKS);
  s.run(10);
  assert.ok(f.age >= C.DEER_FAWN_TICKS);
});

test("brains see grass levels and which deer are adults", () => {
  const s = meadow();
  const seen = [];
  const a = s.addActor(function* (obs) { seen.push(obs); for (;;) obs = yield { type: "wait" }; }, 40, 40);
  s.grass[(Math.floor(a.y) + 2) * s.world.width + Math.floor(a.x)] = 10; // half grass, two tiles south
  s.grass[(Math.floor(a.y) + 3) * s.world.width + Math.floor(a.x)] = 0;
  deerAt(s, 40, 43, { age: 5 });
  deerAt(s, 41, 43);
  s.step();
  const o = s.observe(a.id), R = o.view.radius;
  assert.equal(o.view.grass.length, o.view.tiles.length);
  assert.equal(o.view.grass[R + 2][R], "5", "half of 20");
  assert.equal(o.view.grass[R + 3][R], "0", "bare");
  assert.equal(o.view.grass[R + 1][R], "9", "full");
  assert.equal(o.view.grass[R - 6][R], "?", "unseen, like the terrain");
  const kinds = o.view.entities.filter((e) => e.kind === "deer").map((e) => e.adult).sort();
  assert.deepEqual(kinds, [false, true]);
});

test("grass is world state: it is part of the determinism hash", () => {
  const a = meadow(), b = meadow();
  assert.equal(hashState(a), hashState(b));
  b.grass[100] = 3;
  assert.notEqual(hashState(a), hashState(b));
});

test("the herd sustains itself: no extinction, no explosion, over a long run", () => {
  for (const seed of [1, 2, 3]) {
    const s = new Sim({ seed });
    let min = Infinity, max = 0;
    for (let t = 1; t <= 60000; t++) {
      s.step();
      if (t % 500 === 0) { const n = liveDeer(s).length; min = Math.min(min, n); max = Math.max(max, n); }
    }
    assert.ok(min >= 8, `seed ${seed}: herd dipped to ${min}`);
    assert.ok(max < C.DEER_MAX, `seed ${seed}: herd hit ${max}`);
    assert.ok(s.stats.deerBorn > 50, `seed ${seed}: only ${s.stats.deerBorn} births`);
    assert.ok(s.stats.deerStarved > 0 || s.stats.deerOld > 0, "deer die naturally too");
  }
});

// Regression: in an even meadow every neighbouring tile is equally near, and breaking that tie by scan
// order sent every deer marching north, eating a dead-straight strip (and biasing whole herds northward).
test("a grazing deer in an even meadow doesn't march in a line or drift in one direction", () => {
  let sumDx = 0, sumDy = 0;
  // A lone grazer wanders (a self-avoiding walk, about 5 tiles of spread per run), so averaging N runs
  // leaves about 5/sqrt(N) of noise: with N=40, a threshold of 2.5 is ~3 standard errors. The old bug
  // moved every run about 4 tiles the same way.
  const N = 40;
  for (let seed = 1; seed <= N; seed++) {
    const s = meadow(seed);
    s.world.grassGrowth.fill(0);
    const d = deerAt(s, 40, 40, { energy: 300 });
    d.lifespan = 1e9;
    s.run(3000);
    const bare = [];
    for (let i = 0; i < s.grass.length; i++) if (s.grass[i] === 0) bare.push([i % s.world.width, Math.floor(i / s.world.width)]);
    // Threshold is a floor, not a target: richer grass now gives more energy per bite (see
    // DEER_ENERGY_PER_GRASS_MIN/MAX), so a deer needs fewer bites to reach DEER_FULL than it used to.
    assert.ok(bare.length >= 10, `seed ${seed}: it should have eaten a fair amount (${bare.length})`);
    const xs = bare.map((b) => b[0]), ys = bare.map((b) => b[1]);
    const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
    assert.ok(spanX >= 3 && spanY >= 3, `seed ${seed}: grazed ground is a strip (${spanX + 1} x ${spanY + 1})`);
    sumDx += xs.reduce((a, b) => a + b, 0) / xs.length - 40.5;
    sumDy += ys.reduce((a, b) => a + b, 0) / ys.length - 40.5;
  }
  assert.ok(Math.abs(sumDx / N) < 2.5 && Math.abs(sumDy / N) < 2.5, `average drift (${(sumDx / N).toFixed(1)}, ${(sumDy / N).toFixed(1)}) tiles`);
});
