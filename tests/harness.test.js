import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mean, sd, stderr, median, loadBrain, layoutPositions, runOne, runScenario, scalars, summarize,
  pairedDiff, toBaseline, compareToBaseline, formatSummary, formatComparison, worstSeeds, METRICS,
} from "../tools/harness.mjs";

const strip = (run) => ({ ...run, ms: 0 }); // wall-clock time is the one thing that isn't deterministic

test("basic statistics", () => {
  assert.equal(mean([1, 2, 3, 6]), 3);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Math.abs(sd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935) < 1e-8, "sample standard deviation");
  assert.ok(Math.abs(stderr([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935 / Math.sqrt(8)) < 1e-8);
  assert.equal(sd([5]), 0);
  assert.ok(Number.isNaN(mean([])));
});

test("layouts put NPCs inside the map, apart from each other", () => {
  assert.deepEqual(layoutPositions(1, "spread"), [[48, 48]], "a lone NPC starts in the middle");
  for (const layout of ["spread", "cluster"]) {
    for (const n of [1, 2, 3, 7, 12, 20]) {
      const p = layoutPositions(n, layout);
      assert.equal(p.length, n);
      assert.equal(new Set(p.map((q) => q.join(","))).size, n, `${layout} ${n}: distinct`);
      for (const [x, y] of p) assert.ok(x >= 0 && x < 96 && y >= 0 && y < 96, `${layout} ${n}: ${x},${y}`);
    }
  }
  assert.throws(() => layoutPositions(2, "nope"), /unknown layout/);
});

test("brains load by name, by path, and fail with a useful message", async () => {
  const basic = await loadBrain("basic");
  assert.equal(basic.name, "basic");
  assert.equal(typeof basic.fn, "function");
  const idle = await loadBrain("./npcs/idle.js:idle");
  assert.equal(idle.name, "idle:idle");
  assert.equal(typeof idle.fn, "function");
  await assert.rejects(loadBrain("./npcs/idle.js:nope"), /has no export "nope"/);
  await assert.rejects(loadBrain("./npcs/idle.js"), /no default or "brain" export/);
  await assert.rejects(loadBrain("./does-not-exist.js"), /can't load/);
});

test("a scenario is deterministic: same config, same numbers", async () => {
  const brains = [await loadBrain("basic")];
  const cfg = { seeds: [1, 2], ticks: 1500, npcs: 2, brains };
  const a = runScenario(cfg), b = runScenario(cfg);
  assert.deepEqual(a.runs.map(strip), b.runs.map(strip));
  assert.deepEqual(a.config.seeds, [1, 2]);
});

test("per-NPC tallies agree with the world's global stats", async () => {
  const brains = [await loadBrain("basic")];
  const run = runOne({ ticks: 6000, npcs: 3, brains }, 1);
  const sum = (k) => run.npcs.reduce((a, n) => a + n[k], 0);
  assert.equal(sum("meals"), run.stats.meals);
  assert.equal(sum("kills"), run.stats.kills);
  assert.equal(sum("fires"), run.stats.fires);
  assert.ok(run.stats.meals > 0, "the baseline NPC eats something in 6000 ticks");
});

test("an idle NPC starves on schedule, and is counted as dead", async () => {
  const brains = [await loadBrain("idle")];
  const run = runOne({ ticks: 4000, npcs: 1, brains }, 1);
  const n = run.npcs[0];
  assert.equal(n.alive, false);
  assert.ok(n.diedAt >= 1990 && n.diedAt <= 2010, `died at ${n.diedAt}`);
  assert.equal(n.lifetime, n.diedAt);
  const s = scalars(run);
  assert.equal(s.survival, 0);
  assert.ok(Math.abs(s.lifetime - n.diedAt / 4000) < 1e-12);
  assert.equal(s.mealsPer1000, 0);
});

test("mixed populations: NPCs take brains in turn and results can be split per brain", async () => {
  const brains = [await loadBrain("basic"), await loadBrain("idle")];
  const run = runOne({ ticks: 3000, npcs: 4, brains }, 2);
  assert.deepEqual(run.npcs.map((n) => n.brain), ["basic", "idle", "basic", "idle"]);
  assert.equal(scalars(run, "idle").survival, 0);
  assert.equal(scalars(run, "idle").mealsPer1000, 0);
  assert.equal(scalars(run, "basic").survival, 1);
  assert.ok(scalars(run, "basic").mealsPer1000 > 0);
  assert.equal(scalars(run).survival, 0.5, "and the whole population is the mix");
});

// Hand-made runs, so the arithmetic can be checked exactly.
const fake = (seed, { alive, life, meals, kills = 0, herd = [100, 100], grass = 20 }) => ({
  seed, ticks: 1000,
  npcs: [{ id: 1, brain: "x", alive, lifetime: life, diedAt: alive ? null : life, meals, kills, fires: 0 }],
  herd: { end: herd[herd.length - 1], samples: herd }, grassPct: grass, stats: {}, ms: 10,
});

test("metrics are computed as documented", () => {
  const s = scalars(fake(1, { alive: false, life: 500, meals: 3, kills: 4, herd: [100, 60, 0], grass: 12 }));
  assert.equal(s.survival, 0);
  assert.equal(s.lifetime, 0.5);
  assert.equal(s.mealsPer1000, 6, "3 meals in 500 ticks alive = 6 per 1000");
  assert.equal(s.killsPer1000, 8);
  assert.equal(s.herdMean, (100 + 60 + 0) / 3);
  assert.equal(s.herdMin, 0);
  assert.equal(s.herdExtinct, 1, "a sample of zero deer means the herd died out");
  assert.equal(s.grassPct, 12);
  assert.equal(scalars(fake(1, { alive: true, life: 1000, meals: 1 })).herdExtinct, 0);
});

test("paired differences use the same seeds and report a z score", () => {
  const A = [fake(1, { alive: true, life: 1000, meals: 2 }), fake(2, { alive: true, life: 1000, meals: 2 }), fake(3, { alive: true, life: 1000, meals: 2 })];
  const B = [fake(1, { alive: true, life: 1000, meals: 3 }), fake(2, { alive: true, life: 1000, meals: 4 }), fake(3, { alive: true, life: 1000, meals: 5 }), fake(9, { alive: true, life: 1000, meals: 99 })];
  const d = pairedDiff(A, B, "mealsPer1000");
  assert.equal(d.n, 3, "seed 9 has no partner and is ignored");
  assert.equal(d.mean, 2, "b - a: (1+2+3)/3");
  assert.ok(Math.abs(d.se - 1 / Math.sqrt(3)) < 1e-12, "sd of [1,2,3] is 1");
  assert.ok(Math.abs(d.z - 2 / (1 / Math.sqrt(3))) < 1e-9);
  assert.equal(pairedDiff(A, A, "mealsPer1000").z, 0, "no difference: z = 0");
});

test("baselines round-trip, and a change against them is detected", () => {
  const cfg = { brains: [{ name: "x" }], npcs: 1, ticks: 1000, layout: "spread", seeds: [1, 2, 3] };
  const runs = [1, 2, 3].map((s) => fake(s, { alive: true, life: 1000, meals: 2 + s }));
  const result = { config: cfg, runs };
  const saved = JSON.parse(JSON.stringify(toBaseline(result))); // survives being written to disk
  for (const m of METRICS) if (!m.noisy && !m.optional) assert.equal(compareToBaseline(result, saved, m.key).mean, 0, m.key);
  const better = { config: cfg, runs: runs.map((r) => fake(r.seed, { alive: true, life: 1000, meals: r.npcs[0].meals + 2 })) };
  const c = compareToBaseline(better, saved, "mealsPer1000");
  assert.equal(c.mean, 2, "two more meals in 1000 ticks alive is +2 per 1000");
  assert.equal(c.n, 3);
  const worse = { config: cfg, runs: runs.map((r) => fake(r.seed, { alive: true, life: 1000, meals: r.npcs[0].meals - 1 })) };
  assert.equal(compareToBaseline(worse, saved, "mealsPer1000").mean, -1);
  assert.equal(compareToBaseline({ config: cfg, runs: [fake(99, { alive: true, life: 1000, meals: 1 })] }, saved, "mealsPer1000").n, 0, "seeds not in the baseline are ignored");
});

test("reports render without error and mention what they measure", async () => {
  const brains = [await loadBrain("basic"), await loadBrain("idle")];
  const cfg = { seeds: [1, 2], ticks: 2500, npcs: 1 };
  const one = runScenario({ ...cfg, brains: [brains[0]] });
  const text = formatSummary(one, { baseline: toBaseline(one) });
  for (const m of METRICS) if (!m.optional) assert.ok(text.includes(m.label), `missing "${m.label}"`);
  assert.ok(!text.includes("children born"), "the birth rows stay out of the way when nobody had a child");
  assert.match(text, /vs baseline/);
  const two = runScenario({ ...cfg, brains: [brains[1]] });
  const cmp = formatComparison([one, two]);
  assert.match(cmp, /basic/);
  assert.match(cmp, /idle/);
  assert.match(cmp, /difference vs basic/);
  assert.ok(worstSeeds(two).length >= 1, "the idle brain's deaths show up as worst seeds");
  assert.deepEqual(worstSeeds(two).map((w) => w.slice(0, 7)), ["seed 1:", "seed 2:"], "the idle brain starved on both seeds, so both are listed");
  const s = summarize(one.runs);
  assert.equal(s.survival.n, 2);
});

test("birth rows appear once anyone has had a child, and count the whole population", () => {
  const withBirths = (seed) => ({ ...fake(seed, { alive: true, life: 1000, meals: 2 }), stats: { births: 3, childStarved: 1, grewUp: 2 }, humans: { end: 6, samples: [4, 7, 6] } });
  const s = scalars(withBirths(1));
  assert.deepEqual([s.births, s.childStarved, s.grewUp, s.humansEnd, s.humansPeak], [3, 1, 2, 6, 7]);
  const result = { config: { brains: [{ name: "x" }], npcs: 1, ticks: 1000, seeds: [1, 2] }, runs: [withBirths(1), withBirths(2)] };
  const text = formatSummary(result);
  for (const label of ["children born", "children who starved", "children who grew up", "people alive at end", "most people at once"]) assert.ok(text.includes(label), label);
  assert.match(text, /children born\s+3\.00/);
});

test("the command line works end to end", () => {
  const run = (...args) => spawnSync("node", ["tools/bench.mjs", ...args], { encoding: "utf8" });
  let r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: node tools\/bench.mjs/);

  r = run("--seeds", "2", "--ticks", "1200", "--npcs", "1", "--json");
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.runs.length, 2);
  assert.deepEqual(json.config.seeds, [1, 2]);
  assert.ok("survival" in json.runs[0].metrics);

  r = run("--brain", "basic,idle", "--seeds", "2", "--ticks", "1200", "--npcs", "1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /each brain alone/);

  r = run("--sweep-npcs", "1,2", "--seeds", "2", "--ticks", "1200");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no starving/);
  assert.equal(r.stdout.trim().split("\n").filter((l) => /^[12]\s+\d+%/.test(l)).length, 2, "one row per NPC count");
  r = run("--sweep-npcs", "1,2", "--save", "x.json");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /can't be combined/);

  r = run("--bogus");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --bogus/);
  r = run("--brain", "nonexistent");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /can't load|no default/);
  r = run("--brain", "basic,idle", "--save", "x.json");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /one scenario/);
});
