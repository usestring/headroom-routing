import assert from "node:assert/strict";
import { selectSubscription, validateSelectionInput } from "./model.mjs";
import { emptyLedger, reserveAgent, acknowledgeCharges, units } from "./reservations.mjs";

export function createRoutingState({ subscriptions, ledger = emptyLedger(), observedAt = 0 }) {
  validateSnapshot(subscriptions, observedAt);
  return { subscriptions: structuredClone(subscriptions), ledger: structuredClone(ledger), observedAt, lastAllocatedAt: observedAt, revision: 0 };
}

function validateSnapshot(subscriptions, observedAt) {
  units(observedAt, "observedAt");
  assert(Array.isArray(subscriptions), "subscriptions must be an array");
  validateSelectionInput({ now: observedAt, horizon: Math.max(observedAt + 1, ...subscriptions.map((entry) => entry.weeklyResetAt)),
    subscriptions, requests: [{ at: observedAt, units: 1 }], maxStates: 1 });
}

function checkRevision(state, expectedRevision) {
  units(expectedRevision, "expectedRevision");
  assert(state.revision === expectedRevision, "routing state changed; reload before allocating");
}

export function allocateAgent(state, input) {
  const { id, at, estimatedUnits, expectedRevision, allowedIds, forecast = [], horizon, maxStates } = input;
  assert(typeof id === "string" && id.length > 0, "agent id is required");
  units(at, "at");
  units(estimatedUnits, "estimatedUnits", 1);
  const existing = state.ledger.agents.find((agent) => agent.id === id);
  if (existing) {
    assert(existing.estimatedUnits === estimatedUnits, "conflicting launch retry");
    assert(allowedIds == null || allowedIds.includes(existing.subscriptionId), "retry excludes the reserved subscription");
    return { state, status: "already_reserved", selectedId: existing.subscriptionId, decision: null };
  }
  checkRevision(state, expectedRevision);
  assert(at >= Math.max(state.observedAt, state.lastAllocatedAt), "allocation time cannot move backwards");
  const decision = selectSubscription({ subscriptions: state.subscriptions, ledger: state.ledger, now: at,
    requests: [{ at, units: estimatedUnits, ...(allowedIds == null ? {} : { allowedIds }) }, ...forecast], horizon, maxStates });
  if (decision.selectedId === null) return { state, status: "waiting", selectedId: null, decision };
  const ledger = reserveAgent(state.ledger, { id, subscriptionId: decision.selectedId, estimatedUnits });
  return { state: { ...state, ledger, lastAllocatedAt: at, revision: state.revision + 1 }, status: "reserved", selectedId: decision.selectedId, decision };
}

function normalizedSnapshot(subscriptions) {
  return subscriptions.map((entry) => Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function applyUsageSnapshot(state, { subscriptions, observedAt, expectedRevision, includedCharges = {} }) {
  checkRevision(state, expectedRevision);
  units(observedAt, "observedAt", state.observedAt);
  validateSnapshot(subscriptions, observedAt);
  const snapshot = normalizedSnapshot(subscriptions);
  if (observedAt === state.observedAt) {
    assert(JSON.stringify(snapshot) === JSON.stringify(normalizedSnapshot(state.subscriptions)), "conflicting snapshot at the same observation time");
  }
  const ids = new Set(snapshot.map((subscription) => subscription.id));
  for (const agent of state.ledger.agents) {
    assert(ids.has(agent.subscriptionId), "snapshot cannot drop an account with retained reservations");
  }
  let ledger = state.ledger;
  for (const window of ["session", "weekly"]) {
    const charges = includedCharges[window] ?? [];
    assert(Array.isArray(charges), "included charges must be an array");
    if (observedAt === state.observedAt) {
      for (const id of charges) {
        const charge = ledger.charges.find((entry) => entry.id === id);
        assert(charge?.[`${window}Included`], "a reused observation cannot acknowledge new spend");
      }
    }
    ledger = acknowledgeCharges(ledger, charges, window);
  }
  return { ...state, subscriptions: structuredClone(snapshot), ledger, observedAt, revision: state.revision + 1 };
}
