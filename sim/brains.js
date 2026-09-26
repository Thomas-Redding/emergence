// Brains for actors that are not AI: a live input source, and a replay of a recorded log.
// Both are ordinary brains (function*(obs, rng)), so the sim treats them exactly like an NPC.

// A one-slot mailbox between a UI (or network socket) and a brain. push() from anywhere;
// the brain takes whatever arrived since the last tick (last push wins), or nothing.
export function makeInput() {
  let pending = null;
  return {
    push(action) { pending = action; },
    take() { const a = pending; pending = null; return a; },
  };
}

// Acts on whatever the input mailbox holds each tick; otherwise waits. Never blocks the sim.
// onObs(obs), if given, sees every observation the character receives (e.g. to build a map memory).
export function inputBrain(input, onObs) {
  return function* (obs) {
    for (;;) {
      onObs?.(obs);
      obs = yield input.take() ?? { type: "wait" };
    }
  };
}

// Replays a recorded log ([{tick, actor, action}], as in sim.inputLog): emits each of this
// actor's recorded actions on its tick and waits otherwise. onObs works as for inputBrain, so a
// replayed session ends up with the same memories as the live one.
export function scriptedBrain(log, onObs) {
  return function* (obs) {
    const mine = log.filter((e) => e.actor === obs.self.id);
    let i = 0;
    for (;;) {
      onObs?.(obs);
      while (i < mine.length && mine[i].tick < obs.tick) i++;
      const act = i < mine.length && mine[i].tick === obs.tick ? mine[i++].action : { type: "wait" };
      obs = yield act;
    }
  };
}
