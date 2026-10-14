import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription, compareScores } from "../src/model.mjs";
import { emptyLedger, reserveAgent } from "../src/reservations.mjs";

const sub = (id, fields = {}) => ({ id, sessionCapacity: 10, sessionRemaining: 10, sessionResetAt: 300,
  weeklyCapacity: 100, weeklyRemaining: 100, weeklyResetAt: 10080, ...fields });
const request = (units = 2, at = 0, allowedIds) => ({ units, at, ...(allowedIds == null ? {} : { allowedIds }) });
const select = (subscriptions, requests = [request()], extra = {}) => selectSubscription({ subscriptions, requests, ...extra });
const expiring = () => [sub("early", { weeklyRemaining: 8, weeklyResetAt: 60 }), sub("later")];

const scenarios = [
  ["one subscription with room", [sub("only")], [request()], "only"],
  ["equal accounts break ties by stable id", [sub("b"), sub("a")], [request()], "a"],
  ["consume earlier weekly headroom when throughput ties", expiring(), [request()], "early"],
  ["full session cannot win on weekly urgency", [sub("early", { sessionRemaining: 0, weeklyResetAt: 60 }), sub("later")], [request()], "later"],
  ["weekly quota is also a hard capacity limit", [sub("early", { weeklyRemaining: 1, weeklyResetAt: 60 }), sub("later")], [request()], "later"],
  ["exact session fit is allowed", [sub("only", { sessionRemaining: 2 })], [request()], "only"],
  ["exact weekly fit is allowed", [sub("only", { weeklyRemaining: 2 })], [request()], "only"],
  ["one unit above remaining cannot launch", [sub("only", { sessionRemaining: 1 })], [request()], null],
  ["no accounts yields no selection", [], [request()], null],
  ["disabled account is ineligible", [sub("a", { enabled: false }), sub("b")], [request()], "b"],
  ["all disabled yields no selection", [sub("a", { enabled: false })], [request()], null],
  ["known outage cannot win", [sub("a", { availableAt: 30 }), sub("b")], [request()], "b"],
  ["outage ending now is eligible", [sub("a", { availableAt: 0 })], [request()], "a"],
  ["model compatibility constrains selection", [sub("a"), sub("b")], [request(2, 0, ["b"])], "b"],
  ["empty compatibility set cannot launch", [sub("a")], [request(2, 0, [])], null],
  ["weekly reset at now replenishes quota", [sub("a", { weeklyRemaining: 0, weeklyResetAt: 0 })], [request()], "a"],
  ["session reset at now replenishes quota", [sub("a", { sessionRemaining: 0, sessionResetAt: 0 })], [request()], "a"],
  ["same deadlines prefer less five-hour pressure", [sub("a", { sessionRemaining: 4 }), sub("b")], [request()], "b"],
  ["large plan absorbs more work at equal normalized usage", [sub("a", { sessionRemaining: 9 }), sub("b", { sessionCapacity: 20, sessionRemaining: 18 })], [request(1)], "b"],
  ["imminent session reset makes a short burst cheap", [sub("a", { sessionRemaining: 4, sessionResetAt: 1 }), sub("b")], [request()], "a"],
  ["protect account needed by a future model-pinned request", expiring(), [request(), request(8, 30, ["early"])], "later"],
  ["preserve large-job fit despite earlier weekly expiry", [sub("large", { weeklyResetAt: 60 }), sub("small", { sessionRemaining: 4 })], [request(4), request(10, 1)], "small"],
  ["weekly exhaustion must not strand a future request", [sub("a", { weeklyRemaining: 4, weeklyResetAt: 60 }), sub("b")], [request(4), request(4, 1, ["a"])], "b"],
  ["future session reset restores ability to serve", [sub("a", { sessionResetAt: 1, weeklyResetAt: 60 }), sub("b")], [request(4), request(10, 1, ["a"])], "a"],
  ["future weekly reset restores ability to serve", [sub("a", { sessionCapacity: 20, sessionRemaining: 20, weeklyRemaining: 4, weeklyResetAt: 1 }), sub("b")], [request(4), request(4, 1, ["a"])], "a"],
  ["weekly burn takes precedence over smoothing when throughput ties", [sub("early", { sessionRemaining: 3, weeklyRemaining: 3, weeklyResetAt: 60 }), sub("later")], [request()], "early"],
  ["buffer excludes otherwise exact session fit", [sub("a", { sessionRemaining: 2, sessionBuffer: 1 }), sub("b")], [request()], "b"],
  ["buffer allows fit up to the protected boundary", [sub("a", { sessionRemaining: 3, sessionBuffer: 1 })], [request()], "a"],
  ["weekly buffer also binds", [sub("a", { weeklyRemaining: 2, weeklyBuffer: 1 }), sub("b")], [request()], "b"],
  ["single request too large for any plan", [sub("a"), sub("b")], [request(11)], null]
];

for (const [name, subscriptions, requests, expected] of scenarios) {
  test(name, () => assert.equal(select(subscriptions, requests).selectedId, expected));
}

test("simultaneous requests spread across identical accounts", () => {
  const result = select([sub("a"), sub("b")], [request(), request(), request(), request()]);
  assert.deepEqual(result.plan, ["a", "b", "a", "b"]);
  assert.equal(result.score.blockedRequests, 0);
});

test("blocking is unavoidable when aggregate session capacity is insufficient", () => {
  const result = select([sub("a"), sub("b")], [request(10), request(10), request(10)]);
  assert.deepEqual(result.plan, ["a", "b", null]);
  assert.equal(result.score.blockedRequests, 1);
});

test("aggregate room does not imply indivisible request fits", () => {
  const result = select([sub("a", { sessionRemaining: 6 }), sub("b", { sessionRemaining: 6 })], [request(7)]);
  assert.equal(result.selectedId, null);
  assert.equal(result.retryAt, 300);
});

test("no fit returns earliest simultaneous session and weekly availability", () => {
  const result = select([sub("a", { sessionRemaining: 0, sessionResetAt: 10, weeklyRemaining: 0, weeklyResetAt: 60 }),
    sub("b", { sessionRemaining: 0, sessionResetAt: 20 })]);
  assert.equal(result.selectedId, null);
  assert.equal(result.retryAt, 20);
});

test("weekly and session exhaustion on the same account wait for both", () => {
  assert.equal(select([sub("a", { sessionRemaining: 0, sessionResetAt: 10, weeklyRemaining: 0, weeklyResetAt: 60 })]).retryAt, 60);
});

test("oversized request has no reset that can make it fit", () => assert.equal(select([sub("a")], [request(11)]).retryAt, null));
test("outage availability is included in retry time", () => assert.equal(select([sub("a", { availableAt: 45 })]).retryAt, 45));

test("reset at a future arrival happens before selection", () => {
  const result = select([sub("a", { sessionResetAt: 10 })], [request(10), request(10, 10)]);
  assert.deepEqual(result.plan, ["a", "a"]);
});

test("weekly waste is measured in work units rather than percentages", () => {
  const result = select([sub("a", { weeklyCapacity: 20, weeklyRemaining: 20 }), sub("b")], [request(2)]);
  assert.equal(result.score.expiredWeeklyUnits, 118);
});

test("future work after an early reset still favors consuming earlier quota", () => {
  const result = select(expiring(), [request(2), request(6, 70, ["later"])]);
  assert.equal(result.selectedId, "early");
  assert.equal(result.score.expiredWeeklyUnits, 100);
});

test("a launch reservation changes the next decision before the snapshot changes", () => {
  const subscriptions = [sub("a"), sub("b")];
  let ledger = emptyLedger();
  const first = select(subscriptions, [request(6)], { ledger });
  ledger = reserveAgent(ledger, { id: "first", subscriptionId: first.selectedId, estimatedUnits: 6 });
  assert.equal(select(subscriptions, [request(6)], { ledger }).selectedId, "b");
});

test("50 percent remaining cannot launch 100 idle agents through a stale snapshot", () => {
  const subscriptions = [sub("a", { sessionCapacity: 100, sessionRemaining: 50, sessionBuffer: 10 })];
  let ledger = emptyLedger();
  let launched = 0;
  for (let index = 0; index < 100; index++) {
    const result = select(subscriptions, [request(10)], { ledger });
    if (result.selectedId == null) continue;
    ledger = reserveAgent(ledger, { id: `agent-${index}`, subscriptionId: result.selectedId, estimatedUnits: 10 });
    launched++;
  }
  assert.equal(launched, 4);
});

test("reservations constrain weekly capacity independently", () => {
  const ledger = reserveAgent(emptyLedger(), { id: "busy", subscriptionId: "a", estimatedUnits: 3 });
  assert.equal(select([sub("a", { weeklyRemaining: 4 })], [request(2)], { ledger }).selectedId, null);
});

test("oversubscription remains visible and cannot admit a new launch", () => {
  const ledger = reserveAgent(emptyLedger(), { id: "busy", subscriptionId: "a", estimatedUnits: 12 });
  const result = select([sub("a")], [request()], { ledger });
  assert.equal(result.selectedId, null);
  assert.equal(result.projectedHeadroom[0].sessionRemaining, -2);
  assert.equal(result.retryAt, null);
});

test("buffer and ongoing future reservations survive session reset", () => {
  const ledger = reserveAgent(emptyLedger(), { id: "idle", subscriptionId: "a", estimatedUnits: 7 });
  const result = select([sub("a", { sessionRemaining: 7, sessionResetAt: 10, sessionBuffer: 2 })], [request(2)], { ledger });
  assert.equal(result.selectedId, null);
  assert.equal(result.retryAt, null);
});

test("weekly capacity unreachable through the session window is allowed to expire", () => {
  const result = select([sub("a", { sessionRemaining: 2, weeklyRemaining: 8, weeklyResetAt: 60 })], [request(2), request(2, 1)]);
  assert.deepEqual(result.plan, ["a", null]);
  assert.equal(result.score.expiredWeeklyUnits, 6);
});

test("unused weekly buffer counts as expired quota", () => {
  const result = select([sub("a", { weeklyBuffer: 10 })]);
  assert.equal(result.score.expiredWeeklyUnits, 98);
});

test("changing a forecast can change the route from the same snapshot", () => {
  const subscriptions = [sub("a", { sessionCapacity: 2, sessionRemaining: 2 }), sub("b", { sessionCapacity: 2, sessionRemaining: 2 })];
  assert.equal(select(subscriptions, [request(2)]).selectedId, "a");
  assert.equal(select(subscriptions, [request(2), request(2, 1, ["a"])]).selectedId, "b");
});

test("earliest-expiry greedy baseline would block the upcoming large request", () => {
  const subscriptions = [sub("large", { weeklyResetAt: 60 }), sub("small", { sessionRemaining: 4 })];
  assert.equal(subscriptions.toSorted((a, b) => a.weeklyResetAt - b.weeklyResetAt)[0].id, "large");
  const greedyRemaining = { large: 6, small: 4 };
  assert(Object.values(greedyRemaining).every((remaining) => remaining < 10));
  const result = select(subscriptions, [request(4), request(10, 1)]);
  assert.deepEqual(result.plan, ["small", "large"]);
  assert.equal(result.score.blockedRequests, 0);
});

test("permutation cannot change the selected id or plan", () => {
  const subscriptions = [sub("c"), sub("a"), sub("b")];
  const requests = [request(2), request(3, 5), request(4, 10)];
  const expected = select(subscriptions, requests);
  for (const permutation of [subscriptions.toReversed(), [subscriptions[1], subscriptions[2], subscriptions[0]]]) {
    assert.deepEqual(select(permutation, requests), expected);
  }
});

test("selection does not mutate caller state", () => {
  const subscriptions = [sub("a")];
  const requests = [request()];
  const before = structuredClone({ subscriptions, requests });
  Object.freeze(subscriptions[0]);
  Object.freeze(requests[0]);
  select(subscriptions, requests);
  assert.deepEqual({ subscriptions, requests }, before);
});

test("capacity scaling preserves routing with comparable units", () => {
  const subscriptions = [sub("a", { sessionRemaining: 4 }), sub("b")];
  const requests = [request(2), request(3, 5)];
  const scaled = subscriptions.map((entry) => ({ ...entry, sessionCapacity: entry.sessionCapacity * 10,
    sessionRemaining: entry.sessionRemaining * 10, weeklyCapacity: entry.weeklyCapacity * 10, weeklyRemaining: entry.weeklyRemaining * 10 }));
  assert.deepEqual(select(scaled, requests.map((entry) => ({ ...entry, units: entry.units * 10 }))).plan, select(subscriptions, requests).plan);
});

test("one predicted block cannot be bought off with less weekly waste", () => {
  assert.equal(compareScores({ blockedRequests: 0, expiredWeeklyUnits: 100, earlyExpiryUnitMinutes: 100, sessionExposure: 100 },
    { blockedRequests: 1, expiredWeeklyUnits: 0, earlyExpiryUnitMinutes: 0, sessionExposure: 0 }), -1);
});

const invalid = [
  ["unknown quota is rejected", () => select([sub("a", { sessionRemaining: undefined })])],
  ["past snapshot reset requires refresh", () => select([sub("a", { sessionResetAt: -1 })])],
  ["duplicate subscription ids are rejected", () => select([sub("a"), sub("a")])],
  ["negative remaining is rejected as a raw snapshot", () => select([sub("a", { weeklyRemaining: -1 })])],
  ["percentage-like fractional units require normalization", () => select([sub("a")], [request(0.2)])],
  ["zero-cost launch is rejected", () => select([sub("a")], [request(0)])],
  ["out-of-order forecast is rejected", () => select([sub("a")], [request(), request(2, 10), request(2, 5)])],
  ["horizon cannot hide a weekly reset", () => select([sub("a")], [request()], { horizon: 60 })],
  ["request at horizon is rejected", () => select([sub("a")], [request(), request(2, 10080)])],
  ["unknown model eligibility id is rejected", () => select([sub("a")], [request(2, 0, ["missing"])])],
  ["unbounded outage cannot cause an unbounded reset scan", () => select([sub("a", { availableAt: Number.MAX_SAFE_INTEGER })])],
  ["too small a search budget fails explicitly", () => select([sub("a"), sub("b")], [request(), request()], { maxStates: 1 })],
  ["foreign reservation is rejected", () => select([sub("a")], [request()], { ledger: reserveAgent(emptyLedger(), { id: "x", subscriptionId: "b", estimatedUnits: 2 }) })]
];
for (const [name, run] of invalid) test(name, () => assert.throws(run));
