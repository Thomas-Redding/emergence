// Seeded PRNG (mulberry32). All randomness in sim/ must come from here.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    // Uniform random unit vector without trig (rejection sampling), so it is exact across engines.
    unit() {
      for (;;) {
        const x = next() * 2 - 1, y = next() * 2 - 1, l = x * x + y * y;
        if (l > 0.01 && l <= 1) {
          const k = 1 / Math.sqrt(l);
          return [x * k, y * k];
        }
      }
    },
  };
}

// Derive independent stream seeds from one master seed.
export function deriveSeed(seed, label) {
  let h = 2166136261 ^ (seed >>> 0);
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}
