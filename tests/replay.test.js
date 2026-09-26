import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import { replay } from "../sim/replay.js";
import { makeInput, inputBrain, scriptedBrain } from "../sim/brains.js";
import { makeRng } from "../sim/rng.js";
import { basicNpc } from "../npcs/basic.js";

// The one human-driven actor gets whatever brain the caller passes in: live input or a replay.
const makeSim = (humanBrain) => {
  const s = new Sim({ seed: 5 });
  s.addActor(basicNpc, 40, 48);
  s.addActor(humanBrain, 50, 48, { record: true });
  return s;
};

// Scripted "human": random-looking but seeded inputs, including some invalid ones.
function playLive(ticks, scriptSeed) {
  const input = makeInput();
  const sim = makeSim(inputBrain(input)), r = makeRng(scriptSeed);
  const player = sim.humanIds[0];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let t = 0; t < ticks; t++) {
    if (r.chance(0.6)) {
      const roll = r.int(10);
      if (roll < 7) {
        const [dx, dy] = dirs[r.int(4)];
        input.push({ type: "move", dx, dy, sneak: r.chance(0.5) });
      } else if (roll < 9) {
        const me = sim.byId(player) ?? { x: 0, y: 0 }; // the player may have starved; inputs to the dead are harmless
        const near = sim.entities.find((e) => e.kind === "stick" && Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) <= 1);
        input.push(near ? { type: "pickup", item: near.id } : { type: "wait" });
      } else input.push({ type: "stab", target: 12345 });
    }
    sim.step();
  }
  return sim;
}

test("replaying the input log reproduces the live game exactly", () => {
  const live = playLive(3000, 99);
  assert.ok(live.inputLog.length > 500);
  const log = JSON.parse(JSON.stringify(live.inputLog)); // survives serialization (save to disk)
  const rep = replay(makeSim, log, 3000);
  assert.equal(hashState(rep), hashState(live));
  assert.deepEqual(rep.inputLog, live.inputLog);
});

test("replay matches at every checkpoint, not just the end", () => {
  const live = playLive(2000, 7);
  for (const n of [1, 10, 250, 999, 2000]) {
    const a = replay(makeSim, live.inputLog.filter((e) => e.tick < n), n);
    const b = playLive(n, 7);
    assert.equal(hashState(a), hashState(b), `mismatch at tick ${n}`);
  }
});

test("different input logs give different games; no input is a valid game too", () => {
  const a = playLive(1500, 1), b = playLive(1500, 2);
  assert.notEqual(hashState(a), hashState(b));
  const idle = replay(makeSim, [], 1500);
  assert.notEqual(hashState(idle), hashState(a));
  assert.equal(hashState(idle), hashState(replay(makeSim, [], 1500)));
});

test("an NPC and a person are interchangeable: an AI's recorded actions replay as a scripted brain", () => {
  const build = (brain) => {
    const s = new Sim({ seed: 3 });
    s.addActor(brain, 48, 48, { record: true }); // the AI is recorded exactly like a human would be
    s.addActor(basicNpc, 56, 48);
    return s;
  };
  const ai = build(basicNpc);
  ai.run(3000);
  assert.ok(ai.inputLog.length > 500 && ai.stats.kills > 0);
  const copy = build(scriptedBrain(ai.inputLog));
  copy.run(3000);
  assert.equal(hashState(copy), hashState(ai));
});

test("control can be handed between brains mid-game", () => {
  const input = makeInput();
  const s = new Sim({ seed: 2 });
  const a = s.addActor(basicNpc, 48, 48, { record: true });
  s.run(200);
  const walked = { x: a.x, y: a.y };
  s.setBrain(a.id, inputBrain(input)); // a person takes over the NPC
  s.run(50);
  assert.deepEqual({ x: a.x, y: a.y }, walked, "a live brain with no input just waits");
  input.push({ type: "move", dx: 1, dy: 0 });
  s.step();
  assert.equal(a.x, walked.x + 0.5);
  s.setBrain(a.id, basicNpc); // and gives it back
  s.run(100);
  assert.equal(s.brains.get(a.id).dead, false);
});

test("the sim never blocks on a human: no input is just a wait", () => {
  const s = makeSim(inputBrain(makeInput()));
  s.run(100);
  assert.equal(s.tick, 100);
  assert.equal(s.inputLog.length, 0);
});

test("sim.observe gives a player the same view an NPC brain would get", () => {
  let seen;
  const spy = function* (obs) { for (;;) { seen = obs; obs = yield { type: "wait" }; } };
  const s = new Sim({ seed: 4 });
  const a = s.addActor(spy, 48, 48);
  s.run(5);
  const mine = s.observe(a.id); // observation for the *next* tick
  assert.equal(mine.tick, 5);
  assert.equal(seen.tick, 4);
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(seen).sort());
  assert.equal(s.observe(99999), null);
});
