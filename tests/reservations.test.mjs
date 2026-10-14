import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, reserveAgent, recordSpend, reviseFutureSpend, completeAgent, acknowledgeCharges, projectedSpend } from "../src/reservations.mjs";
import { selectSubscription } from "../src/model.mjs";

const subscription = { id: "a", sessionCapacity: 100, sessionRemaining: 50, sessionResetAt: 300,
  weeklyCapacity: 1000, weeklyRemaining: 500, weeklyResetAt: 10080, sessionBuffer: 10 };
const launch = () => reserveAgent(emptyLedger(), { id: "agent", subscriptionId: "a", estimatedUnits: 20 });
const charge = (ledger, fields = {}) => recordSpend(ledger, { id: "charge", agentId: "agent", spentUnits: 5,
  sessionResetAt: 300, weeklyResetAt: 10080, ...fields });
const tally = (ledger, snapshot = subscription) => projectedSpend(ledger, snapshot);

test("idle agents reserve their whole estimate", () => assert.deepEqual(tally(launch()), { futureUnits: 20, sessionUnits: 20, weeklyUnits: 20 }));
test("local spending moves future reserve into unreported reserve", () => assert.deepEqual(tally(charge(launch())), { futureUnits: 15, sessionUnits: 20, weeklyUnits: 20 }));
test("one report can acknowledge windows independently", () => {
  const ledger = acknowledgeCharges(charge(launch()), ["charge"], "session");
  assert.deepEqual(tally(ledger), { futureUnits: 15, sessionUnits: 15, weeklyUnits: 20 });
});
test("acknowledged spend is not double-counted", () => {
  let ledger = charge(launch());
  ledger = acknowledgeCharges(ledger, ["charge"], "session");
  ledger = acknowledgeCharges(ledger, ["charge"], "weekly");
  const result = selectSubscription({ subscriptions: [{ ...subscription, sessionRemaining: 45, weeklyRemaining: 495 }],
    ledger, requests: [{ units: 1, at: 0 }] });
  assert.equal(result.projectedHeadroom[0].sessionRemaining, 20);
  assert.equal(result.projectedHeadroom[0].weeklyRemaining, 480);
});
test("completion retains spent but unreported charges", () => {
  assert.deepEqual(tally(completeAgent(charge(launch()), "agent")), { futureUnits: 0, sessionUnits: 5, weeklyUnits: 5 });
});
test("completed agent can be fully reconciled later", () => {
  let ledger = completeAgent(charge(launch()), "agent");
  for (const window of ["session", "weekly"]) ledger = acknowledgeCharges(ledger, ["charge"], window);
  assert.deepEqual(tally(ledger), { futureUnits: 0, sessionUnits: 0, weeklyUnits: 0 });
});
test("proven cancellation before any spend releases the estimate", () => {
  assert.deepEqual(tally(completeAgent(launch(), "agent")), { futureUnits: 0, sessionUnits: 0, weeklyUnits: 0 });
});
test("session reset drops old unreported session spend but retains ongoing work and weekly spend", () => {
  assert.deepEqual(tally(charge(launch()), { ...subscription, sessionResetAt: 600 }), { futureUnits: 15, sessionUnits: 15, weeklyUnits: 20 });
});
test("weekly reset drops old weekly spend but retains ongoing work and session spend", () => {
  assert.deepEqual(tally(charge(launch()), { ...subscription, weeklyResetAt: 20160 }), { futureUnits: 15, sessionUnits: 20, weeklyUnits: 15 });
});
test("both resets preserve only future work", () => {
  assert.deepEqual(tally(charge(launch()), { ...subscription, sessionResetAt: 600, weeklyResetAt: 20160 }), { futureUnits: 15, sessionUnits: 15, weeklyUnits: 15 });
});
test("actual spending above the estimate immediately increases debt", () => {
  assert.deepEqual(tally(charge(launch(), { spentUnits: 25 })), { futureUnits: 0, sessionUnits: 25, weeklyUnits: 25 });
});
test("dynamic estimate can increase ongoing future reservation", () => {
  assert.deepEqual(tally(reviseFutureSpend(charge(launch()), "agent", 30)), { futureUnits: 30, sessionUnits: 35, weeklyUnits: 35 });
});
test("dynamic estimate can lower ongoing future reservation", () => {
  assert.deepEqual(tally(reviseFutureSpend(charge(launch()), "agent", 2)), { futureUnits: 2, sessionUnits: 7, weeklyUnits: 7 });
});
test("launch retries are idempotent", () => {
  const ledger = launch();
  assert.equal(reserveAgent(ledger, { id: "agent", subscriptionId: "a", estimatedUnits: 20 }), ledger);
});
test("launch retry after partial spend cannot recreate the original reserve", () => {
  const ledger = charge(launch());
  assert.equal(reserveAgent(ledger, { id: "agent", subscriptionId: "a", estimatedUnits: 20 }), ledger);
});
test("spend retries are idempotent", () => { const ledger = charge(launch()); assert.equal(charge(ledger), ledger); });
test("spend retry after acknowledgment cannot recreate unreported debt", () => {
  const ledger = acknowledgeCharges(charge(launch()), ["charge"], "session");
  assert.equal(charge(ledger), ledger);
});
test("report retries are idempotent", () => {
  const ledger = acknowledgeCharges(charge(launch()), ["charge"], "session");
  assert.deepEqual(acknowledgeCharges(ledger, ["charge"], "session"), ledger);
});
test("one subscription's reservations cannot affect another", () => {
  assert.deepEqual(tally(launch(), { ...subscription, id: "b" }), { futureUnits: 0, sessionUnits: 0, weeklyUnits: 0 });
});
test("multiple idle agents accumulate reservations", () => {
  const ledger = reserveAgent(launch(), { id: "second", subscriptionId: "a", estimatedUnits: 10 });
  assert.deepEqual(tally(ledger), { futureUnits: 30, sessionUnits: 30, weeklyUnits: 30 });
});
test("ledger operations leave prior state unchanged", () => {
  const ledger = launch();
  const before = structuredClone(ledger);
  completeAgent(charge(ledger), "agent");
  assert.deepEqual(ledger, before);
});
test("conflicting launch retry is rejected", () => assert.throws(() => reserveAgent(launch(), { id: "agent", subscriptionId: "a", estimatedUnits: 30 })));
test("conflicting spend retry is rejected", () => assert.throws(() => charge(charge(launch()), { spentUnits: 6 })));
test("unknown charge acknowledgment is rejected", () => assert.throws(() => acknowledgeCharges(launch(), ["unknown"], "session")));
test("unknown agent spend is rejected", () => assert.throws(() => charge(emptyLedger())));
test("negative estimate is rejected", () => assert.throws(() => reviseFutureSpend(launch(), "agent", -1)));
test("completed agent cannot accrue new spend", () => assert.throws(() => charge(completeAgent(launch(), "agent"))));
