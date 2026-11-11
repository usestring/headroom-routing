import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription, createRoutingState, allocateAgent } from "../src/index.mjs";

const sub = (id, fields = {}) => ({ id, sessionCapacity: 10, sessionRemaining: 10, sessionResetAt: 300,
  weeklyCapacity: 100, weeklyRemaining: 100, weeklyResetAt: 10080, ...fields });
const select = (subscriptions, requests = [{ at: 0, units: 2 }], extra = {}) =>
  selectSubscription({ subscriptions, requests, ...extra });

for (const planner of ["exact", "beam"]) {
  test(`${planner}: fixed expiration makes otherwise identical quota more urgent`, () => {
    const result = select([sub("later"), sub("z-expiring", { expiresAt: 10 })], undefined, { planner });
    assert.equal(result.selectedId, "z-expiring");
    assert.equal(result.score.expiredWeeklyUnits, 198);
  });

  test(`${planner}: expiration prevents admission and refills at the deadline`, () => {
    const result = select([sub("a", { expiresAt: 10, sessionResetAt: 10, weeklyResetAt: 10 })],
      [{ at: 0, units: 2 }, { at: 10, units: 2 }], { planner, horizon: 20 });
    assert.deepEqual(result.plan, ["a", null]);
    assert.equal(result.score.expiredWeeklyUnits, 98);
  });

  test(`${planner}: an earlier recurring reset still replenishes before expiration`, () => {
    const result = select([sub("a", { expiresAt: 20, sessionResetAt: 5, weeklyResetAt: 5 })],
      [{ at: 0, units: 10 }, { at: 5, units: 10 }, { at: 20, units: 2 }], { planner, horizon: 30 });
    assert.deepEqual(result.plan, ["a", "a", null]);
    assert.equal(result.score.expiredWeeklyUnits, 180);
  });
}

test("expected spend must occur before fixed expiration", () => {
  const subscriptions = [sub("a", { expiresAt: 10 })];
  assert.equal(select(subscriptions, [{ at: 0, units: 2, spendAt: 9 }]).selectedId, "a");
  for (const spendAt of [10, 11]) {
    const result = select(subscriptions, [{ at: 0, units: 2, spendAt }]);
    assert.equal(result.selectedId, null);
    assert.equal(result.retryAt, null);
  }
});

test("expired subscriptions have no projected headroom or retry", () => {
  for (const expiresAt of [0, 9, 10]) {
    const result = select([sub("a", { expiresAt })], [{ at: 10, units: 2 }], { now: 10 });
    assert.equal(result.selectedId, null);
    assert.equal(result.retryAt, null);
    assert.deepEqual(result.projectedHeadroom, [{ id: "a", sessionRemaining: 0, weeklyRemaining: 0 }]);
  }
});

test("retry can use a reset strictly before expiration", () => {
  for (const expiresAt of [9, 10, 11]) {
    const result = select([sub("a", { expiresAt, sessionRemaining: 0, sessionResetAt: 10 })]);
    assert.equal(result.retryAt, expiresAt > 10 ? 10 : null);
  }
});

test("a short horizon may end at expiration instead of the later weekly reset", () => {
  assert.equal(select([sub("a", { expiresAt: 10 })], undefined, { horizon: 10 }).selectedId, "a");
  assert.throws(() => select([sub("a", { expiresAt: 10 })], undefined, { horizon: 9 }));
});

test("allocator retains expiration when applying reservations", () => {
  const state = createRoutingState({ subscriptions: [sub("a", { expiresAt: 10 })] });
  assert.equal(allocateAgent(state, { id: "late", at: 0, spendAt: 10, estimatedUnits: 2,
    expectedRevision: 0 }).status, "waiting");
});

test("expiration must be an integer timestamp", () => {
  for (const expiresAt of [-1, 1.5, NaN, Infinity, "10"]) {
    assert.throws(() => select([sub("a", { expiresAt })]));
  }
});
