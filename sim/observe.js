import { VIEW_RADIUS, FOOD_MAX, REACH, STAB_FACING_COS } from "./constants.js";
import { FOREST } from "./worldgen.js";
import { visionGrid, canSeePoint } from "./vision.js";

const PUBLIC_FIELDS = ["sharpness", "cook", "lit", "progress", "fuel"];

// Fresh plain-data copy of an entity: NPC code can never mutate sim state through it.
function publicView(e) {
  const v = { id: e.id, kind: e.kind, x: e.x, y: e.y };
  for (const f of PUBLIC_FIELDS) if (e[f] !== undefined) v[f] = e[f];
  return v;
}

// Everything an NPC may know: its own body, its inventory, and what it can currently SEE
// (a cone in front of it, blocked by trees). Positions are real numbers in tile units.
// Tiles are rows of chars covering the window of tiles around the NPC's tile (origin view.x0,y0):
// '.' plains, ',' forest, 'T' tree, '#' outside the world, '?' not visible right now.
// Remembering is the NPC's job.
export function observe(sim, actor) {
  const R = VIEW_RADIUS, w = sim.world;
  const vis = visionGrid(sim, actor);
  const tiles = [];
  for (let y = vis.y0; y < vis.y0 + vis.N; y++) {
    let row = "";
    for (let x = vis.x0; x < vis.x0 + vis.N; x++) {
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) row += "#";
      else if (!vis.at(x, y)) row += "?";
      else if (w.treeAt[y * w.width + x]) row += "T";
      else row += w.terrain[y * w.width + x] === FOREST ? "," : ".";
    }
    tiles.push(row);
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
    view: { radius: R, x0: vis.x0, y0: vis.y0, tiles, entities },
    lastResult: { ...actor.lastResult },
  };
}
