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
export const DEER_RESPAWN_EVERY = 500;
export const STICK_DROP_CHANCE = 0.05;
export const INITIAL_STICKS = 150; // drop attempts at world creation

// Vision. Facing is any unit vector; cone constants are literal (not Math.cos) so results
// can't differ between JS engines. Euclidean range; anything within SENSE_RADIUS is always noticed.
export const SENSE_RADIUS = 1.5;
export const HUMAN_FOV_COS = 0.342; // half-angle 70deg  -> 140deg cone
export const DEER_FOV_COS = -0.866; // half-angle 150deg -> 300deg (blind spot straight behind)
