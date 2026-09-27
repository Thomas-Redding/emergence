// FNV-1a over a canonical serialization of sim state, for determinism checks.
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);

export function hashState(sim) {
  let h = 2166136261;
  const mix = (n) => {
    h = Math.imul(h ^ (n | 0), 16777619);
  };
  const mixFloat = (x) => { // exact bits, so any drift in a position shows up
    f64[0] = x;
    mix(u32[0]);
    mix(u32[1]);
  };
  mix(sim.tick);
  for (const e of sim.entities) {
    mix(e.id);
    mix(e.kind.charCodeAt(0));
    mixFloat(e.x);
    mixFloat(e.y);
    mix(e.holder ?? -1);
    for (const f of ["sharpness", "cook", "progress", "fuel", "food", "fleeTicks", "moveTicks", "energy", "age", "lifespan", "breedCooldown", "born"]) mix(e[f] ?? 0);
    mix(e.grazing ? 1 : 0);
    if (e.target) { mix(e.target[0]); mix(e.target[1]); }
    mix(e.lit ? 1 : 0);
    if (e.facing) { mixFloat(e.facing[0]); mixFloat(e.facing[1]); }
  }
  for (let i = 0; i < sim.grass.length; i++) mix(sim.grass[i]); // the grass is world state too
  // Speech is world state: pending proposals, decline cooldowns, and undelivered events.
  mix(sim.nextProposalId);
  for (const p of sim.proposals) { mix(p.id); mix(p.kind.charCodeAt(0)); mix(p.from); mix(p.to); mix(p.createdTick); mix(p.expires); }
  for (const [k, v] of sim.declineUntil) { for (let i = 0; i < k.length; i++) mix(k.charCodeAt(i)); mix(v); }
  for (const e of sim.entities) if (e.inbox) for (const ev of e.inbox) { mix(ev.type.charCodeAt(0)); mix(ev.type.length); mix(ev.id ?? 0); mix(ev.from ?? ev.to ?? ev.with ?? 0); }
  for (const k of Object.keys(sim.stats)) mix(sim.stats[k]);
  return (h >>> 0).toString(16).padStart(8, "0");
}
