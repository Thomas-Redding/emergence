// Population harness: run the ecosystem headless for a long time and report how the deer herd
// and the grass behave. Usage: node tools/ecosystem.mjs [seeds=6] [ticks=100000] [npcs=0]
import { Sim } from "../sim/sim.js";
import { basicNpc } from "../npcs/basic.js";

const seeds = Number(process.argv[2] ?? 6), ticks = Number(process.argv[3] ?? 100000), npcs = Number(process.argv[4] ?? 0);
const every = Math.max(1, Math.floor(ticks / 10));

const deerCount = (s) => s.entities.filter((e) => e.kind === "deer" && !e.removed).length;
const grassFrac = (s) => {
  let g = 0, c = 0;
  for (let i = 0; i < s.grass.length; i++) { g += s.grass[i]; c += s.world.grassCap[i]; }
  return g / c;
};

let extinct = 0;
const finals = [];
console.log(`ecosystem: ${seeds} seeds x ${ticks} ticks, ${npcs} NPC(s)`);
console.log(`(deer count at every ${every} ticks; grass = % of capacity)`);
for (let seed = 1; seed <= seeds; seed++) {
  const s = new Sim({ seed });
  for (let i = 0; i < npcs; i++) s.addActor(basicNpc, 40 + i * 8, 48);
  const series = [];
  let min = Infinity, max = 0, minAfter = Infinity;
  const t0 = performance.now();
  for (let t = 1; t <= ticks; t++) {
    s.step();
    if (t % 500 === 0) { const n = deerCount(s); min = Math.min(min, n); max = Math.max(max, n); if (t > ticks / 5) minAfter = Math.min(minAfter, n); }
    if (t % every === 0) series.push(deerCount(s));
  }
  const n = deerCount(s);
  if (n === 0) extinct++;
  finals.push(n);
  const st = s.stats;
  console.log(`seed ${String(seed).padStart(2)}: ${series.map((v) => String(v).padStart(3)).join(" ")} | min ${min} max ${max} | grass ${(100 * grassFrac(s)).toFixed(0)}% | born ${st.deerBorn} starved ${st.deerStarved} old ${st.deerOld} hunted ${st.kills} | ${(performance.now() - t0).toFixed(0)}ms`);
}
console.log(`extinct in ${extinct}/${seeds} runs; final herd sizes: ${finals.join(", ")}`);
