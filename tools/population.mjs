#!/usr/bin/env node
// Long-run population dynamics: humans and deer together, over many seeds. Where tools/bench.mjs
// scores a brain over a fixed short window, this watches the whole system for a long time to answer
// a different question: does the population settle into something stable, or does it crash?
//
// usage: node tools/population.mjs [seeds=6] [ticks=150000] [npcs=6] [layout=spread] [mapSize=96]
//
// mapSize keeps the founder count (and so the dominant per-tick cost: human brains) fixed while
// changing the world's area. A bigger map at the same deer-per-1000-tiles density means more total
// deer-carrying-capacity relative to a fixed number of hunters, AND lets spatial refuges emerge
// (places the hunters simply haven't reached yet, where deer can breed undisturbed) -- both real,
// non-cognitive reasons predator-prey systems in nature avoid collapsing as often as a small, fully
// covered map does. Deer/grass are cheap per-tick regardless of map size; only grass regrowth
// (O(area/GRASS_REGROW_PERIOD) per tick) and one-time world generation scale with it.
import { Sim } from "../sim/sim.js";
import { forager, foragerFamily } from "../npcs/forager.js";
import { layoutPositions } from "./harness.mjs";

const seeds = Number(process.argv[2] ?? 6), ticks = Number(process.argv[3] ?? 150000);
const npcs = Number(process.argv[4] ?? 6), layout = process.argv[5] ?? "spread";
const mapSize = Number(process.argv[6] ?? 96);
const every = Math.max(1, Math.floor(ticks / 12));

const humanCount = (s) => s.humanCount();
const deerCount = (s) => { let n = 0; for (const e of s.entities) if (e.kind === "deer" && !e.removed) n++; return n; };

let humanExtinct = 0, deerExtinct = 0, worst = [];
console.log(`population: ${seeds} seed(s) x ${ticks} ticks, ${npcs} founder(s) [${layout}], ${mapSize}x${mapSize} map, brain: forager-family`);
console.log(`(counts sampled every ${every} ticks; H = humans, D = deer)`);
for (let seed = 1; seed <= seeds; seed++) {
  const s = new Sim({ seed, width: mapSize, height: mapSize });
  const pos = layoutPositions(npcs, layout, s.world.width, s.world.height);
  pos.forEach(([x, y]) => s.addActor(foragerFamily, x, y));
  const hSeries = [], dSeries = [];
  let hMin = Infinity, hMax = 0, dMin = Infinity, dMax = 0, hExtinctAt = null, dExtinctAt = null;
  const t0 = performance.now();
  for (let t = 1; t <= ticks; t++) {
    s.step();
    if (t % every === 0) { hSeries.push(humanCount(s)); dSeries.push(deerCount(s)); }
    if (t % 500 === 0) {
      const h = humanCount(s), d = deerCount(s);
      hMin = Math.min(hMin, h); hMax = Math.max(hMax, h);
      dMin = Math.min(dMin, d); dMax = Math.max(dMax, d);
      if (h === 0 && hExtinctAt === null) hExtinctAt = t;
      if (d === 0 && dExtinctAt === null) dExtinctAt = t;
    }
  }
  if (hExtinctAt !== null) humanExtinct++;
  if (dExtinctAt !== null) deerExtinct++;
  if (hExtinctAt !== null || dExtinctAt !== null || hMin === 0) worst.push(seed);
  const st = s.stats;
  console.log(
    `seed ${String(seed).padStart(2)}: H ${hSeries.map((v) => String(v).padStart(3)).join(" ")} | D ${dSeries.map((v) => String(v).padStart(3)).join(" ")}` +
    `\n         H range ${hMin}-${hMax}${hExtinctAt ? ` EXTINCT@${hExtinctAt}` : ""}, D range ${dMin}-${dMax}${dExtinctAt ? ` EXTINCT@${dExtinctAt}` : ""}` +
    ` | births ${st.births} grew up ${st.grewUp} child-starved ${st.childStarved} adult-starved ${st.deathsStarved - st.childStarved} old-age ${st.deathsOld} | ${(performance.now() - t0).toFixed(0)}ms`
  );
}
console.log(`\nhuman extinction: ${humanExtinct}/${seeds} runs | deer extinction: ${deerExtinct}/${seeds} runs`);
if (worst.length) console.log(`seeds to look at: ${worst.join(", ")}`);
