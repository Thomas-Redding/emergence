// Benchmark harness: run brains (and the ecosystem around them) headless, over many seeds, and
// measure how they do. Determinism makes every run reproducible, and running different brains on
// the SAME seeds lets us compare them pairwise, which is far less noisy than comparing averages.
//
// Library API (see tools/bench.mjs for the command line):
//   loadBrain(spec)          -> { name, fn }   "basic" | "path/to/file.js" | "path/to/file.js:exportName"
//   runScenario(config)      -> { config, runs }   one run per seed
//   summarize(runs)          -> { metric: { mean, se, median, min, max, n } }
//   pairedDiff(a, b, metric) -> { n, mean, se, z }      b minus a, matched by seed
//   formatReport(...)        -> string
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Sim } from "../sim/sim.js";

// ---------- small statistics ----------
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
export const stderr = (a) => (a.length ? sd(a) / Math.sqrt(a.length) : NaN);
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// ---------- brains ----------
// Named brains shipped with the repo (paths relative to this file).
const REGISTRY = {
  basic: ["../npcs/basic.js", "basicNpc"],
  idle: ["../npcs/idle.js", "idle"],
  forager: ["../npcs/forager.js", "forager"],
  "forager-nowaste": ["../npcs/forager.js", "foragerNoWaste"], // eat without waste, but hunt as basic does
  "forager-r15": ["../npcs/forager.js", "foragerR15"],
  "forager-r2": ["../npcs/forager.js", "foragerR2"],
  "forager-family": ["../npcs/forager.js", "foragerFamily"], // mates, feeds its children, has a childhood
  "forager-r3": ["../npcs/forager.js", "foragerR3"],
};

export async function loadBrain(spec) {
  let name = spec, url, exportName, shown;
  if (REGISTRY[spec]) {
    [shown, exportName] = REGISTRY[spec];
    url = new URL(shown, import.meta.url);
  } else {
    const at = spec.lastIndexOf(":");
    const hasExport = at > 0 && !/^[A-Za-z]$/.test(spec.slice(0, at)); // (a drive letter isn't an export)
    shown = hasExport ? spec.slice(0, at) : spec;
    exportName = hasExport ? spec.slice(at + 1) : null;
    url = pathToFileURL(path.resolve(shown));
    name = path.basename(shown, ".js") + (exportName ? ":" + exportName : "");
  }
  let mod;
  try { mod = await import(url.href); } catch (err) { throw new Error(`brain "${spec}": can't load ${shown} (${err.message})`); }
  const fn = exportName ? mod[exportName] : mod.default ?? mod.brain;
  if (typeof fn !== "function") {
    throw new Error(`brain "${spec}": ${shown} has no ${exportName ? `export "${exportName}"` : 'default or "brain" export'}, or it isn't a function`);
  }
  return { name, fn };
}

// ---------- where NPCs start ----------
// cluster: bunched near the middle (as in the early experiments). spread: cell centres of a near-square
// grid over the map, so groups don't start by hunting the same patch.
export function layoutPositions(n, layout = "spread", width = 96, height = 96) {
  if (layout === "cluster") return Array.from({ length: n }, (_, i) => [30 + (i % 7) * 6, 40 + Math.floor(i / 7) * 6]);
  if (layout !== "spread") throw new Error(`unknown layout "${layout}" (use "spread" or "cluster")`);
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols), m = 10;
  return Array.from({ length: n }, (_, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    return [Math.round(m + ((width - 2 * m) * (c + 0.5)) / cols), Math.round(m + ((height - 2 * m) * (r + 0.5)) / rows)];
  });
}

// ---------- one run ----------
// config: { seeds|seed, ticks, npcs, layout, brains: [{name, fn}], sampleEvery, sim: {...Sim options} }
// With several brains, NPCs take them in turn (a mixed population competing in one world).
export function runOne(config, seed) {
  const { ticks, npcs, brains, layout = "spread", sampleEvery = 250, sim: simOptions = {} } = config;
  const t0 = performance.now();
  const s = new Sim({ seed, ...simOptions });
  const pos = layoutPositions(npcs, layout, s.world.width, s.world.height);
  const actors = pos.map(([x, y], i) => ({ brain: brains[i % brains.length].name, actor: s.addActor(brains[i % brains.length].fn, x, y) }));

  const herd = [], people = [];
  const deerCount = () => { let n = 0; for (const e of s.entities) if (e.kind === "deer" && !e.removed) n++; return n; };
  for (let t = 1; t <= ticks; t++) {
    s.step();
    if (t % sampleEvery === 0) { herd.push(deerCount()); people.push(s.humanCount()); }
  }
  const herdEnd = deerCount();
  let grass = 0, cap = 0;
  for (let i = 0; i < s.grass.length; i++) { grass += s.grass[i]; cap += s.world.grassCap[i]; }

  const npcRuns = actors.map(({ brain, actor }) => ({
    id: actor.id, brain,
    alive: !actor.removed,
    cause: actor.cause ?? null, // "starvation" | "old_age" | null (still alive)
    lifetime: actor.diedAt ?? ticks, // ticks lived (whatever the cause), capped at the run length
    diedAt: actor.diedAt ?? null,
    meals: actor.tally.meals, kills: actor.tally.kills, fires: actor.tally.fires,
  }));
  return {
    seed, ticks, npcs: npcRuns,
    herd: { end: herdEnd, samples: herd },
    humans: { end: s.humanCount(), samples: people }, // everyone alive, children included
    grassPct: cap ? (100 * grass) / cap : 0,
    stats: { ...s.stats },
    ms: performance.now() - t0,
  };
}

export function runScenario(config) {
  const seeds = config.seeds ?? Array.from({ length: config.seedCount ?? 10 }, (_, i) => i + 1);
  return { config: { ...config, seeds }, runs: seeds.map((seed) => runOne(config, seed)) };
}

// ---------- metrics ----------
// Starving is a brain failing; dying of old age is not. (Hand-made or older data with no cause: not alive = starved.)
const starved = (n) => (n.cause ? n.cause === "starvation" : !n.alive);
const rate = (num, den) => (den > 0 ? (1000 * num) / den : null);
const perBrainFilter = (npcs, brain) => (brain ? npcs.filter((n) => n.brain === brain) : npcs);

// The scalar metrics of one run, optionally for one brain's NPCs only (null = not defined for this run).
export function scalars(run, brain = null) {
  const npcs = perBrainFilter(run.npcs, brain);
  const aliveTicks = npcs.reduce((a, n) => a + n.lifetime, 0);
  const samples = run.herd.samples;
  return {
    survival: npcs.length ? npcs.filter((n) => !starved(n)).length / npcs.length : null, // did not starve
    oldAge: npcs.length ? npcs.filter((n) => n.cause === "old_age").length / npcs.length : null,
    // fraction of the run lived, on average: a starved NPC lived only until it starved; anyone else lived it all
    lifetime: npcs.length ? npcs.reduce((a, n) => a + (starved(n) ? n.lifetime / run.ticks : 1), 0) / npcs.length : null,
    mealsPer1000: rate(npcs.reduce((a, n) => a + n.meals, 0), aliveTicks),
    killsPer1000: rate(npcs.reduce((a, n) => a + n.kills, 0), aliveTicks),
    herdMean: samples.length ? mean(samples) : null,
    herdMin: samples.length ? Math.min(...samples) : null,
    herdExtinct: samples.length ? (samples.some((n) => n === 0) || run.herd.end === 0 ? 1 : 0) : null,
    grassPct: run.grassPct,
    // the human population as a whole (founders plus everyone born): only interesting once brains have children
    humansEnd: run.humans ? run.humans.end : null,
    humansPeak: run.humans && run.humans.samples.length ? Math.max(run.humans.end, ...run.humans.samples) : null,
    births: run.stats.births ?? 0,
    childStarved: run.stats.childStarved ?? 0,
    grewUp: run.stats.grewUp ?? 0,
    msPer1000: (1000 * run.ms) / run.ticks,
  };
}

export const METRICS = [
  { key: "survival", label: "NPCs that didn't starve", kind: "pct", better: "higher" },
  { key: "oldAge", label: "died of old age", kind: "pct" },
  { key: "lifetime", label: "share of run lived", kind: "pct", better: "higher" },
  { key: "mealsPer1000", label: "meals / 1000 ticks alive", kind: "num", better: "higher" },
  { key: "killsPer1000", label: "kills / 1000 ticks alive", kind: "num", better: "higher" },
  { key: "herdMean", label: "deer (mean)", kind: "int" },
  { key: "herdMin", label: "deer (lowest sample)", kind: "int" },
  { key: "herdExtinct", label: "runs where deer died out", kind: "pct", better: "lower" },
  { key: "grassPct", label: "grass left", kind: "pct100" },
  // Shown only in runs where anyone had a child:
  { key: "births", label: "children born", kind: "num", optional: true },
  { key: "childStarved", label: "children who starved", kind: "num", optional: true },
  { key: "grewUp", label: "children who grew up", kind: "num", optional: true },
  { key: "humansEnd", label: "people alive at end", kind: "int", optional: true },
  { key: "humansPeak", label: "most people at once", kind: "int", optional: true },
  { key: "msPer1000", label: "cost (ms / 1000 ticks)", kind: "int", noisy: true },
];

// { metric: { mean, se, median, min, max, n } } across seeds (runs where a metric is undefined are skipped).
export function summarize(runs, brain = null) {
  const out = {};
  const rows = runs.map((r) => scalars(r, brain));
  for (const { key } of METRICS) {
    const v = rows.map((r) => r[key]).filter((x) => x !== null && Number.isFinite(x));
    out[key] = { mean: mean(v), se: stderr(v), median: median(v), min: v.length ? Math.min(...v) : NaN, max: v.length ? Math.max(...v) : NaN, n: v.length };
  }
  return out;
}

// b minus a for one metric, matched by seed. z is how many standard errors the difference is from zero.
export function pairedDiff(runsA, runsB, key, brainA = null, brainB = null) {
  const bySeed = new Map(runsB.map((r) => [r.seed, r]));
  const d = [];
  for (const ra of runsA) {
    const rb = bySeed.get(ra.seed);
    if (!rb) continue;
    const a = scalars(ra, brainA)[key], b = scalars(rb, brainB)[key];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) d.push(b - a);
  }
  const m = mean(d), se = stderr(d);
  return { n: d.length, mean: m, se, z: se > 0 ? m / se : m === 0 ? 0 : Infinity * Math.sign(m) };
}

// ---------- saved baselines ----------
export function toBaseline(result) {
  return {
    version: 1,
    config: {
      brains: result.config.brains.map((b) => b.name), npcs: result.config.npcs, ticks: result.config.ticks,
      layout: result.config.layout ?? "spread", seeds: result.config.seeds,
    },
    runs: result.runs.map((r) => ({ seed: r.seed, metrics: scalars(r) })),
  };
}

// Paired comparison of a fresh result against a saved baseline, per metric.
export function compareToBaseline(result, baseline, key) {
  const base = new Map(baseline.runs.map((r) => [r.seed, r.metrics]));
  const d = [];
  for (const r of result.runs) {
    const b = base.get(r.seed);
    if (!b) continue;
    const now = scalars(r)[key], then = b[key];
    if (now !== null && then !== null && Number.isFinite(now) && Number.isFinite(then)) d.push(now - then);
  }
  const m = mean(d), se = stderr(d);
  return { n: d.length, mean: m, se, z: se > 0 ? m / se : m === 0 ? 0 : Infinity * Math.sign(m) };
}

// ---------- formatting ----------
const fmt = (kind, v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  if (kind === "pct") return (100 * v).toFixed(0) + "%";
  if (kind === "pct100") return v.toFixed(0) + "%";
  if (kind === "int") return v.toFixed(0);
  return v.toFixed(2);
};
const fmtSigned = (kind, v) => {
  if (!Number.isFinite(v)) return "-";
  const s = fmt(kind, Math.abs(v));
  return (v < 0 ? "-" : "+") + s;
};
const star = (z) => (Math.abs(z) >= 3 ? "**" : Math.abs(z) >= 2 ? "*" : "");
const pad = (s, n) => String(s).padStart(n);

export function describeConfig(config) {
  return `${config.seeds.length} seed(s) x ${config.ticks} ticks, ${config.npcs} NPC(s) [${config.layout ?? "spread"}], brains: ${config.brains.map((b) => b.name).join(" + ")}`;
}

// One table for one result: mean +- se, median, range.
export function formatSummary(result, { brain = null, baseline = null } = {}) {
  const sum = summarize(result.runs, brain);
  const lines = [];
  lines.push(`${"".padEnd(28)} ${pad("mean", 7)} ${pad("+-se", 6)} ${pad("median", 7)} ${pad("min", 6)} ${pad("max", 6)}${baseline ? "   vs baseline (paired)" : ""}`);
  for (const m of METRICS) {
    const s = sum[m.key];
    if (m.optional && !(sum.births.max > 0)) continue; // no one had a child: don't clutter the report
    if (brain && (m.key.startsWith("herd") || m.key === "grassPct" || m.key === "msPer1000")) continue; // world-wide, not per brain
    let row = `${m.label.padEnd(28)} ${pad(fmt(m.kind, s.mean), 7)} ${pad(s.n > 1 ? fmt(m.kind, s.se) : "-", 6)} ${pad(fmt(m.kind, s.median), 7)} ${pad(fmt(m.kind, s.min), 6)} ${pad(fmt(m.kind, s.max), 6)}`;
    if (baseline && !m.noisy) {
      const c = compareToBaseline(result, baseline, m.key);
      row += `   ${fmtSigned(m.kind, c.mean)} (z=${Number.isFinite(c.z) ? c.z.toFixed(1) : "inf"}${star(c.z)})`;
    }
    lines.push(row);
  }
  return lines.join("\n");
}

// Which seeds went worst, to look at next: any NPC deaths or a herd extinction.
export function worstSeeds(result, limit = 5) {
  const rows = result.runs.map((r) => ({ seed: r.seed, deaths: r.npcs.filter(starved).length, extinct: scalars(r).herdExtinct === 1 }));
  return rows.filter((r) => r.deaths || r.extinct).sort((a, b) => b.deaths - a.deaths).slice(0, limit)
    .map((r) => `seed ${r.seed}: ${r.deaths} NPC starvation(s)${r.extinct ? ", deer died out" : ""}`);
}

// Several brains, each run alone on the same seeds: side-by-side means and a paired diff against the first.
export function formatComparison(results) {
  const first = results[0];
  const lines = [];
  const names = results.map((r) => r.config.brains[0].name);
  lines.push(`${"".padEnd(28)} ${names.map((n) => pad(n.slice(0, 16), 16)).join(" ")}   difference vs ${names[0]} (paired, +-se)`);
  const sums = results.map((r) => summarize(r.runs));
  for (const m of METRICS) {
    if (m.optional && !sums.some((x) => x.births.max > 0)) continue;
    const cells = sums.map((s) => pad(`${fmt(m.kind, s[m.key].mean)}${s[m.key].n > 1 ? " +-" + fmt(m.kind, s[m.key].se) : ""}`, 16));
    let diffs = "";
    if (!m.noisy) {
      diffs = results.slice(1).map((r) => {
        const d = pairedDiff(first.runs, r.runs, m.key);
        return `${fmtSigned(m.kind, d.mean)} +-${fmt(m.kind, d.se)} (z=${Number.isFinite(d.z) ? d.z.toFixed(1) : "inf"}${star(d.z)})`;
      }).join("  ");
    }
    lines.push(`${m.label.padEnd(28)} ${cells.join(" ")}   ${diffs}`);
  }
  return lines.join("\n");
}

// One row per scenario, for sweeps such as "how does it cope as the number of NPCs grows?".
// results: [{ label, result }]
export function formatSweep(rows, labelName = "NPCs") {
  const cols = [
    ["survival", "no starving", "pct"], ["lifetime", "run lived", "pct"], ["mealsPer1000", "meals/1000", "num"],
    ["killsPer1000", "kills/1000", "num"], ["herdMean", "deer mean", "int"], ["herdMin", "deer low", "int"],
    ["herdExtinct", "deer died out", "pct"], ["msPer1000", "ms/1000", "int"],
  ];
  const lines = [labelName.padEnd(6) + cols.map(([, h]) => pad(h, 14)).join("")];
  for (const { label, result } of rows) {
    const sum = summarize(result.runs);
    lines.push(String(label).padEnd(6) + cols.map(([k, , kind]) => pad(`${fmt(kind, sum[k].mean)}${sum[k].n > 1 && kind !== "int" ? " +-" + fmt(kind, sum[k].se) : ""}`, 14)).join(""));
  }
  return lines.join("\n");
}
