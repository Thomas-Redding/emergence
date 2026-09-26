import { VIEW_RADIUS, FOOD_MAX, REACH, STAB_FACING_COS, DEER_FAWN_TICKS } from "./constants.js";
import { FOREST } from "./worldgen.js";
import { visionGrid, canSeePoint } from "./vision.js";

const PUBLIC_FIELDS = ["sharpness", "cook", "lit", "progress", "fuel"];

// Fresh plain-data copy of an entity: NPC code can never mutate sim state through it.
function publicView(e) {
  const v = { id: e.id, kind: e.kind, x: e.x, y: e.y };
  for (const f of PUBLIC_FIELDS) if (e[f] !== undefined) v[f] = e[f];
  if (e.kind === "deer") v.adult = e.age >= DEER_FAWN_TICKS; // a fawn is visibly smaller
  return v;
}

// Everything an NPC may know: its own body, its inventory, and what it can currently SEE
// (a cone in front of it, blocked by trees). Positions are real numbers in tile units.
// Tiles are rows of chars covering the window of tiles around the NPC's tile (origin view.x0,y0):
// '.' plains, ',' forest, 'T' tree, '#' outside the world, '?' not visible right now.
// view.grass is a parallel grid for the same tiles: '0'..'9' = how much grass is there now (9 = full),
// '-' = no grass grows here (a tree), '?' / '#' as above. Deer gather where it is. Grass changes over
// time, so unlike terrain it is only as fresh as when you last looked.
// Remembering is the NPC's job.
export function observe(sim, actor) {
  const R = VIEW_RADIUS, w = sim.world;
  const vis = visionGrid(sim, actor);
  const tiles = [], grass = [];
  for (let y = vis.y0; y < vis.y0 + vis.N; y++) {
    let row = "", grow = "";
    for (let x = vis.x0; x < vis.x0 + vis.N; x++) {
      const i = y * w.width + x;
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) { row += "#"; grow += "#"; }
      else if (!vis.at(x, y)) { row += "?"; grow += "?"; }
      else {
        row += w.treeAt[i] ? "T" : w.terrain[i] === FOREST ? "," : ".";
        const cap = w.grassCap[i];
        grow += cap ? String(Math.min(9, Math.floor((10 * sim.grass[i]) / cap))) : "-";
      }
    }
    tiles.push(row);
    grass.push(grow);
  }
  const entities = [], inventory = [];
  for (const e of sim.entities) {
    if (e.removed || e.id === actor.id) continue;
    if (e.holder === actor.id) inventory.push(publicView(e));
    else if (e.holder == null && canSeePoint(sim, actor, e.x, e.y)) entities.push(publicView(e));
  }
  return {
    tick: sim.tick,
    reach: { ...REACH, stabFacingCos: STAB_FACING_COS },
    self: { id: actor.id, x: actor.x, y: actor.y, facing: [...actor.facing], food: actor.food, foodMax: FOOD_MAX, inventory },
    view: { radius: R, x0: vis.x0, y0: vis.y0, tiles, grass, entities },
    lastResult: { ...actor.lastResult },
  };
}
