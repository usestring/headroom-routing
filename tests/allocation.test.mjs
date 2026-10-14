import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutingState, allocateAgent, applyUsageSnapshot, recordSpend, completeAgent } from "../src/index.mjs";

const subscription = (id = "a", overrides = {}) => ({ id, sessionCapacity: 100, sessionRemaining: 50, sessionResetAt: 300,
  sessionBuffer: 10, weeklyCapacity: 1000, weeklyRemaining: 500, weeklyResetAt: 10080, ...overrides });
const initial = () => createRoutingState({ subscriptions: [subscription()] });
const allocate = (state, overrides = {}) => allocateAgent(state, { id: "agent", at: 0, estimatedUnits: 10,
  expectedRevision: state.revision, ...overrides });
const spent = () => {
  const state = allocate(initial()).state;
  return { ...state, ledger: recordSpend(state.ledger, { id: "charge", agentId: "agent", spentUnits: 5,
    sessionResetAt: 300, weeklyResetAt: 10080 }), revision: state.revision + 1 };
};

test("allocation returns selection and its reservation in one state transition", () => {
  const state = initial();
  const result = allocate(state);
  assert.equal(result.status, "reserved");
  assert.equal(result.selectedId, "a");
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.ledger.agents[0].futureUnits, 10);
  assert.equal(state.ledger.agents.length, 0);
});

test("100 idle launch attempts against the same provider reading admit four", () => {
  let state = initial();
  const selected = [];
  for (let index = 0; index < 100; index++) {
    const result = allocate(state, { id: `agent-${index}` });
    selected.push(result.selectedId);
    state = result.state;
  }
  assert.deepEqual(selected.slice(0, 4), ["a", "a", "a", "a"]);
  assert(selected.slice(4).every((id) => id === null));
  assert.equal(state.revision, 4);
});

test("a stale allocator revision cannot reserve more work", () => {
  const result = allocate(initial());
  assert.throws(() => allocate(result.state, { id: "second", expectedRevision: 0 }), /reload/);
});
test("launch retries return the existing reservation without reserving twice", () => {
  const result = allocate(initial());
  const retry = allocate(result.state, { expectedRevision: 0 });
  assert.equal(retry.status, "already_reserved");
  assert.equal(retry.state, result.state);
  assert.equal(retry.decision, null);
});
test("an accepted launch remains idempotent after a newer provider report", () => {
  const first = allocate(initial()).state;
  const refreshed = applyUsageSnapshot(first, { subscriptions: [subscription()], observedAt: 10, expectedRevision: first.revision });
  assert.equal(allocate(refreshed, { at: 0, expectedRevision: 0 }).status, "already_reserved");
});
test("new allocations cannot move the decision clock backwards", () => {
  const state = allocate(initial(), { at: 10 }).state;
  assert.throws(() => allocate(state, { id: "new", at: 5 }), /backwards/);
});
test("a newer but delayed report preserves the latest allocation time", () => {
  const state = allocate(initial(), { at: 10 }).state;
  const refreshed = applyUsageSnapshot(state, { subscriptions: [subscription()], observedAt: 5, expectedRevision: state.revision });
  assert.equal(refreshed.lastAllocatedAt, 10);
  assert.throws(() => allocate(refreshed, { id: "new", at: 5 }), /backwards/);
});
test("retry cannot change estimated cost", () => assert.throws(() => allocate(allocate(initial()).state, { estimatedUnits: 20 }), /conflicting/));
test("retry cannot exclude the assigned account", () => assert.throws(() => allocate(allocate(initial()).state, { allowedIds: [] }), /excludes/));
test("completed launch id cannot launch a second process", () => {
  const first = allocate(initial()).state;
  const state = { ...first, ledger: completeAgent(first.ledger, "agent"), revision: first.revision + 1 };
  assert.equal(allocate(state).status, "already_reserved");
});
test("a waiting launch leaves state unchanged and can retry after a report", () => {
  const state = createRoutingState({ subscriptions: [subscription("a", { sessionRemaining: 10 })] });
  const waiting = allocate(state);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.state, state);
  const refreshed = applyUsageSnapshot(state, { subscriptions: [subscription()], observedAt: 1, expectedRevision: 0 });
  assert.equal(allocate(refreshed, { at: 1 }).status, "reserved");
});
test("safe allocation still honors model compatibility", () => {
  const state = createRoutingState({ subscriptions: [subscription("a"), subscription("b")] });
  assert.equal(allocate(state, { allowedIds: ["b"] }).selectedId, "b");
});
test("safe allocation still preserves capacity for forecast demand", () => {
  const state = createRoutingState({ subscriptions: [subscription("a", { sessionBuffer: 0, sessionRemaining: 20, weeklyResetAt: 60 }), subscription("b")] });
  const result = allocate(state, { forecast: [{ at: 1, units: 20, allowedIds: ["a"] }] });
  assert.equal(result.selectedId, "b");
});
test("provider remaining and acknowledged debt update together", () => {
  const state = spent();
  const updated = applyUsageSnapshot(state, { subscriptions: [subscription("a", { sessionRemaining: 45, weeklyRemaining: 495 })],
    observedAt: 1, expectedRevision: state.revision, includedCharges: { session: ["charge"], weekly: ["charge"] } });
  const result = allocate(updated, { id: "second", at: 1, estimatedUnits: 30 });
  assert.equal(result.status, "reserved");
  assert.equal(result.decision.projectedHeadroom[0].sessionRemaining, 30);
});
test("session and weekly reports may acknowledge independently", () => {
  const state = spent();
  const updated = applyUsageSnapshot(state, { subscriptions: [subscription("a", { sessionRemaining: 45 })],
    observedAt: 1, expectedRevision: state.revision, includedCharges: { session: ["charge"] } });
  assert.equal(updated.ledger.charges[0].sessionIncluded, true);
  assert.equal(updated.ledger.charges[0].weeklyIncluded, false);
});
test("old snapshot cannot restore headroom after a newer report", () => {
  const state = applyUsageSnapshot(initial(), { subscriptions: [subscription("a", { sessionRemaining: 30 })], observedAt: 10, expectedRevision: 0 });
  assert.throws(() => applyUsageSnapshot(state, { subscriptions: [subscription()], observedAt: 5, expectedRevision: state.revision }));
});
test("same-time contradictory report is rejected", () => {
  assert.throws(() => applyUsageSnapshot(initial(), { subscriptions: [subscription("a", { sessionRemaining: 30 })], observedAt: 0, expectedRevision: 0 }), /conflicting/);
});
test("equivalent report key ordering is not a contradictory reading", () => {
  const reordered = Object.fromEntries(Object.entries(subscription()).reverse());
  const state = initial();
  assert.doesNotThrow(() => applyUsageSnapshot(state, { subscriptions: [reordered], observedAt: 0, expectedRevision: state.revision }));
});
test("same-time old reading cannot erase newly pending spend", () => {
  const state = spent();
  assert.throws(() => applyUsageSnapshot(state, { subscriptions: [subscription()], observedAt: 0,
    expectedRevision: state.revision, includedCharges: { session: ["charge"] } }), /reused observation/);
});
test("stale snapshot writer cannot overwrite an allocation", () => {
  const state = allocate(initial()).state;
  assert.throws(() => applyUsageSnapshot(state, { subscriptions: [subscription()], observedAt: 1, expectedRevision: 0 }), /reload/);
});
test("snapshot cannot forget a retained account reservation", () => {
  const state = allocate(initial()).state;
  assert.throws(() => applyUsageSnapshot(state, { subscriptions: [], observedAt: 1, expectedRevision: state.revision }), /drop/);
});
test("invalid provider quota is rejected before it is stored", () => {
  assert.throws(() => createRoutingState({ subscriptions: [subscription("a", { sessionRemaining: NaN })] }));
  assert.throws(() => applyUsageSnapshot(initial(), { subscriptions: [subscription("a", { weeklyRemaining: 1001 })], observedAt: 1, expectedRevision: 0 }));
});
test("routing state owns a copy of snapshots and ledger", () => {
  const subscriptions = [subscription()];
  const state = createRoutingState({ subscriptions });
  subscriptions[0].sessionRemaining = 0;
  assert.equal(state.subscriptions[0].sessionRemaining, 50);
});
