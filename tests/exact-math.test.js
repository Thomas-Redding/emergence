import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The sim may only use IEEE-exact arithmetic (+ - * / sqrt, floor, abs, min, max, imul...).
// These functions/operators are allowed to differ between JS engines in the last bits, which
// would silently break cross-machine determinism.
const FORBIDDEN = [/Math\.(hypot|sin|cos|tan|asin|acos|atan2?|exp|expm1|log\w*|pow|cbrt|sinh|cosh|tanh|random)\b/, /\*\*/];
const files = [
  ...readdirSync("sim").map((f) => "sim/" + f),
  ...readdirSync("npcs").map((f) => "npcs/" + f),
].filter((f) => f.endsWith(".js"));

test("sim/ and npcs/ use only engine-exact math", () => {
  for (const f of files) {
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const re of FORBIDDEN) assert.ok(!re.test(code.replace(/\/\/.*$/gm, "")), `${f} uses ${re}`);
  }
});
