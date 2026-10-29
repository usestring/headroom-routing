import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription, createRoutingState, allocateAgent, applyUsageSnapshot } from "../src/index.mjs";
import { enumerate } from "./support/oracle.mjs";

const sub = (fields = {}) => ({ id: "a", sessionCapacity: 10, sessionRemaining: 10, sessionResetAt: 300,
  weeklyCapacity: 20, weeklyRemaining: 20, weeklyResetAt: 10080, ...fields });
const choose = (subscription, request, options = {}) => selectSubscription({ subscriptions: [subscription],
  requests: [{ at: 0, units: 1, ...request }], ...options });

for (const planner of ["exact", "beam"]) {
  test(`${planner}: ordinary work stops at the protected boundary; sensitive work keeps the safety buffer`, () => {
    const subscription = sub({ sessionBuffer: 1, sessionReserve: 3, weeklyBuffer: 2, weeklyReserve: 4 });
    assert.equal(choose(subscription, { units: 6 }, { planner }).selectedId, "a");
    const held = choose(subscription, { units: 7 }, { planner });
    assert.equal(held.selectedId, null);
    assert.equal(held.retryAt, null);
    assert.equal(held.projectedHeadroom[0].sessionRemaining, 6);
    assert.equal(choose(subscription, { units: 9, useReservedCapacity: true }, { planner }).selectedId, "a");
    assert.equal(choose(subscription, { units: 10, useReservedCapacity: true }, { planner }).selectedId, null);
    const weekly = sub({ weeklyRemaining: 5, weeklyReserve: 4, weeklyBuffer: 1 });
    assert.equal(choose(weekly, {}, { planner }).selectedId, null);
    assert.equal(choose(weekly, { units: 4, useReservedCapacity: true }, { planner }).selectedId, "a");
    assert.equal(choose(weekly, { units: 5, useReservedCapacity: true }, { planner }).selectedId, null);
  });

  test(`${planner}: protected units remain real expiry waste`, () => {
    const subscription = sub({ weeklyCapacity: 10, weeklyRemaining: 10, weeklyReserve: 4, weeklyResetAt: 10 });
    const requests = [{ at: 0, units: 6 }, { at: 1, units: 1 }, { at: 2, units: 3, useReservedCapacity: true }];
    const result = choose(subscription, {}, { requests, planner });
    assert.deepEqual(result.plan, ["a", null, "a"]);
    assert.equal(result.score.expiredWeeklyUnits, 1);
  });

  test(`${planner}: resets restore the floor while delayed commitments still bind`, () => {
    const subscription = sub({ sessionReserve: 4, weeklyReserve: 4, sessionResetAt: 2,
      weeklyCapacity: 10, weeklyRemaining: 10, weeklyResetAt: 2 });
    const requests = [{ at: 0, units: 6, spendAt: 4 }, { at: 3, units: 1 },
      { at: 3, units: 4, useReservedCapacity: true }];
    const result = choose(subscription, {}, { requests, horizon: 5, planner });
    assert.deepEqual(result.plan, ["a", null, "a"]);
    assert.equal(result.score.expiredWeeklyUnits, 10);
  });
}

test("retry timing includes the protected floor in both renewed windows", () => {
  const result = choose(sub({ sessionRemaining: 2, sessionReserve: 2, sessionResetAt: 3,
    weeklyRemaining: 2, weeklyReserve: 3, weeklyResetAt: 5 }), { units: 2 });
  assert.equal(result.retryAt, 5);
  assert.equal(choose(sub({ sessionReserve: 10 }), {}).retryAt, null);
});

test("ledger reservations consume shared capacity across request classes and snapshots", () => {
  let state = createRoutingState({ subscriptions: [sub({ sessionReserve: 4, sessionBuffer: 1 })] });
  const allocate = (id, estimatedUnits, useReservedCapacity = false) => allocateAgent(state, {
    id, at: state.observedAt, estimatedUnits, useReservedCapacity, expectedRevision: state.revision });
  const ordinary = allocate("ordinary", 5);
  assert.equal(ordinary.status, "reserved");
  state = ordinary.state;
  assert.equal(allocate("waiting", 1).status, "waiting");
  const sensitive = allocate("sensitive", 4, true);
  assert.equal(sensitive.status, "reserved");
  state = sensitive.state;
  assert.equal(allocate("overflow", 1, true).status, "waiting");
  assert.equal(allocate("sensitive", 4, true).status, "already_reserved");
  state = applyUsageSnapshot(state, { subscriptions: state.subscriptions, observedAt: 1, expectedRevision: state.revision });
  assert.equal(allocate("after-snapshot", 1, true).status, "waiting");
  assert.equal(state.ledger.agents.reduce((sum, agent) => sum + agent.futureUnits, 0), 9);
});

for (const [name, subscription, request] of [
  ["negative reserve", sub({ sessionReserve: -1 }), {}],
  ["fractional reserve", sub({ weeklyReserve: 0.5 }), {}],
  ["nonfinite reserve", sub({ sessionReserve: Infinity }), {}],
  ["reserve plus buffer exceeds capacity", sub({ sessionReserve: 10, sessionBuffer: 1 }), {}],
  ["truthy access flag", sub(), { useReservedCapacity: "yes" }]
]) test(`rejects ${name}`, () => assert.throws(() => choose(subscription, request)));

test("mixed access classes match an independent minute oracle across 1152 small fleets", () => {
  for (const sessionReserve of [0, 1, 2]) for (const weeklyReserve of [0, 1, 2]) {
    for (const sessionRemaining of [0, 1, 2, 3]) for (const weeklyRemaining of [0, 1, 2, 3]) {
      for (const firstAccess of [false, true]) for (const secondAccess of [false, true]) for (const spendAt of [0, 3]) {
        const subscriptions = [sub({ sessionCapacity: 4, sessionRemaining, sessionResetAt: 2, sessionBuffer: 1,
          weeklyCapacity: 4, weeklyRemaining, weeklyResetAt: 3, weeklyBuffer: 1, sessionReserve, weeklyReserve }),
        sub({ id: "b", sessionCapacity: 4, sessionRemaining: 3, weeklyCapacity: 4, weeklyRemaining: 3, weeklyResetAt: 5 })];
        const requests = [{ at: 0, units: 1, spendAt, useReservedCapacity: firstAccess },
          { at: 2, units: 2, useReservedCapacity: secondAccess }];
        const expected = enumerate(subscriptions, requests, 5);
        for (const planner of ["exact", "beam"]) {
          const actual = selectSubscription({ subscriptions, requests, horizon: 5, planner, beamWidth: 8 });
          assert.deepEqual(actual.plan, expected.plan);
          Object.values(actual.score).forEach((value, index) => assert(Math.abs(value - expected.score[index]) < 1e-8));
        }
      }
    }
  }
});
