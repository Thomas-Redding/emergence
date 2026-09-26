// Pixel-art sprites, drawn programmatically onto small offscreen canvases once at startup.
// (1 tile = 16 sprite pixels.) Browser-only: uses document.createElement("canvas").

const mk = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  return [c, g];
};
const rect = (g, col, x, y, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

// Deterministic tiny hash for texture speckles (render-only, so any hash will do).
export const hash2 = (x, y, k = 0) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(k | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

// Darkened copy, for remembered-but-not-visible things.
function dimmed(src) {
  const [c, g] = mk(src.width, src.height);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = "rgba(0,0,0,0.5)";
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

const TUNICS = [["#3d6fe0", "#2a4ea8"], ["#d24a4a", "#9c3232"], ["#4aa84a", "#2f7a2f"], ["#e0982e", "#a86e1a"], ["#9a5bd0", "#6d3a9a"]];
export const TUNIC_COUNT = TUNICS.length;
const SKIN = "#f0c8a0", HAIR = "#5a3a1e", PANTS = "#5b4632", BOOT = "#3a2a1a";

// 16x16, feet at the bottom. dir: down | up | side (faces right). frame: 0 stand, 1..3 walk cycle.
function human(tunic, dir, frame) {
  const [c, g] = mk(16, 16);
  const [T, Td] = TUNICS[tunic];
  const liftL = frame === 1, liftR = frame === 3;
  const armL = frame === 1 ? 1 : frame === 3 ? -1 : 0; // arms swing against the legs
  if (dir === "side") {
    const back = frame === 1 ? -2 : frame === 3 ? 2 : 0; // legs scissor
    rect(g, PANTS, 7 + back, 12, 2, liftL ? 3 : 4);
    rect(g, BOOT, 7 + back, liftL ? 14 : 15, 2, 1);
    rect(g, PANTS, 7 - back, 12, 2, liftR ? 3 : 4);
    rect(g, BOOT, 7 - back, liftR ? 14 : 15, 2, 1);
    rect(g, T, 6, 7, 4, 5);
    rect(g, Td, 6, 10, 4, 1);
    rect(g, T, 7 - armL, 7, 2, 2); // arm
    rect(g, SKIN, 7 - armL, 9, 2, 2);
    rect(g, SKIN, 5, 1, 6, 6); // head
    rect(g, HAIR, 5, 1, 6, 2);
    rect(g, HAIR, 5, 3, 3, 3);
    rect(g, "#222", 9, 4, 1, 1); // eye
  } else {
    rect(g, PANTS, 5, 12, 2, liftL ? 3 : 4);
    rect(g, BOOT, 5, liftL ? 14 : 15, 2, 1);
    rect(g, PANTS, 9, 12, 2, liftR ? 3 : 4);
    rect(g, BOOT, 9, liftR ? 14 : 15, 2, 1);
    rect(g, T, 5, 7, 6, 5); // torso
    rect(g, Td, 5, 10, 6, 1); // belt
    rect(g, T, 3, 7 + armL, 2, 2); // left arm
    rect(g, SKIN, 3, 9 + armL, 2, 2);
    rect(g, T, 11, 7 - armL, 2, 2); // right arm
    rect(g, SKIN, 11, 9 - armL, 2, 2);
    rect(g, SKIN, 5, 1, 6, 6); // head
    if (dir === "down") {
      rect(g, HAIR, 5, 1, 6, 2);
      rect(g, HAIR, 5, 3, 1, 2);
      rect(g, HAIR, 10, 3, 1, 2);
      rect(g, "#222", 6, 4, 1, 1);
      rect(g, "#222", 9, 4, 1, 1);
    } else {
      rect(g, HAIR, 5, 1, 6, 5); // back of the head
    }
  }
  return c;
}

// 18x14, facing right, feet at the bottom.
function deer(frame) {
  const [c, g] = mk(18, 14);
  const BODY = "#a0693a", BELLY = "#e8d2b0", DARK = "#6e4522", LEG = "#5a3a1c", ANT = "#d8c8a0";
  // legs: diagonal pairs lift alternately
  const lifted = (i) => (frame === 1 && (i === 0 || i === 3)) || (frame === 3 && (i === 1 || i === 2));
  [4, 6, 10, 12].forEach((x, i) => {
    if (lifted(i)) rect(g, LEG, x + (i > 1 ? 1 : 0), 10, 1, 2);
    else rect(g, LEG, x, 10, 1, 4);
  });
  rect(g, BODY, 3, 5, 10, 5); // body
  rect(g, BELLY, 4, 9, 8, 1);
  rect(g, "#b98050", 4, 5, 8, 1); // back highlight
  rect(g, "#c9946a", 6, 7, 1, 1); // spots
  rect(g, "#c9946a", 9, 6, 1, 1);
  rect(g, "#f4f0e6", 1, 5, 2, 2); // tail
  rect(g, BODY, 12, 3, 2, 4); // neck
  rect(g, BODY, 13, 2, 4, 3); // head
  rect(g, DARK, 16, 3, 2, 2); // snout
  rect(g, "#111", 15, 3, 1, 1); // eye
  rect(g, BODY, 13, 1, 1, 1); // ear
  rect(g, ANT, 14, 0, 1, 2); // antlers
  rect(g, ANT, 16, 0, 1, 2);
  rect(g, ANT, 15, 0, 1, 1);
  return c;
}

const CANOPY = [["#2f6d2c", "#3f8a3a", "#235221"], ["#2b6a35", "#3a8746", "#1f4f28"], ["#37702a", "#4a9436", "#295a20"]];
// Tree parts are separate so the canopy can sway. 16x22, anchored at the tile's bottom.
function treeTrunk() {
  const [c, g] = mk(16, 22);
  rect(g, "#6b4a2a", 6, 14, 4, 8);
  rect(g, "#4e3620", 6, 14, 1, 8);
  rect(g, "#3a2a1a", 5, 21, 6, 1);
  return c;
}
function treeCanopy(v) {
  const [c, g] = mk(16, 22);
  const [base, hi, lo] = CANOPY[v];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.sqrt((x + 0.5 - 8) * (x + 0.5 - 8) + (y + 0.5 - 8.5) * (y + 0.5 - 8.5));
      if (d > 7.6) continue;
      let col = base;
      if (x + y < 10) col = hi;
      else if (d > 6.2 || x + y > 20) col = lo;
      if (hash2(x, y, v + 7) % 7 === 0) col = d > 5 ? lo : hi;
      rect(g, col, x, y);
    }
  }
  return c;
}

// 12x14 flame; frames flicker sideways row by row.
function fire(frame, lit) {
  const [c, g] = mk(12, 14);
  rect(g, "#5a3a1c", 1, 12, 10, 2); // logs
  rect(g, "#3f2812", 3, 11, 6, 1);
  rect(g, "#6b4a2a", 2, 10, 3, 1);
  rect(g, "#6b4a2a", 7, 10, 3, 1);
  if (!lit) {
    rect(g, "#8a8a8a", 5, 8 - (frame % 2), 1, 2); // a wisp of smoke
    return c;
  }
  const layers = [["#e0452a", 8, 9], ["#ff9a2a", 6, 7], ["#ffe066", 3, 4]]; // colour, bottom width, height
  for (const [col, w, hgt] of layers) {
    for (let r = 0; r < hgt; r++) {
      const width = Math.max(1, Math.round(w * (1 - r / hgt)));
      const jitter = ((r + frame) % 3) - 1;
      rect(g, col, 6 - Math.floor(width / 2) + (r > 2 ? jitter : 0), 10 - r, width, 1);
    }
  }
  return c;
}

function stick() {
  const [c, g] = mk(10, 10);
  for (let i = 0; i < 8; i++) rect(g, i % 3 === 0 ? "#7a5530" : "#5b3a1a", 1 + i, 8 - i, 1, 1);
  rect(g, "#7a5530", 8, 1);
  return c;
}
function spear() {
  const [c, g] = mk(14, 14);
  for (let i = 0; i < 11; i++) rect(g, "#6b4a2a", 1 + i, 12 - i, 1, 1);
  rect(g, "#d8d8d8", 11, 2, 2, 1); // tip
  rect(g, "#d8d8d8", 12, 1, 1, 2);
  rect(g, "#a8a8a8", 10, 3);
  return c;
}
function meat(cooked) {
  const [c, g] = mk(10, 8);
  const base = cooked ? "#8a4a22" : "#d95c5c", hi = cooked ? "#a8642e" : "#ec8080", lo = cooked ? "#5e3010" : "#a83c3c";
  rect(g, base, 2, 2, 6, 4);
  rect(g, base, 1, 3, 8, 2);
  rect(g, hi, 3, 2, 3, 1);
  rect(g, lo, 2, 5, 6, 1);
  if (cooked) { rect(g, lo, 3, 3, 1, 2); rect(g, lo, 5, 3, 1, 2); } // grill marks
  else rect(g, "#f4f0e6", 8, 3, 2, 2); // bone
  return c;
}
function tuft() {
  const [c, g] = mk(6, 5);
  rect(g, "#a8d070", 1, 1, 1, 3);
  rect(g, "#7fae4a", 2, 0, 1, 4);
  rect(g, "#a8d070", 4, 1, 1, 3);
  rect(g, "#6a9a3c", 3, 2, 1, 2);
  return c;
}
function leaves() {
  const [c, g] = mk(6, 4);
  rect(g, "#3d7530", 1, 1, 2, 1);
  rect(g, "#5a4a2a", 4, 2, 1, 1);
  rect(g, "#3d7530", 3, 3, 1, 1);
  return c;
}

export function buildAtlas() {
  const A = { humans: [], deer: [], fireLit: [], fireOut: [], canopy: [], canopyDim: [] };
  for (let t = 0; t < TUNICS.length; t++) {
    A.humans[t] = {};
    for (const dir of ["down", "up", "side"]) A.humans[t][dir] = [0, 1, 2, 3].map((f) => human(t, dir, f));
  }
  A.deer = [0, 1, 2, 3].map(deer);
  A.fireLit = [0, 1, 2].map((f) => fire(f, true));
  A.fireOut = [0, 1].map((f) => fire(f, false));
  A.trunk = treeTrunk();
  A.trunkDim = dimmed(A.trunk);
  for (let v = 0; v < CANOPY.length; v++) {
    A.canopy[v] = treeCanopy(v);
    A.canopyDim[v] = dimmed(A.canopy[v]);
  }
  A.stick = stick();
  A.spear = spear();
  A.rawMeat = meat(false);
  A.cookedMeat = meat(true);
  A.tuft = tuft();
  A.leaves = leaves();
  return A;
}
