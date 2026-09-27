#!/usr/bin/env node
// Benchmark brains headless. See `node tools/bench.mjs --help`.
import fs from "node:fs";
import { loadBrain, runScenario, toBaseline, formatSummary, formatComparison, formatSweep, describeConfig, worstSeeds } from "./harness.mjs";

const HELP = `Benchmark NPC brains over many seeds (deterministic: the same command gives the same numbers,
apart from the speed line).

usage: node tools/bench.mjs [options]

  --brain a[,b,...]     brains to run: a name ("basic") or a file, "path/to/brain.js" (default export or
                        "brain") or "path/to/brain.js:exportName". Default: basic
  --mode separate|mixed with several brains: "separate" (default) runs each alone on the same seeds and
                        compares them pairwise; "mixed" puts them in ONE world, taking NPC slots in turn
  --npcs N              NPCs per run (default 3)
  --sweep-npcs 1,3,8    run the scenario at each NPC count and print one row per count (how does it cope
                        as the population grows?). Not combined with --save/--baseline
  --seeds N             seeds 1..N (default 20)         --seed-list 1,5,9   explicit seeds
  --ticks N             run length (default 10000; 20 ticks = 1 second of game time at speed x1)
  --layout spread|cluster   where NPCs start (default spread)
  --sample N            sample the deer count every N ticks (default 250)
  --save FILE           save per-seed results as a baseline (single scenario only)
  --baseline FILE       compare against a saved baseline, paired by seed (z >= 2 marked *, >= 3 **)
  --json                print machine-readable JSON instead of tables
  --help

examples
  node tools/bench.mjs                                   # the baseline NPC, 3 NPCs, 20 seeds
  node tools/bench.mjs --npcs 8 --ticks 30000
  node tools/bench.mjs --sweep-npcs 1,3,6,10 --seeds 8       # how many NPCs can the world sustain?
  node tools/bench.mjs --save tools/baselines/basic.json
  node tools/bench.mjs --baseline tools/baselines/basic.json   # after changing the NPC
  node tools/bench.mjs --brain basic,./mybrain.js       # compare two brains, same seeds
  node tools/bench.mjs --brain basic,./mybrain.js --mode mixed --npcs 6   # compete in one world
`;

function parseArgs(argv) {
  const opts = { brain: "basic", mode: "separate", npcs: 3, seeds: 20, seedList: null, sweepNpcs: null, ticks: 10000, layout: "spread", sample: 250, save: null, baseline: null, json: false };
  const need = (i, flag) => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[i + 1]; };
  const num = (v, flag) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number, got "${v}"`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { opts.help = true; }
    else if (a === "--json") opts.json = true;
    else if (a === "--brain") opts.brain = need(i++, a);
    else if (a === "--mode") opts.mode = need(i++, a);
    else if (a === "--npcs") opts.npcs = num(need(i++, a), a);
    else if (a === "--sweep-npcs") opts.sweepNpcs = need(i++, a).split(",").map((x) => num(x, a));
    else if (a === "--seeds") opts.seeds = num(need(i++, a), a);
    else if (a === "--seed-list") opts.seedList = need(i++, a).split(",").map((x) => num(x, a));
    else if (a === "--ticks") opts.ticks = num(need(i++, a), a);
    else if (a === "--layout") opts.layout = need(i++, a);
    else if (a === "--sample") opts.sample = num(need(i++, a), a);
    else if (a === "--save") opts.save = need(i++, a);
    else if (a === "--baseline") opts.baseline = need(i++, a);
    else throw new Error(`unknown option ${a} (try --help)`);
  }
  if (!["separate", "mixed"].includes(opts.mode)) throw new Error(`--mode must be separate or mixed, got "${opts.mode}"`);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const brains = [];
  for (const spec of opts.brain.split(",").filter(Boolean)) brains.push(await loadBrain(spec));
  const seeds = opts.seedList ?? Array.from({ length: opts.seeds }, (_, i) => i + 1);
  const base = { seeds, ticks: opts.ticks, npcs: opts.npcs, layout: opts.layout, sampleEvery: opts.sample };
  if (opts.sweepNpcs && (opts.save || opts.baseline)) throw new Error("--sweep-npcs prints a table and can't be combined with --save/--baseline");
  const separate = !opts.sweepNpcs && brains.length > 1 && opts.mode === "separate";
  if (separate && (opts.save || opts.baseline)) throw new Error("--save/--baseline work on one scenario: use a single brain, or --mode mixed");

  if (opts.sweepNpcs) {
    const rows = opts.sweepNpcs.map((n) => ({ label: n, result: runScenario({ ...base, npcs: n, brains }) }));
    if (opts.json) console.log(JSON.stringify(rows.map(({ label, result }) => ({ npcs: label, ...toBaseline(result) })), null, 1));
    else {
      console.log(describeConfig({ ...base, npcs: opts.sweepNpcs.join("/"), brains }) + (brains.length > 1 ? "  [mixed: one world]" : "") + "\n");
      console.log(formatSweep(rows));
    }
    return;
  }

  const scenarios = separate ? brains.map((b) => runScenario({ ...base, brains: [b] })) : [runScenario({ ...base, brains })];
  const baseline = opts.baseline ? JSON.parse(fs.readFileSync(opts.baseline, "utf8")) : null;

  if (opts.json) {
    console.log(JSON.stringify(separate ? scenarios.map(toBaseline) : toBaseline(scenarios[0]), null, 1));
  } else if (separate) {
    console.log(describeConfig({ ...base, brains }) + "  [each brain alone, same seeds]\n");
    console.log(formatComparison(scenarios));
  } else {
    const r = scenarios[0];
    console.log(describeConfig(r.config) + (brains.length > 1 ? "  [mixed: one world]" : "") + "\n");
    if (baseline) console.log(`(vs baseline: ${baseline.config.brains.join("+")}, ${baseline.config.npcs} NPC(s), ${baseline.config.ticks} ticks, ${baseline.config.seeds.length} seeds)\n`);
    console.log(formatSummary(r, { baseline }));
    if (brains.length > 1) {
      for (const b of brains) console.log(`\n-- ${b.name} only (its NPCs across all seeds) --\n` + formatSummary(r, { brain: b.name }));
    }
    const worst = worstSeeds(r);
    if (worst.length) console.log(`\nworst seeds: ${worst.join("; ")}`);
    if (opts.save) {
      fs.mkdirSync(opts.save.replace(/[^/]*$/, "") || ".", { recursive: true });
      fs.writeFileSync(opts.save, JSON.stringify(toBaseline(r), null, 1) + "\n");
      console.log(`\nsaved baseline to ${opts.save}`);
    }
  }
}

main().catch((err) => { console.error("error: " + err.message); process.exit(1); });
