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
//   family:  null (never mates, never feeds anyone: the original forager) or an object turning on family life:
//              mateReserve:    energy on hand (food + carried meat) needed before it will want, or agree to, a child
//              maxDependents:  it won't want another while it has this many children still growing up
//              giveBelow:      feed a child when its estimated food is at or below this
//            With family on, it seeks out other adults when it is fed and idle and proposes to them; answers
//            proposals; feeds its children with `give` on a schedule; counts each child as an extra meal in its
//            hunting reserve; and its children (who run the same brain) get a built-in childhood.
import { dist, held, around, nearest, walkNear, moveToward, randomDir, withMemory, withFamily, withChildhood } from "./lib.js";
import { getSticks, makeSpear, hunt, cook } from "./basic.js";

// Is this person in a position to have a child at all: an adult, off cooldown, with no more growing children than
// it is willing to raise? (Being eligible makes it stock up on food; being fed as well makes it want one.)
function eligible(obs, fam) {
  const r = obs.rules, f = obs.family;
  if (obs.self.age < r.adultAge) return false;
  if (f.lastBirthTick !== null && obs.tick - f.lastBirthTick < r.mate.cooldown) return false;
  return f.kids.filter((k) => k.dependent).length < fam.maxDependents;
}

// Does this person want a child right now? (Also decides whether to say yes when asked.)
function wantsChild(obs, fam) {
  if (!eligible(obs, fam)) return false;
  const me = obs.self, r = obs.rules;
  const stock = (held(obs, "cooked_meat").length + held(obs, "raw_meat").length) * r.mealFood;
  return me.food >= r.mate.minFood + 100 && me.food + stock >= fam.mateReserve;
}

// Bring a child a meal and hand it over. Gives up after a while; the main loop then decides again.
function* feedKid(obs, rng, kidId) {
  for (let i = 0; i < 80; i++) {
    const meal = held(obs, "cooked_meat")[0];
    const kid = obs.family.kids.find((k) => k.id === kidId);
    if (!meal || !kid || !kid.dependent) return obs;
    const seen = obs.view.entities.find((e) => e.id === kidId);
    let action;
    if (seen) {
      if (dist(obs.self, seen) <= obs.reach.give * 0.9) return yield { type: "give", item: meal.id, to: kidId };
      action = moveToward(obs, seen.x, seen.y, { within: obs.reach.give * 0.6 });
    } else if (kid.lastSeen) {
      action = moveToward(obs, kid.lastSeen.x, kid.lastSeen.y, { within: 2 });
    }
    if (!action && !seen) { const d = randomDir(rng); action = { type: "move", dx: d[0], dy: d[1] }; } // not where it was: look around
    obs = yield action ?? { type: "wait" };
  }
  return obs;
}

// Find another adult, go to them, and ask. Returns when it has a child, has been turned down, or has lost interest.
function* seekMate(obs, rng, mem, fam) {
  for (let i = 0; i < 150; i++) {
    for (const e of obs.events) {
      if (e.type === "proposal_result" && e.kind === "mate" && e.outcome !== "accepted") mem.blocked[e.with] = obs.tick + 600; // don't badger them
    }
    if (obs.events.some((e) => e.type === "birth") || !wantsChild(obs, fam)) return obs;
    // someone is asking me: give the reply (which rides along on an action) a tick to go out, then carry on
    if (obs.proposals.incoming.length) return yield { type: "wait" };
    if (obs.proposals.outgoing) { obs = yield { type: "wait" }; continue; } // waiting for an answer

    const mine = new Set(obs.family.kids.map((k) => k.id));
    const ok = (id, adult) => adult && !mine.has(id) && !(mem.blocked[id] > obs.tick);
    const partner = nearest(obs, obs.view.entities.filter((e) => e.kind === "human" && ok(e.id, e.adult)));
    if (partner) {
      if (dist(obs.self, partner) <= obs.reach.talk * 0.8) { obs = yield { type: "wait", propose: { to: partner.id, kind: "mate" } }; continue; }
      obs = yield moveToward(obs, partner.x, partner.y, { within: obs.reach.talk * 0.6 }) ?? { type: "wait" };
      continue;
    }
    // no one in sight: go where an adult was last seen, or wander
    const seenAdults = Object.entries(obs.family.people).filter(([id, p]) => ok(Number(id), p.adult) && obs.tick - p.tick < 3000);
    const last = seenAdults.sort((a, b) => b[1].tick - a[1].tick)[0]?.[1];
    const toward = last ? moveToward(obs, last.x, last.y, { within: 3 }) : null;
    if (toward) obs = yield toward;
    else { const d = randomDir(rng); obs = yield { type: "move", dx: d[0], dy: d[1] }; }
  }
  return obs;
}

export function makeForager({ eat = "no-waste", gate = "reserve", reserve = 2, family = null } = {}) {
  const fam = family && { mateReserve: 1500, maxDependents: 1, giveBelow: 800, ...family };

  function* brain(obs, rng) {
    const mem = { bad: new Set(), fire: null, blocked: {} };
    let stalls = 0;
    for (;;) {
      const tickAtStart = obs.tick;
      const meal = obs.rules.mealFood, cap = obs.self.foodMax, food = obs.self.food;
      const cooked = held(obs, "cooked_meat")[0], raw = held(obs, "raw_meat")[0];
      const groundMeat = nearest(obs, around(obs, "raw_meat").filter((e) => !mem.bad.has(e.id)));
      const stock = (held(obs, "cooked_meat").length + held(obs, "raw_meat").length) * meal;
      const canEat = eat === "legacy" ? food < 800 : food <= cap - meal;
      // each child still growing up is one more mouth: keep a spare meal in hand for it
      const dependents = fam ? obs.family.kids.filter((k) => k.dependent) : [];
      // ...and someone who could have a child stocks up to what a child takes before looking for a partner
      const wantMeals = fam && eligible(obs, fam) ? Math.max(reserve, fam.mateReserve / meal) : reserve;
      const wantsMeat = gate === "legacy" ? food < 900 : food + stock < (wantMeals + dependents.length) * meal;
      const dueKid = fam && cooked ? dependents.filter((k) => k.foodEst <= fam.giveBelow).sort((a, b) => a.foodEst - b.foodEst)[0] : null;

      if (fam && cooked && food < 250) {
        obs = yield { type: "eat", item: cooked.id }; // (starving: a meal for me comes before a meal for the child)
      } else if (dueKid) {
        obs = yield* feedKid(obs, rng, dueKid.id);
      } else if (cooked && canEat) {
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
      } else if (fam && wantsChild(obs, fam)) {
        obs = yield* seekMate(obs, rng, mem, fam);
      } else {
        obs = yield { type: "wait" };
      }
      // A pass that never yields is fine now and then (it changed its mind and decides again), but a brain that
      // keeps doing it freezes the whole game: the tick can't advance until it acts. So break a genuine spin.
      if (obs.tick === tickAtStart) {
        if (++stalls >= 50) { stalls = 0; obs = yield { type: "wait" }; }
      } else stalls = 0;
    }
  }

  // Whatever brain a child inherits, it gets a childhood: withChildhood takes over completely until
  // adulthood (eat what it's given, pick up meat, stay near a parent, never try to hunt) and only then
  // hands off to `brain`. Without this, a child running the plain (non-family) brain could wander into
  // `brain`'s long uninterruptible routines, most dangerously a 200-tick spear-sharpening loop it could
  // never even use (children can't stab) that ignores food given to it mid-loop; a child's food starts
  // low (500) and only drains, so it could starve mid-sharpen with a meal sitting unused in its pack.
  if (!fam) return withMemory(withChildhood(brain));
  // Answer proposals as they come in (riding along on whatever it is doing).
  const reply = (obs) => {
    const asked = obs.proposals.incoming.find((p) => p.kind === "mate");
    return asked ? { to: asked.from, accept: wantsChild(obs, fam) } : null;
  };
  return withMemory(withChildhood(withFamily(brain, { reply })));
}

// Named variants (each isolates one change, for benchmarking).
export const foragerNoWaste = makeForager({ eat: "no-waste", gate: "legacy" });
export const foragerR15 = makeForager({ eat: "no-waste", gate: "reserve", reserve: 1.5 });
export const foragerR2 = makeForager({ eat: "no-waste", gate: "reserve", reserve: 2 });
export const foragerR3 = makeForager({ eat: "no-waste", gate: "reserve", reserve: 3 });
export const forager = foragerR2;
// The same, with family life: it mates, feeds its children, and its children grow up.
export const foragerFamily = makeForager({ eat: "no-waste", gate: "reserve", reserve: 2, family: {} });
