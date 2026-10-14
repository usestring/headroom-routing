import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateAgentUnits } from "../src/index.mjs";

test("no history uses the stated agent-cost assumption", () => {
  assert.deepEqual(estimateAgentUnits([], { defaultUnits: 12 }), { units: 12, sampleCount: 0, source: "fallback", mode: "quantile" });
});
test("cold start retains the default floor", () => assert.equal(estimateAgentUnits([2, 3], { defaultUnits: 10 }).units, 10));
test("cold start notices an observed expensive agent immediately", () => assert.equal(estimateAgentUnits([20]).units, 20));
test("nearest-rank quantile reserves for the expensive tail", () => assert.equal(estimateAgentUnits([10, 10, 10, 10, 20]).units, 20));
test("mean cost remains an explicit alternative", () => assert.equal(estimateAgentUnits([10, 10, 10, 10, 20], { mode: "mean" }).units, 12));
test("mean rounding is exact for repeated integer costs", () => assert.equal(estimateAgentUnits([10, 10, 10, 10, 10, 10], { mode: "mean" }).units, 10));
test("fractional mean rounds up to an integer reservation", () => assert.equal(estimateAgentUnits([1, 1, 1, 1, 2], { mode: "mean" }).units, 2));
test("estimator can adapt downward after sufficient low-cost samples", () => assert.equal(estimateAgentUnits([2, 2, 2, 2, 2], { defaultUnits: 10 }).units, 2));
test("only the configured recent history is used", () => {
  assert.equal(estimateAgentUnits([100, 100, 5, 5, 5, 5, 5], { maxSamples: 5 }).units, 5);
});
test("quantile zero and one select the observed minimum and maximum", () => {
  assert.equal(estimateAgentUnits([1, 2, 3, 4, 5], { quantile: 0 }).units, 1);
  assert.equal(estimateAgentUnits([1, 2, 3, 4, 5], { quantile: 1 }).units, 5);
});
test("cost estimation does not mutate chronological history", () => {
  const history = [10, 2, 9, 4, 5];
  const before = [...history];
  estimateAgentUnits(history);
  assert.deepEqual(history, before);
});
for (const [name, history, options] of [
  ["negative costs", [-1], {}], ["zero-cost completed agents", [0], {}], ["fractional costs", [1.5], {}],
  ["invalid quantile", [10], { quantile: 1.1 }], ["unknown estimator", [], { mode: "random" }],
  ["invalid default", [], { defaultUnits: 0 }], ["too short history cap", [], { maxSamples: 1, minimumSamples: 5 }]
]) test(`reject ${name}`, () => assert.throws(() => estimateAgentUnits(history, options)));
