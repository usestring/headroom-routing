import { test } from "node:test";
import assert from "node:assert/strict";
import { runReplay } from "../evaluation/replay.mjs";
import { SCENARIOS } from "../evaluation/scenarios.mjs";

test("delayed snapshots admit 100 agents and block 95 without reservations", () => {
  const baseline = runReplay(SCENARIOS[0], "snapshot-earliest");
  assert.equal(baseline.admitted, 100);
  assert.equal(baseline.sessionBlocks, 95);
});
test("reserved idle burst selects four then waits without upstream blocks", () => {
  const result = runReplay(SCENARIOS[0], "reserved-quantile");
  assert.deepEqual(result.selected.slice(0, 4).map((entry) => entry.subscriptionId), ["a", "a", "a", "a"]);
  assert(result.selected.slice(4).every((entry) => entry.subscriptionId === null));
  assert.equal(result.completed, 4);
  assert.equal(result.sessionBlocks, 0);
});
test("a mean estimate can still overcommit when agents hit the known expensive tail", () => {
  const result = runReplay(SCENARIOS[1], "reserved-mean");
  assert.equal(result.selected[0].estimatedUnits, 12);
  assert.equal(result.admitted, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.sessionBlocks, 1);
});
test("tail reservation avoids that block without reducing completed agents", () => {
  const result = runReplay(SCENARIOS[1], "reserved-quantile");
  assert.deepEqual(result.selected.map((entry) => entry.subscriptionId), ["a", "a", null, null]);
  assert.equal(result.completed, 2);
  assert.equal(result.sessionBlocks, 0);
});
test("weekly priority consumes the expiring account instead of wasting its forty units", () => {
  const result = runReplay(SCENARIOS[2], "reserved-quantile");
  const baseline = runReplay(SCENARIOS[2], "snapshot-headroom");
  assert.deepEqual(result.selected.map((entry) => entry.subscriptionId), ["early", "early", "early", "early"]);
  assert.equal(result.expiredWeeklyUnits, 0);
  assert.equal(baseline.expiredWeeklyUnits, 40);
});
test("sustained demand across staggered resets completes without session blocks", () => {
  const result = runReplay(SCENARIOS[3], "reserved-quantile");
  assert.equal(result.completed, 60);
  assert.equal(result.sessionBlocks, 0);
});
test("replay does not give the selector future actual costs", () => {
  const expensive = runReplay(SCENARIOS[4], "reserved-quantile");
  const cheap = runReplay({ ...SCENARIOS[4], agents: SCENARIOS[4].agents.map((agent) => ({ ...agent, actualUnits: 10 })) }, "reserved-quantile");
  assert.deepEqual(expensive.selected, cheap.selected);
  assert.equal(expensive.sessionBlocks, 1);
  assert.equal(cheap.sessionBlocks, 0);
});
test("a safety buffer cannot guarantee against arbitrary untracked external spend", () => {
  const result = runReplay(SCENARIOS[5], "reserved-quantile");
  assert.equal(result.admitted, 4);
  assert.equal(result.sessionBlocks, 2);
});
test("tail reservations can waste more weekly quota when agents are cheaper than estimated", () => {
  const mean = runReplay(SCENARIOS[6], "reserved-mean");
  const tail = runReplay(SCENARIOS[6], "reserved-quantile");
  assert.equal(mean.completed, 3);
  assert.equal(tail.completed, 2);
  assert.equal(mean.expiredWeeklyUnits, 20);
  assert.equal(tail.expiredWeeklyUnits, 30);
  assert.equal(mean.sessionBlocks + tail.sessionBlocks, 0);
});
test("replays are deterministic and leave scenario inputs unchanged", () => {
  const before = structuredClone(SCENARIOS[3]);
  assert.deepEqual(runReplay(SCENARIOS[3], "reserved-quantile"), runReplay(SCENARIOS[3], "reserved-quantile"));
  assert.deepEqual(SCENARIOS[3], before);
});
test("initial observation at a reset sees replenished capacity before launching", () => {
  const scenario = { ...SCENARIOS[0], subscriptions: [{ ...SCENARIOS[0].subscriptions[0], sessionRemaining: 0, sessionResetAt: 0 }],
    agents: SCENARIOS[0].agents.slice(0, 20) };
  const result = runReplay(scenario, "reserved-quantile");
  assert.equal(result.admitted, 9);
  assert.equal(result.completed, 9);
  assert.equal(result.sessionBlocks, 0);
});
test("90 delayed-report grids have no blocks when actual cost is covered by reservations", () => {
  let checked = 0;
  for (const interval of [1, 30, 120]) for (const cost of [5, 10, 15]) {
    for (const count of [1, 4, 8, 12, 30]) for (const reset of [30, 300]) {
      const scenario = { subscriptions: [{ ...SCENARIOS[0].subscriptions[0], sessionRemaining: 100, sessionResetAt: reset }],
        agents: Array.from({ length: count }, (_, index) => ({ id: `agent-${index}`, at: index * 2, duration: 10, actualUnits: cost })),
        horizon: 120, reportInterval: interval, history: Array(5).fill(cost) };
      const result = runReplay(scenario, "reserved-quantile");
      assert.equal(result.sessionBlocks, 0, JSON.stringify({ interval, cost, count, reset }));
      assert.equal(result.weeklyBlocks, 0);
      checked++;
    }
  }
  assert.equal(checked, 90);
});
