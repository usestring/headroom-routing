import assert from "node:assert/strict";
import { units } from "./reservations.mjs";

export function assessFreeTier({ observations, nowMs, maxAgeMs = 120_000 }) {
  units(nowMs, "nowMs");
  units(maxAgeMs, "maxAgeMs");
  assert(Array.isArray(observations), "observations must be an array");
  for (const observation of observations) {
    units(observation.atMs, "observation.atMs");
    assert(observation.atMs <= nowMs, "observation cannot be in the future");
    assert(["free_success", "free_limit", "paid_success", "error"].includes(observation.outcome), "unknown observation outcome");
  }
  const checks = observations.filter((observation) => observation.outcome !== "paid_success")
    .toSorted((a, b) => a.atMs - b.atMs);
  for (let index = 1; index < checks.length; index++) {
    assert(checks[index].atMs !== checks[index - 1].atMs || checks[index].outcome === checks[index - 1].outcome,
      "conflicting observations at the same time");
  }
  const latest = checks.at(-1);
  const refusal = checks.findLast((observation) => observation.outcome === "free_limit");
  const success = refusal && checks.find((observation) => observation.outcome === "free_success" && observation.atMs > refusal.atMs);
  const fresh = latest !== undefined && nowMs - latest.atMs <= maxAgeMs;
  const availability = latest?.outcome === "free_success" ? "available" : latest?.outcome === "free_limit" ? "exhausted" : "unknown";
  let reason = latest ? "probe_error" : "unread";
  if (availability === "available") reason = "uncalibrated";
  else if (availability === "exhausted") reason = "limit";
  if (latest && !fresh) reason = "stale";
  return {
    availability, observedAtMs: latest?.atMs ?? null, fresh, reason,
    usable: false, headroomPercent: null, resetsAtMs: null,
    // A successful request proves recovery, but neither its remaining allowance nor its reset period.
    recoveryInterval: success ? { afterMs: refusal.atMs, byMs: success.atMs, widthMs: success.atMs - refusal.atMs } : null
  };
}
