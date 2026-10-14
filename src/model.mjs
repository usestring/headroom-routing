import assert from "node:assert/strict";
import { emptyLedger, projectedSpend, units } from "./reservations.mjs";

export const SESSION_MINUTES = 300;
export const WEEK_MINUTES = 10080;
const zeroScore = () => ({ blockedRequests: 0, expiredWeeklyUnits: 0, earlyExpiryUnitMinutes: 0, sessionExposure: 0, admissionPressure: 0 });
const scoreFields = Object.keys(zeroScore());

export function compareScores(left, right) {
  for (const field of scoreFields) {
    const tolerance = field === "sessionExposure" || field === "admissionPressure" ? 1e-9 : 0;
    if (Math.abs(left[field] - right[field]) > tolerance) return left[field] < right[field] ? -1 : 1;
  }
  return 0;
}

function addScores(left, right) {
  return Object.fromEntries(scoreFields.map((field) => [field, left[field] + right[field]]));
}

function admissionPressure(state) {
  return state.reduce((total, entry) => total + (entry.sessionCapacity - entry.sessionRemaining) ** 2 / entry.sessionCapacity, 0);
}

export function validateSelectionInput({ now, horizon, subscriptions, requests, maxStates }) {
  units(now, "now");
  units(horizon, "horizon", now + 1);
  assert(horizon <= now + WEEK_MINUTES, "horizon cannot exceed one week");
  units(maxStates, "maxStates", 1);
  assert(Array.isArray(subscriptions), "subscriptions must be an array");
  const ids = new Set();
  for (const subscription of subscriptions) {
    assert(typeof subscription.id === "string" && subscription.id.length > 0 && !ids.has(subscription.id), "subscription ids must be unique");
    ids.add(subscription.id);
    for (const window of ["session", "weekly"]) {
      const capacity = units(subscription[`${window}Capacity`], `${window}Capacity`, 1);
      assert(capacity <= 1_000_000, "capacity exceeds the theory model's numeric bound");
      assert(units(subscription[`${window}Remaining`], `${window}Remaining`) <= capacity, "remaining exceeds capacity");
      const reset = units(subscription[`${window}ResetAt`], `${window}ResetAt`, now);
      assert(reset <= now + (window === "session" ? SESSION_MINUTES : WEEK_MINUTES), "next reset exceeds its window");
      assert(units(subscription[`${window}Buffer`] ?? 0, `${window}Buffer`) < capacity, "buffer must be below capacity");
    }
    assert(subscription.weeklyResetAt <= horizon, "horizon must cover all current weekly resets");
    units(subscription.availableAt ?? now, "availableAt");
    assert((subscription.availableAt ?? now) <= now + WEEK_MINUTES, "outage exceeds the theory horizon");
  }
  assert(Array.isArray(requests) && requests.length > 0 && requests.length <= 100, "provide 1..100 requests");
  let previousAt = now;
  for (const request of requests) {
    units(request.at, "request.at", previousAt);
    assert(request.at < horizon, "request must arrive before the horizon");
    units(request.units, "request.units", 1);
    if (request.spendAt != null) units(request.spendAt, "request.spendAt", request.at);
    assert((request.spendAt ?? request.at) <= now + WEEK_MINUTES, "expected spend exceeds one week");
    if (request.allowedIds != null) {
      assert(Array.isArray(request.allowedIds), "allowedIds must be an array");
      for (const id of request.allowedIds) assert(ids.has(id), `unknown allowed subscription: ${id}`);
    }
    previousAt = request.at;
  }
  assert(requests[0].at === now, "the current request must arrive now");
}

function eligible(subscription, request) {
  return subscription.enabled !== false && (request.allowedIds == null || request.allowedIds.includes(subscription.id));
}

function fits(subscription, request) {
  return eligible(subscription, request) && subscription.availableAt <= request.at
    && subscription.sessionRemaining >= request.units && subscription.weeklyRemaining >= request.units;
}

function outstandingSpend(entry) {
  return entry.pendingSpend.reduce((total, charge) => total + charge.units, 0);
}

function commitRequest(state, candidate, request) {
  return state.map((entry) => {
    if (entry.id !== candidate.id) return entry;
    const pendingSpend = [...entry.pendingSpend];
    if ((request.spendAt ?? request.at) > request.at) {
      const index = pendingSpend.findIndex((charge) => charge.at === request.spendAt);
      if (index >= 0) pendingSpend[index] = { at: request.spendAt, units: pendingSpend[index].units + request.units };
      else pendingSpend.push({ at: request.spendAt, units: request.units });
      pendingSpend.sort((a, b) => a.at - b.at);
    }
    return { ...entry, sessionRemaining: entry.sessionRemaining - request.units,
      weeklyRemaining: entry.weeklyRemaining - request.units, pendingSpend };
  });
}

function advance(state, from, to, horizon) {
  const score = zeroScore();
  const next = state.map((subscription) => {
    const entry = { ...subscription, pendingSpend: [...subscription.pendingSpend] };
    let at = from;
    for (let event = Math.min(entry.sessionResetAt, entry.weeklyResetAt, entry.pendingSpend[0]?.at ?? Infinity);
      event <= to; event = Math.min(entry.sessionResetAt, entry.weeklyResetAt, entry.pendingSpend[0]?.at ?? Infinity)) {
      const used = entry.sessionCapacity - entry.sessionRemaining;
      score.sessionExposure += used * used / entry.sessionCapacity * (event - at) / SESSION_MINUTES;
      if (entry.sessionResetAt === event) {
        entry.sessionRemaining = entry.sessionRenewedRemaining - outstandingSpend(entry);
        entry.sessionResetAt += SESSION_MINUTES;
      }
      if (entry.weeklyResetAt === event) {
        const wasted = Math.max(0, entry.weeklyRemaining + entry.projectedFutureUnits
          + outstandingSpend(entry) + (entry.weeklyBuffer ?? 0));
        score.expiredWeeklyUnits += wasted;
        score.earlyExpiryUnitMinutes += wasted * (horizon - event + 1);
        entry.weeklyRemaining = entry.weeklyRenewedRemaining - outstandingSpend(entry);
        entry.weeklyResetAt += WEEK_MINUTES;
      }
      entry.pendingSpend = entry.pendingSpend.filter((charge) => charge.at !== event);
      at = event;
    }
    const used = entry.sessionCapacity - entry.sessionRemaining;
    score.sessionExposure += used * used / entry.sessionCapacity * (to - at) / SESSION_MINUTES;
    return entry;
  });
  return { state: next, score };
}

function retryAt(state, request, now, horizon) {
  let earliest = null;
  for (const subscription of state) {
    if (!eligible(subscription, request)) continue;
    let entry = subscription;
    let at = now;
    for (let attempts = 0; attempts < 4; attempts++) {
      if (fits(entry, { ...request, at })) {
        earliest = earliest == null ? at : Math.min(earliest, at);
        break;
      }
      const times = [];
      if (entry.availableAt > at) times.push(entry.availableAt);
      if (entry.sessionRemaining < request.units && entry.sessionRenewedRemaining >= request.units) times.push(entry.sessionResetAt);
      if (entry.weeklyRemaining < request.units && entry.weeklyRenewedRemaining >= request.units) times.push(entry.weeklyResetAt);
      if (!times.length) break;
      const nextAt = Math.min(...times);
      entry = advance([entry], at, nextAt, Math.max(horizon, nextAt)).state[0];
      at = nextAt;
    }
  }
  return earliest;
}

export function selectSubscription(input) {
  const { now = 0, subscriptions, requests, ledger = emptyLedger(), maxStates = 50_000 } = input;
  const horizon = input.horizon ?? Math.max(now + 1, ...subscriptions.map((entry) => entry.weeklyResetAt));
  validateSelectionInput({ now, horizon, subscriptions, requests, maxStates });
  const ids = new Set(subscriptions.map((entry) => entry.id));
  for (const agent of ledger.agents) assert(ids.has(agent.subscriptionId), `reservation for unknown subscription: ${agent.subscriptionId}`);
  const initial = [...subscriptions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((entry) => {
    const projected = projectedSpend(ledger, entry);
    return {
      ...entry,
      availableAt: entry.availableAt ?? now,
      projectedFutureUnits: projected.futureUnits,
      pendingSpend: [],
      sessionRemaining: entry.sessionRemaining - projected.sessionUnits - (entry.sessionBuffer ?? 0),
      weeklyRemaining: entry.weeklyRemaining - projected.weeklyUnits - (entry.weeklyBuffer ?? 0),
      sessionRenewedRemaining: entry.sessionCapacity - projected.futureUnits - (entry.sessionBuffer ?? 0),
      weeklyRenewedRemaining: entry.weeklyCapacity - projected.futureUnits - (entry.weeklyBuffer ?? 0)
    };
  });
  const memo = new Map();
  let visited = 0;

  function solve(state, index, from) {
    const key = JSON.stringify([index, state.map((entry) => [entry.sessionRemaining, entry.weeklyRemaining, entry.sessionResetAt, entry.weeklyResetAt, entry.pendingSpend])]);
    if (memo.has(key)) return memo.get(key);
    assert(++visited <= maxStates, "theoretical search limit exceeded; shorten the forecast");
    const at = index === requests.length ? horizon : requests[index].at;
    const advanced = advance(state, from, at, horizon);
    if (index === requests.length) return { score: advanced.score, plan: [] };
    const request = requests[index];
    const candidates = advanced.state.filter((entry) => fits(entry, request));
    let best;
    for (const candidate of candidates) {
      const next = commitRequest(advanced.state, candidate, request);
      const suffix = solve(next, index + 1, at);
      const prefix = { ...advanced.score, admissionPressure: admissionPressure(next) };
      const option = { score: addScores(prefix, suffix.score), plan: [candidate.id, ...suffix.plan] };
      if (!best || compareScores(option.score, best.score) < 0) best = option;
    }
    if (!best) {
      const suffix = solve(advanced.state, index + 1, at);
      best = { score: addScores(advanced.score, { ...suffix.score, blockedRequests: suffix.score.blockedRequests + 1 }), plan: [null, ...suffix.plan] };
    }
    memo.set(key, best);
    return best;
  }

  const { state: current, score: currentResetScore } = advance(initial, now, now, horizon);
  const candidates = [];
  for (const candidate of current.filter((entry) => fits(entry, requests[0]))) {
    const state = commitRequest(current, candidate, requests[0]);
    const prefix = { ...currentResetScore, admissionPressure: admissionPressure(state) };
    const suffix = solve(state, 1, now);
    candidates.push({ id: candidate.id, score: addScores(prefix, suffix.score), plan: [candidate.id, ...suffix.plan] });
  }
  let best;
  for (const candidate of candidates) if (!best || compareScores(candidate.score, best.score) < 0) best = candidate;
  const blocked = best == null ? solve(initial, 0, now) : null;
  return {
    selectedId: best?.id ?? null,
    reason: best ? "selected" : "no_capacity",
    retryAt: best ? null : retryAt(current, requests[0], now, horizon),
    score: best?.score ?? blocked.score,
    plan: best?.plan ?? blocked.plan,
    candidates,
    projectedHeadroom: current.map((entry) => ({ id: entry.id, sessionRemaining: entry.sessionRemaining, weeklyRemaining: entry.weeklyRemaining })),
    exploredStates: visited
  };
}
