import assert from "node:assert/strict";

export function units(value, label, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${label} must be a safe integer >= ${minimum}`);
  return value;
}

function agentById(ledger, id) {
  const agent = ledger.agents.find((entry) => entry.id === id);
  assert(agent, `unknown agent: ${id}`);
  return agent;
}

export function emptyLedger() {
  return { agents: [], charges: [] };
}

export function reserveAgent(ledger, { id, subscriptionId, estimatedUnits }) {
  assert(typeof id === "string" && id.length > 0, "agent id is required");
  assert(typeof subscriptionId === "string" && subscriptionId.length > 0, "subscription id is required");
  units(estimatedUnits, "estimatedUnits", 1);
  const existing = ledger.agents.find((agent) => agent.id === id);
  if (existing) {
    assert(existing.subscriptionId === subscriptionId && existing.estimatedUnits === estimatedUnits, "conflicting launch retry");
    return ledger;
  }
  return {
    ...ledger,
    agents: [...ledger.agents, { id, subscriptionId, estimatedUnits, futureUnits: estimatedUnits, completed: false }]
  };
}

export function recordSpend(ledger, { id, agentId, spentUnits, sessionResetAt, weeklyResetAt }) {
  assert(typeof id === "string" && id.length > 0, "charge id is required");
  const agent = agentById(ledger, agentId);
  units(spentUnits, "spentUnits", 1);
  units(sessionResetAt, "sessionResetAt");
  units(weeklyResetAt, "weeklyResetAt");
  const charge = { id, agentId, spentUnits, sessionResetAt, weeklyResetAt, sessionIncluded: false, weeklyIncluded: false };
  const existing = ledger.charges.find((entry) => entry.id === id);
  if (existing) {
    for (const key of ["agentId", "spentUnits", "sessionResetAt", "weeklyResetAt"]) {
      assert(existing[key] === charge[key], "conflicting spend retry");
    }
    return ledger;
  }
  assert(!agent.completed, "cannot record new spend after completion");
  return {
    agents: ledger.agents.map((entry) => entry.id === agentId
      ? { ...entry, futureUnits: Math.max(0, entry.futureUnits - spentUnits) } : entry),
    charges: [...ledger.charges, charge]
  };
}

export function reviseFutureSpend(ledger, agentId, futureUnits) {
  const agent = agentById(ledger, agentId);
  assert(!agent.completed, "cannot revise a completed agent");
  units(futureUnits, "futureUnits");
  return { ...ledger, agents: ledger.agents.map((entry) => entry.id === agentId ? { ...entry, futureUnits } : entry) };
}

export function completeAgent(ledger, agentId) {
  agentById(ledger, agentId);
  // Completion releases future work; already-spent work stays reserved until a report includes it.
  return { ...ledger, agents: ledger.agents.map((entry) => entry.id === agentId
    ? { ...entry, futureUnits: 0, completed: true } : entry) };
}

export function acknowledgeCharges(ledger, chargeIds, window) {
  assert(window === "session" || window === "weekly", "unknown window");
  for (const id of chargeIds) assert(ledger.charges.some((charge) => charge.id === id), `unknown charge: ${id}`);
  const included = new Set(chargeIds);
  return { ...ledger, charges: ledger.charges.map((charge) => included.has(charge.id)
    ? { ...charge, [`${window}Included`]: true } : charge) };
}

export function projectedSpend(ledger, subscription) {
  const agents = ledger.agents.filter((agent) => agent.subscriptionId === subscription.id);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const futureUnits = agents.reduce((total, agent) => total + agent.futureUnits, 0);
  const pending = (window) => ledger.charges.filter((charge) => agentIds.has(charge.agentId)
    && !charge[`${window}Included`] && charge[`${window}ResetAt`] === subscription[`${window}ResetAt`])
    .reduce((total, charge) => total + charge.spentUnits, 0);
  return { futureUnits, sessionUnits: futureUnits + pending("session"), weeklyUnits: futureUnits + pending("weekly") };
}
