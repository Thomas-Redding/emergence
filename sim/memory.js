// What a character remembers of the map: the most recent state it has seen for each tile.
// Pure bookkeeping over observations; it is not game state (the sim never reads it), so it
// cannot affect determinism. Any brain, NPC or person, can keep one.
//
// A tile's state is its observation char: '.' plains, ',' forest, 'T' tree.
// Tiles never seen are simply absent.
const key = (tx, ty) => ty * 65536 + tx;

export class TileMemory {
  constructor() {
    this.tiles = new Map(); // key -> { c: state char, tick: when it was last seen }
  }

  // Record every tile that is visible in this observation, overwriting older knowledge.
  update(obs) {
    const { x0, y0, tiles } = obs.view;
    for (let j = 0; j < tiles.length; j++) {
      const row = tiles[j], ty = y0 + j;
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (c === "?" || c === "#") continue; // not visible right now / outside the world
        const k = key(x0 + i, ty), e = this.tiles.get(k);
        if (e) { e.c = c; e.tick = obs.tick; } else this.tiles.set(k, { c, tick: obs.tick });
      }
    }
  }

  // { c, tick } for a tile seen at some point, else null.
  get(tx, ty) { return this.tiles.get(key(tx, ty)) ?? null; }

  get size() { return this.tiles.size; }

  // Plain dictionary, e.g. for saving: { "x,y": { c, tick } }.
  toObject() {
    const o = {};
    for (const [k, v] of this.tiles) o[`${k % 65536},${Math.floor(k / 65536)}`] = { ...v };
    return o;
  }
}
