// The HUD as data: what to show for a character, computed from its observation. Pure logic (no
// DOM), so it is unit-tested; ui/hud.js turns it into HTML.
import { SHARPEN_TICKS, FIRE_BUILD_TICKS, FIRE_FUEL, COOK_TICKS, MEAT_FOOD, TICKS_PER_SECOND } from "../sim/constants.js";
import { actionPlans, ACTION_KEYS, NAMES } from "./controls.js";

const pct = (f) => `${Math.round(f * 100)}%`;
const ORDER = { spear: 0, stick: 1, raw_meat: 2, cooked_meat: 3 };

// One slot per kind, stacking identical items (so "stick ×2"); an item with progress on it
// (a stick being sharpened, meat being cooked) gets its own slot and a progress bar.
function slotsOf(inventory) {
  const slots = new Map();
  for (const it of inventory) {
    const inProgress = (it.kind === "stick" && it.sharpness > 0) || (it.kind === "raw_meat" && it.cook > 0);
    const key = inProgress ? `${it.kind}#${it.id}` : it.kind;
    let s = slots.get(key);
    if (!s) {
      s = { key, kind: it.kind, name: NAMES[it.kind] ?? it.kind, count: 0, frac: null, detail: "", progress: inProgress };
      slots.set(key, s);
    }
    s.count++;
    if (it.kind === "stick") {
      s.frac = it.sharpness > 0 ? it.sharpness / SHARPEN_TICKS : null;
      s.detail = it.sharpness > 0 ? `sharpening ${pct(s.frac)}. Hold Q to keep going` : "Hold Q to sharpen it into a spear. Two sticks make a fire (R)";
    } else if (it.kind === "spear") s.detail = "sharp. Face a deer and press X to stab";
    else if (it.kind === "raw_meat") {
      s.frac = it.cook > 0 ? it.cook / COOK_TICKS : null;
      s.detail = it.cook > 0 ? `cooking ${pct(s.frac)}. Keep holding C beside the fire` : "Hold C beside a lit fire to cook it";
    } else if (it.kind === "cooked_meat") s.detail = `ready to eat. Press G (+${MEAT_FOOD} food)`;
  }
  const list = [...slots.values()];
  list.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || (b.progress ? 1 : 0) - (a.progress ? 1 : 0));
  return list;
}

function foodOf(self) {
  const frac = Math.max(0, Math.min(1, self.food / self.foodMax));
  return { value: Math.round(self.food), max: self.foodMax, frac, level: frac < 0.15 ? "critical" : frac < 0.4 ? "low" : "ok" };
}

// Age as game time (mm:ss at speed x1), and whether they are still a child.
function ageOf(obs) {
  const ticks = obs.self.age ?? 0, secs = Math.floor(ticks / TICKS_PER_SECOND);
  return { ticks, adult: ticks >= (obs.rules?.adultAge ?? 0), text: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` };
}

// The nearest fire within reach, if any.
function fireOf(obs) {
  const me = obs.self;
  let best = null, bd = Infinity;
  for (const e of obs.view.entities) {
    if (e.kind !== "fire") continue;
    const d = Math.sqrt((e.x - me.x) * (e.x - me.x) + (e.y - me.y) * (e.y - me.y));
    if (d <= obs.reach.fire && d < bd) { best = e; bd = d; }
  }
  if (!best) return null;
  return best.lit
    ? { lit: true, frac: best.fuel / FIRE_FUEL, text: "burning", detail: "Hold C to cook raw meat here" }
    : { lit: false, frac: best.progress / FIRE_BUILD_TICKS, text: `building ${pct(best.progress / FIRE_BUILD_TICKS)}`, detail: "Hold T to light it" };
}

// A pending proposal, as ticks left rather than an absolute tick (so the HUD doesn't need obs.tick).
const withTicksLeft = (p, tick) => (p ? { ...p, left: Math.max(0, p.expires - tick) } : null);

// isPlayer: also show which actions are available, and any pending proposal to answer or wait on
// (for a selected NPC we only show its inventory).
export function buildHud(obs, { isPlayer }) {
  const model = { age: ageOf(obs), sex: obs.self.sex, food: foodOf(obs.self), slots: slotsOf(obs.self.inventory), fire: fireOf(obs), actions: [], speech: null };
  if (isPlayer) {
    const plans = actionPlans(obs);
    model.actions = ACTION_KEYS.map((k) => ({ key: k.toUpperCase(), label: plans[k].label, hold: plans[k].hold, enabled: !!plans[k].action, why: plans[k].why ?? null }));
    model.speech = {
      incoming: withTicksLeft(obs.proposals.incoming[0] ?? null, obs.tick),
      outgoing: withTicksLeft(obs.proposals.outgoing, obs.tick),
    };
  }
  return model;
}
