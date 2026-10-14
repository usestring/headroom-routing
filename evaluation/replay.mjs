import assert from "node:assert/strict";
import { createRoutingState, allocateAgent, applyUsageSnapshot, estimateAgentUnits,
  recordSpend, completeAgent, SESSION_MINUTES, WEEK_MINUTES } from "../src/index.mjs";

export const POLICIES = ["snapshot-earliest", "snapshot-headroom", "reserved-mean", "reserved-quantile"];

export function runReplay(scenario, policy) {
  assert(POLICIES.includes(policy), "unknown replay policy");
  const { subscriptions, agents, horizon, reportInterval = 120, history = [], defaultUnits = 10, externalSpend = [] } = scenario;
  assert(Number.isSafeInteger(horizon) && horizon > 0 && horizon <= WEEK_MINUTES, "replay horizon must be within one week");
  assert(Number.isSafeInteger(reportInterval) && reportInterval > 0, "invalid report interval");
  const ids = new Set();
  for (const agent of agents) {
    assert(!ids.has(agent.id), "duplicate replay agent id");
    ids.add(agent.id);
    assert(Number.isSafeInteger(agent.at) && agent.at >= 0 && agent.at < horizon, "invalid arrival");
    assert(Number.isSafeInteger(agent.duration) && agent.duration > 0, "invalid duration");
    assert(agent.at + agent.duration < horizon, "every admitted replay agent must finish before the horizon");
    assert(Number.isSafeInteger(agent.actualUnits) && agent.actualUnits > 0, "invalid actual cost");
  }
  const actual = structuredClone(subscriptions);
  let state = createRoutingState({ subscriptions });
  for (const event of externalSpend) {
    assert(Number.isSafeInteger(event.at) && event.at >= 0 && event.at < horizon, "invalid external spend time");
    assert(Number.isSafeInteger(event.units) && event.units > 0, "invalid external spend cost");
    assert(subscriptions.some((entry) => entry.id === event.subscriptionId), "external spend has an unknown account");
  }
  const completedHistory = [...history];
  const running = [];
  const result = { policy, selected: [], admitted: 0, waiting: 0, completed: 0, sessionBlocks: 0, weeklyBlocks: 0,
    expiredWeeklyUnits: 0, actualSpentUnits: 0, estimatedAdmittedUnits: 0 };

  function spend(account, requested) {
    const consumed = Math.min(requested, account.sessionRemaining, account.weeklyRemaining);
    account.sessionRemaining -= consumed;
    account.weeklyRemaining -= consumed;
    return consumed;
  }

  for (let now = 0; now <= horizon; now++) {
    let reset = false;
    for (const account of actual) {
      if (account.sessionResetAt === now) {
        account.sessionRemaining = account.sessionCapacity;
        account.sessionResetAt += SESSION_MINUTES;
        reset = true;
      }
      if (account.weeklyResetAt === now) {
        result.expiredWeeklyUnits += account.weeklyRemaining;
        account.weeklyRemaining = account.weeklyCapacity;
        account.weeklyResetAt += WEEK_MINUTES;
        reset = true;
      }
    }
    for (const event of externalSpend.filter((event) => event.at === now)) {
      const account = actual.find((entry) => entry.id === event.subscriptionId);
      assert(account, "external spend has an unknown account");
      spend(account, event.units);
    }
    for (const agent of running.filter((entry) => !entry.finished && entry.finishAt === now)) {
      const account = actual.find((entry) => entry.id === agent.subscriptionId);
      const sessionBlocked = account.sessionRemaining < agent.actualUnits;
      const weeklyBlocked = account.weeklyRemaining < agent.actualUnits;
      const charge = { id: `spend-${agent.id}`, agentId: agent.id, spentUnits: spend(account, agent.actualUnits),
        sessionResetAt: account.sessionResetAt, weeklyResetAt: account.weeklyResetAt };
      result.actualSpentUnits += charge.spentUnits;
      result.sessionBlocks += Number(sessionBlocked);
      result.weeklyBlocks += Number(weeklyBlocked);
      if (!sessionBlocked && !weeklyBlocked) {
        result.completed++;
        completedHistory.push(agent.actualUnits);
      }
      if (policy.startsWith("reserved-")) {
        let ledger = state.ledger;
        if (charge.spentUnits > 0) ledger = recordSpend(ledger, charge);
        ledger = completeAgent(ledger, agent.id);
        state = { ...state, ledger, revision: state.revision + 1 };
      }
      agent.finished = true;
    }

    const report = now % reportInterval === 0;
    if (report || reset) {
      const snapshot = report ? structuredClone(actual) : state.subscriptions.map((entry) => {
        const next = { ...entry };
        for (const [window, period] of [["session", SESSION_MINUTES], ["weekly", WEEK_MINUTES]]) {
          while (next[`${window}ResetAt`] <= now) {
            next[`${window}Remaining`] = next[`${window}Capacity`];
            next[`${window}ResetAt`] += period;
          }
        }
        return next;
      });
      const includedCharges = {};
      if (report) {
        for (const window of ["session", "weekly"]) includedCharges[window] = state.ledger.charges.map((charge) => charge.id);
      }
      state = now === 0 ? createRoutingState({ subscriptions: snapshot })
        : applyUsageSnapshot(state, { subscriptions: snapshot, observedAt: now,
          expectedRevision: state.revision, includedCharges });
    }

    for (const agent of agents.filter((agent) => agent.at === now)) {
      const estimate = estimateAgentUnits(completedHistory, { defaultUnits, mode: policy === "reserved-quantile" ? "quantile" : "mean" });
      let selectedId;
      if (policy.startsWith("reserved-")) {
        const allocation = allocateAgent(state, { id: agent.id, at: now, estimatedUnits: estimate.units,
          expectedRevision: state.revision, allowedIds: agent.allowedIds });
        state = allocation.state;
        selectedId = allocation.selectedId;
      } else {
        const eligible = state.subscriptions.filter((entry) => entry.enabled !== false && (entry.availableAt ?? 0) <= now
          && (agent.allowedIds == null || agent.allowedIds.includes(entry.id))
          && entry.sessionRemaining - (entry.sessionBuffer ?? 0) >= estimate.units
          && entry.weeklyRemaining - (entry.weeklyBuffer ?? 0) >= estimate.units);
        eligible.sort((a, b) => {
          const delta = policy === "snapshot-earliest" ? a.weeklyResetAt - b.weeklyResetAt
            : b.sessionRemaining / b.sessionCapacity - a.sessionRemaining / a.sessionCapacity;
          return delta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
        selectedId = eligible[0]?.id ?? null;
      }
      result.selected.push({ id: agent.id, at: now, subscriptionId: selectedId, estimatedUnits: estimate.units });
      if (selectedId === null) result.waiting++;
      else {
        result.admitted++;
        result.estimatedAdmittedUnits += estimate.units;
        running.push({ ...agent, subscriptionId: selectedId, finishAt: now + agent.duration, finished: false });
      }
    }
  }
  assert(running.every((agent) => agent.finished), "replay ended with incomplete agents");
  return result;
}
