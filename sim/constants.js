export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export const VIEW_RADIUS = 10;

export const SHARPEN_TICKS = 200; // per-item progress: stick -> spear
export const FIRE_BUILD_TICKS = 30; // progress on an unlit fire until it lights
export const FIRE_FUEL = 800;
export const COOK_TICKS = 60; // per-item progress: raw_meat -> cooked_meat

export const FOOD_MAX = 1000;
export const FOOD_START = 1000;
export const MEAT_FOOD = 500;
export const FOOD_DECAY_EVERY = 2; // ticks per point of food lost

// Positions are real numbers in tile units: tile (i,j) covers [i,i+1) x [j,j+1).
// Determinism note: sim code uses only + - * / and Math.sqrt (IEEE-exact); never Math.hypot, **, or trig.
export const WALK_SPEED = 0.5; // tiles per tick
export const SNEAK_SPEED = 0.25;
export const BODY_HALF = 0.3; // creatures are squares 0.6 wide; trees fill whole tiles

// How close you must be (distance between positions) to act on something.
export const REACH = { pickup: 1.0, stab: 1.2, fire: 1.5, give: 1.5 };
// To stab you must be facing the target: within 60deg of your facing (literal cos, see exact-math note).
export const STAB_FACING_COS = 0.5;

// Deer perception: noisy (walking normally) vs quiet (sneaking / doing anything else)
export const NOISY_RADIUS = 6;
export const NOISY_NOTICE = 0.3;
export const QUIET_RADIUS = 2;
export const QUIET_NOTICE = 0.03;
export const FLEE_TICKS = 12;
export const DEER_WANDER_CHANCE = 0.03; // per tick, while resting: start a short walk
export const DEER_WANDER_SPEED = 0.2;
export const DEER_FLEE_SPEED = 0.9; // faster than a human's 0.5
export const STICK_DROP_CHANCE = 0.05;
export const INITIAL_STICKS = 150; // drop attempts at world creation

// Vision. Facing is any unit vector; cone constants are literal (not Math.cos) so results
// can't differ between JS engines. Euclidean range; anything within SENSE_RADIUS is always noticed.
export const SENSE_RADIUS = 1.5;
export const HUMAN_FOV_COS = 0.342; // half-angle 70deg  -> 140deg cone
export const DEER_FOV_COS = -0.866; // half-angle 150deg -> 300deg (blind spot straight behind)

// ---- Grass: what deer eat. Held only in meadow patches (below), each patch tile 0..cap units,
// regrowing slowly. (GRASS_CAP_PLAINS/FOREST are also used directly by tests that build their own
// uniform-grass test arenas, bypassing worldgen's patches entirely.) ----
export const GRASS_CAP_PLAINS = 20;
export const GRASS_CAP_FOREST = 10; // forest floor is sparser
export const GRASS_GROWTH_PLAINS = 2; // units regained per visit...
export const GRASS_GROWTH_FOREST = 1;
export const GRASS_REGROW_PERIOD = 1000; // ...and each tile is visited once per this many ticks (staggered)

// ---- Meadows: grass grows on a scattered fraction of tiles, not every tile. This is why: a deer
// grazes opportunistically on whatever tile it is standing on, tick by tick, as it walks -- so if
// EVERY tile carries a little grass, a deer's whole wander path gets nibbled, tracing a visible line
// wherever it went. Each non-tree tile independently has a GRASS_PATCH_COVERAGE chance of being a
// "meadow" tile at world-gen time (not clustered into contiguous patches): scattered because a loose,
// occasional trace of grazed tiles along a deer's path is a feature, not a bug -- it's what would make
// tracking a deer possible later, just not trivial (an unbroken clustered blob would either show
// nothing at all between meadows, or a dead giveaway solid line once inside one).
// Each meadow tile holds about 1/GRASS_PATCH_COVERAGE times as much grass as the old uniform tiles
// did, so total grass supply is about the same as before, just held by fewer tiles.
// Regrowth-per-visit is deliberately NOT scaled up to match (still GRASS_GROWTH_PLAINS/FOREST above):
// a grazed meadow tile takes much longer, relative to its own capacity, to refill than a single old
// tile did, so under any ordinary ambient grazing it never reaches full uniform lushness.
export const GRASS_PATCH_COVERAGE = 0.15; // chance any given non-tree tile is a meadow tile
export const GRASS_PATCH_CAP_PLAINS = 130; // ~ GRASS_CAP_PLAINS / GRASS_PATCH_COVERAGE
export const GRASS_PATCH_CAP_FOREST = 65; // ~ GRASS_CAP_FOREST / GRASS_PATCH_COVERAGE
// Growth-per-visit is ALSO scaled up by ~1/coverage (so total map-wide regrowth throughput, not just
// standing capacity, comes out close to what the old uniform tiles produced -- a first "leave it
// unscaled" attempt starved the whole herd even with zero hunters, since concentrating grass into 15%
// of the tiles cut total throughput to about that fraction of before). Recovery TIME per tile (cap /
// growth) ends up about the same as an old uniform tile's did.
export const GRASS_PATCH_GROWTH_PLAINS = 18;
export const GRASS_PATCH_GROWTH_FOREST = 10;

// How the world starts (only shapes the opening; the herd then finds its own size).
// Chosen with a parameter sweep (8 seeds): the steady herd (~120 on the default map) doesn't depend on
// these, but the opening boom does. Starting with fewer grass units flattens it a lot, and more starting
// deer make it bigger, so: about twice the old herd, on a world that starts partly grazed down.
export const GRASS_START_FRACTION = 0.2; // of each tile's capacity
export const DEER_START_PER_1000_TILES = 8; // 73 deer on the default 96x96 map

// ---- Deer life cycle. Time is in ticks (20 per second in the browser). ----
export const DEER_ENERGY_MAX = 1000;
export const DEER_METAB_EVERY = 4; // one energy lost per this many ticks (starve in ~4000 ticks)
export const DEER_HUNGRY = 600; // start grazing below this...
export const DEER_FULL = 950; // ...and stop at this
export const DEER_BITE = 1; // grass units eaten per tick while grazing (removal rate is flat: see below)
// How much energy a bitten unit of grass is worth depends on the tile's lushness (grass / cap), not
// just a flat rate: a bite from a nearly-bare tile is worth less than a bite from a lush one. This is
// what makes "go a bit farther for much better grass" a real, boundable tradeoff -- richness maxes out
// at DEER_ENERGY_PER_GRASS_MAX regardless of how big the meadow is, unlike raw standing grass (which
// scales with meadow size and would make one huge meadow look unbeatable from anywhere on the map).
export const DEER_ENERGY_PER_GRASS_MIN = 2; // at a bare-minimum (DEER_MIN_PATCH) tile
export const DEER_ENERGY_PER_GRASS_MAX = 5; // at a fully lush (cap) tile
export const DEER_MIN_PATCH = 3; // a tile is worth walking to if it has at least this much
export const DEER_SEARCH_NEAR = 8; // tiles: look this far for grass first, then...
export const DEER_SEARCH_FAR = 20; // ...this far
export const DEER_GRAZE_SPEED = 0.25; // tiles per tick when walking to grass
export const DEER_ROAM_TICKS = 60; // a starving deer with no grass in range walks this long (+ up to as much again) in one direction
export const DEER_FAWN_TICKS = 1500; // age at which a fawn becomes an adult
export const DEER_LIFESPAN_MIN = 20000; // old-age death is rolled per deer in [MIN, MIN + SPREAD)
export const DEER_LIFESPAN_SPREAD = 10000;
export const DEER_BREED_ENERGY = 800; // must be at least this well fed to breed
export const DEER_BREED_CHANCE = 0.0025; // per tick once eligible
export const DEER_BREED_COOLDOWN = 2500;
export const DEER_BIRTH_COST = 250; // energy the parent spends
export const DEER_FAWN_ENERGY = 500;
export const DEER_MATE_RADIUS = 20; // an adult deer must have another adult within this many tiles to breed
export const DEER_MAX = 300; // safety cap so a runaway can't stall the sim

export const TICKS_PER_SECOND = 20; // the browser's rate at speed x1: how ticks map to game time

// ---- Human life cycle (ticks; 20 per second at speed x1, so 1,000 ticks = 50 seconds) ----
export const HUMAN_ADULT_TICKS = 4000; // a person is a child until this age (children matter once there are births)
export const HUMAN_LIFESPAN_MIN = 60000; // old-age death is rolled per person in [MIN, MIN + SPREAD): 50-75 min at x1
export const HUMAN_LIFESPAN_SPREAD = 30000;

// ---- Speech: proposals between people (asking, and being answered) ----
export const TALK_RANGE = 4; // you can only propose to, and answer, someone within this many tiles
export const PROPOSAL_TICKS = 100; // an unanswered proposal expires after this long
export const DECLINE_COOLDOWN = 200; // after "no", the same person can't ask the same person again for this long
export const INBOX_MAX = 32; // events queued for a brain that never reads them are dropped, oldest first

// ---- Births (a "mate" proposal that is accepted; tuned later with the harness) ----
export const HUMAN_MATE_MIN_FOOD = 600; // both parents must be at least this well fed to agree to mate
export const HUMAN_BIRTH_COST = 250; // food each parent spends (half a meal)
export const HUMAN_BIRTH_COOLDOWN = 4000; // before either parent can have another child
export const HUMAN_CHILD_FOOD = 500; // a newborn starts with this much: it starves in ~1000 ticks unless fed
export const HUMAN_MAX = 40; // safety cap on the number of living people
