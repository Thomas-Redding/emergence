// A more careful forager, built from the same parts as basic.js (spear, hunt, fire, cook, eat) but with a
// different top-level policy about WHEN to hunt and eat. basic.js overhunts: it eats whenever food < 800
// (wasting up to 300 of a 500 meal) and hunts whenever food < 900 even while carrying cooked meat, so it
// kills nearly twice as many deer as it needs and, in a group, collapses the herd it lives on.
//
// makeForager(options) builds variants so each idea can be measured on its own:
//   eat:     "legacy" (eat when food < 800) | "no-waste" (eat only when the meal fits: food <= cap - meal)
//   gate:    "legacy" (hunt when food < 900) | "reserve" (hunt only when the energy on hand, i.e. food plus
//            carried meat, is below `reserve` meals' worth). This both stockpiles and stops overhunting.
//   reserve: meals of energy to keep on hand (default 2 = a full stomach plus about a meal in the pack)
import { dist, held, around, nearest, walkNear, withMemory } from "./lib.js";
import { getSticks, makeSpear, hunt, cook } from "./basic.js";

export function makeForager({ eat = "no-waste", gate = "reserve", reserve = 2 } = {}) {
  function* brain(obs, rng) {
    const mem = { bad: new Set(), fire: null };
    for (;;) {
      const meal = obs.rules.mealFood, cap = obs.self.foodMax, food = obs.self.food;
      const cooked = held(obs, "cooked_meat")[0], raw = held(obs, "raw_meat")[0];
      const groundMeat = nearest(obs, around(obs, "raw_meat").filter((e) => !mem.bad.has(e.id)));
      const stock = (held(obs, "cooked_meat").length + held(obs, "raw_meat").length) * meal;
      const canEat = eat === "legacy" ? food < 800 : food <= cap - meal;
      const wantsMeat = gate === "legacy" ? food < 900 : food + stock < reserve * meal;

      if (cooked && canEat) {
        obs = yield { type: "eat", item: cooked.id };
      } else if (raw) {
        obs = yield* cook(obs, rng, mem);
      } else if (groundMeat) {
        obs = yield* walkNear(obs, groundMeat.x, groundMeat.y, { within: obs.reach.pickup * 0.9 });
        obs = yield { type: "pickup", item: groundMeat.id };
        if (!obs.lastResult.ok) { mem.bad.add(groundMeat.id); obs = yield* getSticks(obs, rng, held(obs, "stick").length, mem); }
      } else if (held(obs, "stick").length < 2 && nearest(obs, around(obs, "stick").filter((e) => !mem.bad.has(e.id) && dist(obs.self, e) < 8))) {
        // Keep two spare sticks on hand (for the next fire) whenever some are close by.
        obs = yield* getSticks(obs, rng, held(obs, "stick").length + 1, mem);
      } else if (!held(obs, "spear").length) {
        obs = yield* makeSpear(obs, rng, mem);
      } else if (wantsMeat) {
        obs = yield* hunt(obs, rng);
      } else {
        obs = yield { type: "wait" };
      }
    }
  }
  return withMemory(brain);
}

// Named variants (each isolates one change, for benchmarking).
export const foragerNoWaste = makeForager({ eat: "no-waste", gate: "legacy" });
export const foragerR15 = makeForager({ eat: "no-waste", gate: "reserve", reserve: 1.5 });
export const foragerR2 = makeForager({ eat: "no-waste", gate: "reserve", reserve: 2 });
export const foragerR3 = makeForager({ eat: "no-waste", gate: "reserve", reserve: 3 });
export const forager = foragerR2;
