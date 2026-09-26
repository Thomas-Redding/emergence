import { makeRng, deriveSeed } from "./rng.js";
import { GRASS_CAP_PLAINS, GRASS_CAP_FOREST, GRASS_GROWTH_PLAINS, GRASS_GROWTH_FOREST } from "./constants.js";

export const PLAINS = 0;
export const FOREST = 1;

// Integer-lattice hash -> [0,1)
function lattice(seed, x, y) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise(seed, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = lattice(seed, x0, y0), b = lattice(seed, x0 + 1, y0);
  const c = lattice(seed, x0, y0 + 1), d = lattice(seed, x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function generateWorld(seed, width, height) {
  const noiseSeed = deriveSeed(seed, "terrain") | 0;
  const rng = makeRng(deriveSeed(seed, "worldgen-objects"));
  const terrain = new Uint8Array(width * height);
  const treeAt = new Uint8Array(width * height);
  const trees = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = 0.65 * valueNoise(noiseSeed, x / 16, y / 16) +
                0.35 * valueNoise(noiseSeed + 1, x / 6, y / 6);
      const i = y * width + x;
      terrain[i] = n > 0.55 ? FOREST : PLAINS;
      if (terrain[i] === FOREST && rng.chance(0.35)) {
        treeAt[i] = 1;
        trees.push({ x, y });
      }
    }
  }

  // How much grass each tile can hold (none under trees) and how fast it regrows.
  const grassCap = new Uint8Array(width * height), grassGrowth = new Uint8Array(width * height);
  for (let i = 0; i < grassCap.length; i++) {
    if (treeAt[i]) continue;
    grassCap[i] = terrain[i] === FOREST ? GRASS_CAP_FOREST : GRASS_CAP_PLAINS;
    grassGrowth[i] = terrain[i] === FOREST ? GRASS_GROWTH_FOREST : GRASS_GROWTH_PLAINS;
  }
  return { width, height, terrain, treeAt, trees, grassCap, grassGrowth };
}
