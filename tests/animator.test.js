import test from "node:test";
import assert from "node:assert/strict";
import { Animator, spriteDir, STRIDE } from "../render/animator.js";

test("sprite direction from a facing vector; left is a mirrored right", () => {
  assert.deepEqual(spriteDir(1, 0.2), { dir: "side", flip: false });
  assert.deepEqual(spriteDir(-1, 0.2), { dir: "side", flip: true });
  assert.deepEqual(spriteDir(0.1, 1), { dir: "down", flip: false });
  assert.deepEqual(spriteDir(0.1, -1), { dir: "up", flip: false });
});

test("walk cycle advances with distance travelled, not with time", () => {
  const a = new Animator();
  let st = a.track(1, 0, 0, null, 0);
  assert.equal(st.frame, 0);
  const seen = new Set();
  for (let i = 1; i <= 40; i++) { st = a.track(1, i * 0.1, 0, null, i * 16); seen.add(st.frame); }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3], "cycles through all four frames");
  assert.ok(Math.abs(st.phase - 4 * STRIDE) < 1e-9, "phase = distance * stride");
  assert.equal(st.dir, "side");
  assert.equal(st.flip, false);
});

test("facing is inferred from movement when unknown, and taken as given when known", () => {
  const a = new Animator();
  a.track(1, 5, 5, null, 0);
  let st = a.track(1, 4.8, 5, null, 16);
  assert.equal(st.flip, true, "moving left -> mirrored side sprite");
  st = a.track(1, 4.6, 5, [0, 1], 32); // true facing says down, even while moving left
  assert.equal(st.dir, "down");
});

test("stops walking shortly after movement stops; standing is frame 0", () => {
  const a = new Animator();
  a.track(1, 0, 0, null, 0);
  let st = a.track(1, 0.3, 0, null, 16);
  assert.equal(st.moving, true);
  st = a.track(1, 0.3, 0, null, 60);
  assert.equal(st.moving, true, "brief grace so tick gaps don't flicker");
  st = a.track(1, 0.3, 0, null, 400);
  assert.equal(st.moving, false);
  assert.equal(st.frame, 0);
});

test("a teleport is not a walk", () => {
  const a = new Animator();
  a.track(1, 0, 0, null, 0);
  const st = a.track(1, 50, 50, null, 16);
  assert.equal(st.phase, 0);
});

test("one-shot gestures play once; looping ones last while reported", () => {
  const a = new Animator();
  const st = a.track(1, 0, 0, null, 0);
  a.setAction(st, { ok: true, action: "stab" }, 0);
  assert.equal(a.activeAction(st, 100).type, "stab");
  assert.ok(a.activeAction(st, 100).p > 0 && a.activeAction(st, 100).p < 1);
  a.setAction(st, { ok: true, action: "stab" }, 200); // sim still reports it (paused): no replay
  assert.equal(a.activeAction(st, 300), null, "the stab gesture is over");

  a.setAction(st, { ok: true, action: "sharpen" }, 1000);
  for (let t = 1000; t < 2000; t += 16) a.setAction(st, { ok: true, action: "sharpen" }, t);
  assert.equal(a.activeAction(st, 1990).type, "sharpen", "keeps going while the action is reported");
  assert.equal(a.activeAction(st, 2400), null, "and stops soon after it isn't");
});

test("failed or non-animated actions don't animate", () => {
  const a = new Animator();
  const st = a.track(1, 0, 0, null, 0);
  a.setAction(st, { ok: false, reason: "need_spear", action: "stab" }, 0);
  assert.equal(a.activeAction(st, 10), null);
  a.setAction(st, { ok: true, action: "move" }, 0);
  assert.equal(a.activeAction(st, 10), null);
});

test("prune forgets creatures not seen for a while", () => {
  const a = new Animator();
  a.track(1, 0, 0, null, 0);
  a.track(2, 0, 0, null, 9000);
  a.prune(10000);
  assert.deepEqual([...a.states.keys()], [2]);
});
