import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFreeTier } from "@usestring/headroom-routing";

const minute = 60_000;
const start = 1_000_000;
const successAt = start + 180 * minute;
const observations = [
  { atMs: start, outcome: "free_limit" },
  { atMs: start + 20 * minute, outcome: "paid_success" },
  { atMs: successAt, outcome: "free_success" }
];

test("recovery uses the first actual free success without converting observed use to quota", () => {
  const input = [...observations, { atMs: successAt + minute, outcome: "free_success" }].reverse();
  const before = structuredClone(input);
  const result = assessFreeTier({ observations: input, nowMs: successAt + minute });
  assert.equal(result.availability, "available");
  assert.equal(result.fresh, true);
  assert.equal(result.reason, "uncalibrated");
  assert.equal(result.usable, false);
  assert.equal(result.headroomPercent, null);
  assert.equal(result.resetsAtMs, null);
  assert.deepEqual(result.recoveryInterval, { afterMs: start, byMs: successAt, widthMs: 180 * minute });
  assert.deepEqual(input, before);
});

test("paid fallback and probe errors do not establish free recovery", () => {
  const refused = assessFreeTier({ observations: observations.slice(0, 2), nowMs: start + 20 * minute });
  assert.equal(refused.availability, "exhausted");
  assert.equal(refused.observedAtMs, start);
  assert.equal(refused.fresh, false);
  assert.equal(refused.recoveryInterval, null);
  const error = assessFreeTier({ observations: [...observations.slice(0, 2), { atMs: successAt, outcome: "error" }], nowMs: successAt });
  assert.equal(error.availability, "unknown");
  assert.equal(error.reason, "probe_error");
  assert.equal(error.recoveryInterval, null);
  const unread = assessFreeTier({ observations: [observations[1]], nowMs: successAt });
  assert.equal(unread.observedAtMs, null);
  assert.equal(unread.reason, "unread");
});

test("a later refusal begins a new unresolved cycle and stale success stays historical", () => {
  const stale = assessFreeTier({ observations, nowMs: successAt + 2 * minute + 1 });
  assert.equal(stale.reason, "stale");
  assert.equal(stale.fresh, false);
  assert.equal(stale.availability, "available");
  const next = assessFreeTier({ observations: [...observations, { atMs: successAt + minute, outcome: "free_limit" }], nowMs: successAt + minute });
  assert.equal(next.availability, "exhausted");
  assert.equal(next.reason, "limit");
  assert.equal(next.recoveryInterval, null);
});

test("invalid evidence cannot produce a valid recovery interval", () => {
  for (const invalid of [
    [{ atMs: successAt + 1, outcome: "free_success" }],
    [{ atMs: NaN, outcome: "free_limit" }],
    [{ atMs: start, outcome: "unknown" }],
    [{ atMs: start, outcome: "free_limit" }, { atMs: start, outcome: "free_success" }]
  ]) assert.throws(() => assessFreeTier({ observations: invalid, nowMs: successAt }));
});
