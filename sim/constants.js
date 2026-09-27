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
export const REACH = { pickup: 1.0, stab: 1.2, fire: 1.5 };
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

// ---- Grass: what deer eat. Each non-tree tile holds 0..cap units, regrowing slowly. ----
export const GRASS_CAP_PLAINS = 20;
export const GRASS_CAP_FOREST = 10; // forest floor is sparser
export const GRASS_GROWTH_PLAINS = 2; // units regained per visit...
export const GRASS_GROWTH_FOREST = 1;
export const GRASS_REGROW_PERIOD = 1000; // ...and each tile is visited once per this many ticks (staggered)

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
export const DEER_BITE = 1; // grass units eaten per tick while grazing
export const DEER_ENERGY_PER_GRASS = 2;
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
