import { Sim } from "./sim/sim.js";
import { hashState } from "./sim/hash.js";
import { makeInput, inputBrain, scriptedBrain } from "./sim/brains.js";
import { TileMemory } from "./sim/memory.js";
import { basicNpc } from "./npcs/basic.js";
import { draw, zoomAt, screenToWorld, interpPos, panCamera } from "./render/render.js";
import { buildHud } from "./ui/inventory.js";
import { actionPlans, ACTION_KEYS, FAIL_TEXT } from "./ui/controls.js";
import { hudHtml, renderHud } from "./ui/hud.js";

const TICKS_PER_SEC = 20;
const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? 1);
// Observer mode: no human player at all, a god's-eye view of the NPCs. Chosen at start because
// the initial game (and so replay) must be built identically every time.
const observer = params.has("observer");

// The initial game must be built identically every time: replay depends on it. The person is
// just another actor: whatever brain is passed in drives it (live input, or a replay's script).
function makeSim(humanBrain) {
  const s = new Sim({ seed });
  for (let i = 0; i < 3; i++) s.addActor(basicNpc, 40 + i * 8, 48);
  if (!observer) s.addActor(humanBrain, 48, 52, { record: true });
  return s;
}

const input = makeInput(); // where the keyboard hands actions to the player's brain
// The player's map memory: fed by their brain from every observation (live or replayed), never
// from the world, so the map only shows what the character has actually seen.
let memory = new TileMemory();
const remember = (obs) => memory.update(obs);
let sim = makeSim(inputBrain(input, remember));
let playerId = sim.humanIds[0] ?? null;
let selectedId = null; // observer/reveal: the creature the camera follows and the info line describes
let replayLog = null; // non-null while replaying
let replayTarget = null; // replayTarget = { tick, hash } captured from the live game

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const cam = { x: sim.world.width / 2, y: sim.world.height / 2, zoom: 24 };
let follow = true;
let reveal = observer; // see everything (always, in observer mode; a debug toggle otherwise)
const modeBtn = document.getElementById("mode");
modeBtn.textContent = observer ? "Play" : "Observe";
modeBtn.onclick = () => { // the game restarts: the mode is part of the game's initial setup
  const p = new URLSearchParams(location.search);
  if (observer) p.delete("observer"); else p.set("observer", "");
  location.search = p.toString().replace("observer=", "observer");
};
const followBtn = document.getElementById("follow");
const setFollow = (v) => { follow = v; followBtn.textContent = `Follow: ${v ? "on" : "off"}`; };
followBtn.onclick = () => setFollow(!follow);
setFollow(true);

// Canvas fills the window; render-only state, never touches the sim.
function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
addEventListener("resize", resize);
resize();

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(cam, canvas.width, canvas.height, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
let drag = null;
let downAt = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; downAt = { ...drag }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  cam.x -= (e.clientX - drag.x) / cam.zoom;
  cam.y -= (e.clientY - drag.y) / cam.zoom;
  drag = { x: e.clientX, y: e.clientY };
  setFollow(false);
});
canvas.addEventListener("pointerup", (e) => {
  drag = null;
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return; // that was a pan
  if (!reveal) return; // selecting hidden creatures would leak what the player can't see
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(cam, canvas.width, canvas.height, e.clientX - r.left, e.clientY - r.top);
  let best = null, bestD = 1;
  for (const en of sim.entities) {
    if (en.holder != null || !["human", "deer"].includes(en.kind)) continue;
    const d = Math.sqrt((en.x - wx) * (en.x - wx) + (en.y - wy) * (en.y - wy));
    if (d < bestD) { best = en; bestD = d; }
  }
  selectedId = best ? best.id : null;
  if (best) setFollow(true);
});
const info = document.getElementById("info");
const status = document.getElementById("status");

let speed = 1;
document.getElementById("speed").onclick = (ev) => {
  speed = speed === 1 ? 10 : speed === 10 ? 100 : 1;
  ev.target.textContent = `Speed x${speed}`;
};

document.getElementById("replay").onclick = () => {
  replayTarget = { tick: sim.tick, hash: hashState(sim) };
  replayLog = sim.inputLog.slice();
  memory = new TileMemory(); // the replay rebuilds it from the same observations
  sim = makeSim(scriptedBrain(replayLog, remember)); // the recorded actor is now driven by the log
  status.textContent = `replaying ${replayLog.length} inputs to tick ${replayTarget.tick}...`;
};

// Keyboard: arrows/WASD move (Shift = sneak), E pick up, Q sharpen held stick, X stab nearest deer.
const keys = new Set();
const taps = new Set(); // keys pressed since the last tick, so a tap shorter than a tick still registers
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (!e.repeat) taps.add(k); // OS auto-repeat of a held key is not a fresh press
  if (k === "+" || k === "=" || k === "-") zoomAt(cam, canvas.width, canvas.height, canvas.width / 2, canvas.height / 2, k === "-" ? 0.8 : 1.25);
  if (k === "f") setFollow(!follow);
  if (k === "v") reveal = !reveal;
  keys.add(k); if (e.key.startsWith("Arrow")) e.preventDefault(); });
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => { keys.clear(); taps.clear(); }); // a key released while unfocused never sends keyup

// Feedback for the player: why did that key do nothing? Shown in the HUD for a couple of seconds.
let hint = null; // { msg, tick }
const say = (msg) => { hint = { msg, tick: sim.tick }; };

function playerAction() {
  // Decide from what the character can perceive (its observation), like any brain would.
  const obs = playerId == null ? null : sim.observe(playerId);
  if (!obs) return null;
  const me = obs.self;
  const k = (...names) => names.some((n) => keys.has(n) || taps.has(n));
  const sneak = keys.has("shift");
  // Movement is continuous: held keys combine into any of 8 directions (the sim normalizes speed).
  const dx = (k("arrowright", "d") ? 1 : 0) - (k("arrowleft", "a") ? 1 : 0);
  const dy = (k("arrowdown", "s") ? 1 : 0) - (k("arrowup", "w") ? 1 : 0);
  if (dx || dy) return { type: "move", dx, dy, sneak };
  if (k("i")) return { type: "face", dx: 0, dy: -1 };
  if (k("k")) return { type: "face", dx: 0, dy: 1 };
  if (k("j")) return { type: "face", dx: -1, dy: 0 };
  if (k("l")) return { type: "face", dx: 1, dy: 0 };

  // Only explain a do-nothing key on a fresh press; a held key finishing its job is not an error.
  const tip = (key, msg) => { if (taps.has(key)) say(msg); };
  // Everything else is a plan computed from the observation (ui/controls.js), the same one the HUD
  // shows: the first held key whose action is possible is sent; a fresh press that can't be done
  // says why. (Only explain a do-nothing key on a fresh press; a held key finishing its job is not an error.)
  const plans = actionPlans(obs);
  for (const key of ACTION_KEYS) {
    if (!k(key)) continue;
    if (plans[key].action) return plans[key].action;
    if (taps.has(key)) say(plans[key].why);
  }
  return null;
}

// HUD: built from an observation, so it only shows what that character knows.
const hud = document.getElementById("hud");
function updateHud() {
  const sel = sim.byId(selectedId);
  const targetId = sel && sel.kind === "human" ? sel.id : playerId;
  if (sel && sel.kind !== "human") return renderHud(hud, ""); // a deer has no inventory
  const obs = targetId == null ? null : sim.observe(targetId);
  if (!obs) return renderHud(hud, playerId != null && targetId === playerId ? '<div class="card dead">You starved.</div>' : "");
  const isPlayer = targetId === playerId;
  const model = buildHud(obs, { isPlayer });
  const showHint = isPlayer && hint && sim.tick - hint.tick < 60 ? hint.msg : null;
  renderHud(hud, hudHtml(model, { title: isPlayer ? "You" : "human#" + targetId, hint: showHint }));
}
// Turn a failed player action into a hint (called after each live tick).
function noteResult() {
  const obs = playerId != null ? sim.observe(playerId) : null;
  if (obs && !obs.lastResult.ok && obs.lastResult.reason !== "blocked") say(FAIL_TEXT[obs.lastResult.reason] ?? obs.lastResult.reason);
}

// The keyboard only ever drops an action in the player's mailbox at a tick boundary; the
// player's brain hands it to the sim like any brain does. Rendering never touches the sim.
function feedInputs() {
  const a = playerAction();
  taps.clear();
  if (a) input.push(a);
}

function checkReplayDone() {
  if (!replayLog || sim.tick < replayTarget.tick) return;
  const match = hashState(sim) === replayTarget.hash;
  status.textContent = match ? `replay MATCHED live game at tick ${sim.tick}` : `replay MISMATCH at tick ${sim.tick}`;
  replayLog = null; // continue live from here, same as the original run would have
  replayTarget = null;
  if (playerId != null) sim.setBrain(playerId, inputBrain(input, remember)); // hand the actor back to the keyboard
}

function describe(e) {
  if (!e) return "";
  const inv = sim.entities.filter((i) => i.holder === e.id).map((i) => i.kind).join(", ");
  return ` · ${e.kind}#${e.id} at ${e.x.toFixed(1)},${e.y.toFixed(1)}` + (e.food != null ? ` food ${e.food}` : "") + (inv ? ` holding ${inv}` : "") + (e.fleeTicks ? " fleeing" : "");
}

window.__game = { get sim() { return sim; }, get memory() { return memory; }, cam }; // debugging / automated UI checks

// Render interpolation: the sim ticks at a fixed 20/s, but frames are drawn at display rate.
// Before the last tick of each frame we remember where every mover was; then we draw them
// part-way from there to where they are now (alpha = how far into the next tick we are).
const prevPos = new Map();
function snapshotMovers() {
  prevPos.clear();
  for (const e of sim.entities) if (e.kind === "human" || e.kind === "deer") prevPos.set(e.id, [e.x, e.y]);
}

let last = performance.now(), acc = 0;
function frame(now) {
  // While replaying, run flat out (still fixed ticks) to catch up quickly.
  const budget = replayLog ? 20000 : Math.min(now - last, 250) * speed;
  const dt = Math.min(now - last, 100) / 1000; // seconds since the last frame, for camera motion
  acc += budget;
  last = now;
  const stepMs = replayLog ? 0 : 1000 / TICKS_PER_SEC;
  let n = 0;
  while ((replayLog ? n < 2000 && sim.tick < replayTarget.tick : acc >= stepMs)) {
    if (replayLog || acc - stepMs < stepMs) snapshotMovers(); // only the frame's last tick matters
    if (!replayLog) feedInputs();
    sim.step();
    if (!replayLog) noteResult();
    acc -= stepMs;
    n++;
  }
  if (replayLog) acc = 0;
  checkReplayDone();
  // With no player character to steer (observer mode, or after it dies) WASD/arrows fly the camera.
  if (playerId == null || !sim.byId(playerId)) {
    const held = (...names) => names.some((n) => keys.has(n));
    const px = (held("arrowright", "d") ? 1 : 0) - (held("arrowleft", "a") ? 1 : 0);
    const py = (held("arrowdown", "s") ? 1 : 0) - (held("arrowup", "w") ? 1 : 0);
    if (panCamera(cam, px, py, dt, keys.has("shift"), sim.world)) setFollow(false); // panning takes over from following
  }
  const focus = sim.byId(selectedId ?? playerId);
  if (selectedId != null && !focus) selectedId = null; // it died or was eaten
  const interp = replayLog ? null : { prev: prevPos, alpha: Math.min(1, acc / (1000 / TICKS_PER_SEC)) };
  if (follow && focus) [cam.x, cam.y] = interpPos(focus, interp); // track the drawn position, so the camera is smooth too
  // The player's screen is drawn from their observation (fog + only what they can see);
  // reveal / observer mode is the god's-eye view straight from the sim.
  const playerView = playerId != null && !reveal;
  draw(ctx, sim, cam, canvas.width, canvas.height, {
    viewObs: playerView ? sim.observe(playerId) : null, // null once the character is dead
    memory: playerView ? memory : null,
    reveal, selectedId, interp, time: now, playerId,
  });
  updateHud();
  info.textContent = `seed ${seed} · tick ${sim.tick}${observer ? " · observer" : ` · inputs ${sim.inputLog.length}`}` + describe(sim.byId(selectedId));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
