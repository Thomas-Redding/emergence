import * as C from "./constants.js";

const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });

function held(sim, actor, id, kind) {
  const e = sim.byId(id);
  if (!e || e.removed || e.holder !== actor.id) return null;
  return !kind || e.kind === kind ? e : null;
}
function near(sim, actor, id, kind, reach) {
  const e = sim.byId(id);
  if (!e || e.removed || e.holder != null || (kind && e.kind !== kind)) return null;
  return dist2(e, actor) <= reach * reach ? e : null;
}

// Is the point (dx,dy) away from me within the cone of half-angle acos(minCos) around `facing`?
// (Shared with the UI, so "can I stab now?" is answered by the same rule the sim enforces.)
export function facingTarget(facing, dx, dy, minCos) {
  const l2 = dx * dx + dy * dy;
  return l2 === 0 || facing[0] * dx + facing[1] * dy >= minCos * Math.sqrt(l2);
}

// Any real, non-zero direction; the sim normalizes it (so NPCs can't cheat speed).
function unitDir(a) {
  const dx = a.dx, dy = a.dy;
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return null;
  const k = 1 / Math.sqrt(l2);
  return [dx * k, dy * k];
}

// One tick of one action. Long tasks (sharpening, cooking...) are just this action
// repeated; progress is stored on the item/fire in the world, never on the actor.
const HANDLERS = {
  wait: () => ok(),

  face(sim, a, action) {
    const u = unitDir(action);
    if (!u) return fail("bad_direction");
    a.facing = u;
    return ok();
  },

  move(sim, a, action) {
    const u = unitDir(action);
    if (!u) return fail("bad_direction");
    a.facing = u; // you turn even if the way is blocked
    const speed = action.sneak ? C.SNEAK_SPEED : C.WALK_SPEED;
    a.noisy = !action.sneak;
    if (!sim.moveBody(a, u[0] * speed, u[1] * speed)) return fail("blocked");
    for (const e of sim.entities) if (e.holder === a.id) { e.x = a.x; e.y = a.y; }
    return ok();
  },

  pickup(sim, a, { item }) {
    const e = near(sim, a, item, null, C.REACH.pickup);
    if (!e || e.kind === "human" || e.kind === "deer" || e.kind === "fire") return fail("no_such_item");
    e.holder = a.id;
    e.x = a.x;
    e.y = a.y;
    return ok();
  },

  drop(sim, a, { item }) {
    const e = held(sim, a, item);
    if (!e) return fail("not_held");
    e.holder = null;
    e.x = a.x;
    e.y = a.y;
    return ok();
  },

  sharpen(sim, a, { item }) {
    const e = held(sim, a, item, "stick");
    if (!e) return fail("need_held_stick");
    if (++e.sharpness >= C.SHARPEN_TICKS) e.kind = "spear";
    return ok();
  },

  stab(sim, a, { target }) {
    if (sim.tick - a.born < C.HUMAN_ADULT_TICKS) return fail("too_young"); // children are too weak to hunt
    if (![...sim.entities].some((e) => e.holder === a.id && e.kind === "spear" && !e.removed)) return fail("need_spear");
    const d = sim.byId(target);
    if (!d || d.removed || d.kind !== "deer" || dist2(d, a) > C.REACH.stab * C.REACH.stab) return fail("no_target_in_reach");
    if (!facingTarget(a.facing, d.x - a.x, d.y - a.y, C.STAB_FACING_COS)) return fail("not_facing_target");
    d.removed = true;
    sim.spawn("raw_meat", d.x, d.y, { cook: 0 });
    sim.stats.kills++;
    a.tally.kills++;
    return ok();
  },

  make_fire(sim, a, { items }) {
    if (!Array.isArray(items) || items.length !== 2 || items[0] === items[1]) return fail("need_two_sticks");
    const sticks = items.map((id) => held(sim, a, id, "stick"));
    if (sticks.some((s) => !s)) return fail("need_two_sticks");
    for (const s of sticks) s.removed = true;
    sim.spawn("fire", a.x, a.y, { lit: false, progress: 0, fuel: 0 });
    return ok();
  },

  tend(sim, a, { item }) {
    const f = near(sim, a, item, "fire", C.REACH.fire);
    if (!f) return fail("no_fire_in_reach");
    if (f.lit) return fail("already_lit");
    if (++f.progress >= C.FIRE_BUILD_TICKS) {
      f.lit = true;
      f.fuel = C.FIRE_FUEL;
      sim.stats.fires++;
      a.tally.fires++;
    }
    return ok();
  },

  cook(sim, a, { item, fire }) {
    const m = held(sim, a, item, "raw_meat");
    if (!m) return fail("need_raw_meat");
    const f = near(sim, a, fire, "fire", C.REACH.fire);
    if (!f || !f.lit) return fail("no_lit_fire_in_reach");
    if (++m.cook >= C.COOK_TICKS) m.kind = "cooked_meat";
    return ok();
  },

  eat(sim, a, { item }) {
    const m = held(sim, a, item);
    if (!m) return fail("not_held");
    if (m.kind !== "cooked_meat") return fail("not_edible");
    m.removed = true;
    a.food = Math.min(C.FOOD_MAX, a.food + C.MEAT_FOOD);
    sim.stats.meals++;
    a.tally.meals++;
    return ok();
  },
};

export function applyAction(sim, actor, action) {
  const h = action && typeof action === "object" ? HANDLERS[action.type] : undefined;
  if (!h) return fail("unknown_action");
  // Also say which action this result is for: renderers animate from it.
  return { ...h(sim, actor, action), action: action.type };
}
