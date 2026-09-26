import { scriptedBrain } from "./brains.js";

// Replay = same setup + same seed + the recorded human actions fed back on their ticks.
// makeSim(humanBrain) must build the initial game identically each call, attaching the given
// brain to the human-driven actor(s) with { record: true }. Live play passes an inputBrain;
// replay passes a scriptedBrain(log).
export function replay(makeSim, log, ticks) {
  const sim = makeSim(scriptedBrain(log));
  sim.run(ticks);
  return sim;
}
