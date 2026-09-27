// A brain that does nothing. It starves on schedule, which makes it a useful floor when benchmarking:
// anything worth running should beat it.
export function* idle(obs) {
  for (;;) obs = yield { type: "wait" };
}
