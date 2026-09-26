// What the player can do right now, decided purely from their observation. The keyboard handler
// uses it to build the action to send, and the HUD uses it to show which keys are live and why
// a dead one is dead, so the two can never disagree.
import { facingTarget } from "../sim/actions.js";

const PICKUPS = new Set(["stick", "spear", "raw_meat", "cooked_meat"]);
export const NAMES = { stick: "stick", spear: "spear", raw_meat: "raw meat", cooked_meat: "cooked meat", deer: "deer", fire: "fire" };

// Sim-side failure reasons, in words.
export const FAIL_TEXT = {
  need_spear: "you need a sharpened spear to stab",
  not_facing_target: "face the deer first (move toward it, or use IJKL)",
  no_target_in_reach: "nothing in reach to stab",
  no_lit_fire_in_reach: "you need to be next to a lit fire",
  no_fire_in_reach: "no fire in reach",
  need_two_sticks: "you need two sticks",
  need_raw_meat: "you need raw meat",
  not_edible: "only cooked meat is edible",
  no_such_item: "nothing there to pick up",
};

export const ACTION_KEYS = ["e", "q", "x", "r", "t", "c", "g"];

// { e, q, x, r, t, c, g } -> { label, hold, action } if possible now, or { label, hold, why } if not.
export function actionPlans(obs) {
  const me = obs.self, R = obs.reach;
  const mine = (kind) => me.inventory.filter((e) => e.kind === kind);
  const dist = (e) => Math.sqrt((e.x - me.x) * (e.x - me.x) + (e.y - me.y) * (e.y - me.y));
  // Nearest visible thing on the ground within reach (not merely the first in the list).
  const near = (pred, reach) => {
    let best = null;
    for (const e of obs.view.entities) if (pred(e) && dist(e) <= reach && (!best || dist(e) < dist(best))) best = e;
    return best;
  };
  const yes = (label, action, hold = false) => ({ label, hold, action });
  const no = (label, why, hold = false) => ({ label, hold, why });
  const plans = {};

  const item = near((e) => PICKUPS.has(e.kind), R.pickup);
  plans.e = item ? yes(`Pick up ${NAMES[item.kind]}`, { type: "pickup", item: item.id }) : no("Pick up", "nothing within reach to pick up");

  const stick = mine("stick").sort((a, b) => b.sharpness - a.sharpness)[0]; // the most progressed one
  plans.q = stick ? yes("Sharpen", { type: "sharpen", item: stick.id }, true) : no("Sharpen", "you need a stick to sharpen", true);

  const spear = mine("spear")[0];
  const deer = near((e) => e.kind === "deer", R.stab);
  if (!spear) plans.x = no("Stab", FAIL_TEXT.need_spear);
  else if (!deer) plans.x = no("Stab", "no deer within reach");
  else if (!facingTarget(me.facing, deer.x - me.x, deer.y - me.y, R.stabFacingCos)) plans.x = no("Stab", FAIL_TEXT.not_facing_target);
  else plans.x = yes("Stab", { type: "stab", target: deer.id });

  // Two sticks, least-sharpened first, so a half-sharpened spear-to-be is kept.
  const sticks = mine("stick").sort((a, b) => a.sharpness - b.sharpness);
  plans.r = sticks.length >= 2 ? yes("Make fire", { type: "make_fire", items: [sticks[0].id, sticks[1].id] }) : no("Make fire", FAIL_TEXT.need_two_sticks);

  const unlit = near((e) => e.kind === "fire" && !e.lit, R.fire);
  plans.t = unlit ? yes("Tend fire", { type: "tend", item: unlit.id }, true) : no("Tend fire", "no unlit fire in reach", true);

  const raw = mine("raw_meat")[0], lit = near((e) => e.kind === "fire" && e.lit, R.fire);
  if (raw && lit) plans.c = yes("Cook", { type: "cook", item: raw.id, fire: lit.id }, true);
  else plans.c = no("Cook", raw ? FAIL_TEXT.no_lit_fire_in_reach : FAIL_TEXT.need_raw_meat, true);

  const cooked = mine("cooked_meat")[0];
  plans.g = cooked ? yes("Eat", { type: "eat", item: cooked.id }) : no("Eat", "you have no cooked meat");
  return plans;
}
