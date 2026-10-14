import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription, emptyLedger, reserveAgent, projectedSpend, SESSION_MINUTES, WEEK_MINUTES } from "@usestring/headroom-routing";

const subscription = { id: "a", sessionCapacity: 100, sessionRemaining: 50, sessionResetAt: 300, sessionBuffer: 10,
  weeklyCapacity: 1000, weeklyRemaining: 500, weeklyResetAt: 10080 };

test("the package exports a standalone deterministic selector", () => {
  const decision = selectSubscription({ subscriptions: [subscription], requests: [{ at: 0, units: 10 }] });
  assert.equal(decision.selectedId, "a");
  assert.equal(SESSION_MINUTES, 300);
  assert.equal(WEEK_MINUTES, 10080);
});

test("the exported ledger tracks projected spend", () => {
  const ledger = reserveAgent(emptyLedger(), { id: "agent", subscriptionId: "a", estimatedUnits: 10 });
  assert.deepEqual(projectedSpend(ledger, subscription), { futureUnits: 10, sessionUnits: 10, weeklyUnits: 10 });
});
