import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription, createRoutingState, allocateAgent } from "../src/index.mjs";
import { enumerate } from "./support/oracle.mjs";

const sub = (id, fields = {}) => ({ id, sessionCapacity: 10, sessionRemaining: 10, sessionResetAt: 300,
  weeklyCapacity: 100, weeklyRemaining: 100, weeklyResetAt: 10080, ...fields });
const choose = (subscriptions, requests, extra = {}) => selectSubscription({ subscriptions, requests, ...extra });

test("expected spend after expiry cannot burn the old weekly quota", () => {
  const subscriptions = [sub("early", { sessionRemaining: 4, weeklyResetAt: 10 }), sub("later")];
  assert.equal(choose(subscriptions, [{ at: 0, units: 2 }]).selectedId, "early");
  const delayed = choose(subscriptions, [{ at: 0, units: 2, spendAt: 20 }]);
  assert.equal(delayed.selectedId, "later");
  assert.equal(delayed.score.expiredWeeklyUnits, 198);
});

test("expected spend before expiry burns the old weekly quota", () => {
  assert.equal(choose([sub("early", { sessionRemaining: 4, weeklyResetAt: 10 }), sub("later")],
    [{ at: 0, units: 2, spendAt: 9 }]).selectedId, "early");
});

test("spend exactly at weekly reset belongs to the renewed quota", () => {
  const result = choose([sub("a", { weeklyResetAt: 10 })], [{ at: 0, units: 2, spendAt: 10 }], { horizon: 10 });
  assert.equal(result.score.expiredWeeklyUnits, 100);
});

test("unspent commitments survive a session reset and constrain later selections", () => {
  const subscriptions = [sub("a", { sessionResetAt: 2 }), sub("b")];
  assert.deepEqual(choose(subscriptions, [{ at: 0, units: 10, spendAt: 4, allowedIds: ["a"] },
    { at: 3, units: 10 }]).plan, ["a", "b"]);
});

test("settlement replaces a reservation without creating spare capacity", () => {
  assert.deepEqual(choose([sub("a", { sessionResetAt: 2 })], [{ at: 0, units: 10, spendAt: 3 },
    { at: 3, units: 1 }]).plan, ["a", null]);
});

test("a reset after settlement releases the completed window cost", () => {
  assert.deepEqual(choose([sub("a", { sessionResetAt: 3 })], [{ at: 0, units: 10, spendAt: 2 },
    { at: 3, units: 10 }]).plan, ["a", "a"]);
});

test("both quota reservations survive simultaneous resets", () => {
  const result = choose([sub("a", { sessionResetAt: 2, weeklyResetAt: 2, weeklyCapacity: 10, weeklyRemaining: 10 })],
    [{ at: 0, units: 10, spendAt: 5 }, { at: 3, units: 1 }], { horizon: 6 });
  assert.deepEqual(result.plan, ["a", null]);
  assert.equal(result.score.expiredWeeklyUnits, 10);
});

test("spend beyond the evaluation horizon is still held and counted as unused", () => {
  const result = choose([sub("a", { weeklyResetAt: 10 })], [{ at: 0, units: 2, spendAt: 20 }], { horizon: 10 });
  assert.equal(result.score.expiredWeeklyUnits, 100);
});

test("multiple commitments can settle out of admission order", () => {
  const subscriptions = [sub("a", { sessionResetAt: 3 })];
  const requests = [{ at: 0, units: 4, spendAt: 5 }, { at: 1, units: 4, spendAt: 2 }, { at: 4, units: 6 }];
  assert.deepEqual(choose(subscriptions, requests).plan, ["a", "a", "a"]);
});

test("allocator passes expected spend timing and planner configuration while retaining actual ledger debt", () => {
  const state = createRoutingState({ subscriptions: [sub("early", { sessionRemaining: 4, weeklyResetAt: 10 }), sub("later")] });
  const result = allocateAgent(state, { id: "idle", at: 0, estimatedUnits: 2, spendAt: 20,
    expectedRevision: 0, planner: "beam", beamWidth: 8 });
  assert.equal(result.selectedId, "later");
  assert.equal(result.decision.planner, "beam");
  assert.equal(result.state.ledger.agents[0].futureUnits, 2);
});

test("exact and unpruned beam plans agree with an independent delayed-spend oracle on 6912 cases", () => {
  let checked = 0;
  for (const aRemaining of [0, 1, 2, 3]) for (const bRemaining of [0, 1, 2, 3]) {
    for (const firstUnits of [1, 2, 3]) for (const secondUnits of [1, 2, 3]) {
      for (const aReset of [2, 300]) for (const allowedIds of [undefined, ["a"]]) {
        for (const firstSpend of [0, 2, 3, 5]) for (const secondSpend of [2, 3, 6]) {
          const subscriptions = [sub("a", { sessionCapacity: 3, sessionRemaining: aRemaining, sessionResetAt: aReset,
            weeklyCapacity: 4, weeklyRemaining: 3, weeklyResetAt: 3 }),
          sub("b", { sessionCapacity: 3, sessionRemaining: bRemaining, weeklyCapacity: 4, weeklyRemaining: 4, weeklyResetAt: 6 })];
          const requests = [{ at: 0, units: firstUnits, spendAt: firstSpend }, { at: 2, units: secondUnits, spendAt: secondSpend, allowedIds }];
          const expected = enumerate(subscriptions, requests, 6);
          for (const planner of ["exact", "beam"]) {
            const actual = choose(subscriptions, requests, { horizon: 6, planner, beamWidth: 8 });
            assert.deepEqual(actual.plan, expected.plan, JSON.stringify({ subscriptions, requests, planner }));
            for (const [i, value] of Object.values(actual.score).entries()) assert(Math.abs(value - expected.score[i]) < 1e-8);
            assert.equal(actual.optimal, true);
          }
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 6912);
});

test("beam planner handles 100 simultaneous requests across a dozen accounts within its node bound", () => {
  const subscriptions = Array.from({ length: 12 }, (_, i) => sub(String(i).padStart(2, "0"), {
    sessionCapacity: 100, sessionRemaining: 100, sessionBuffer: 10, weeklyCapacity: 1000, weeklyRemaining: 1000 }));
  const requests = Array.from({ length: 100 }, () => ({ at: 0, units: 10, spendAt: 60 }));
  const result = choose(subscriptions, requests, { planner: "beam", beamWidth: 4 });
  assert.equal(result.selectedId, "00");
  assert.equal(result.plan.length, 100);
  assert.equal(result.score.blockedRequests, 0);
  assert.equal(result.optimal, false);
  assert(result.exploredStates <= subscriptions.length * requests.length * 4 * subscriptions.length);
  const counts = subscriptions.map(({ id }) => result.plan.filter((selected) => selected === id).length);
  assert.equal(Math.max(...counts), 9);
  assert.equal(Math.min(...counts), 8);
});

test("beam pruning is deterministic under reordered subscriptions", () => {
  const subscriptions = [sub("a"), sub("b"), sub("c")];
  const requests = [{ at: 0, units: 3, spendAt: 4 }, { at: 1, units: 3 }, { at: 2, units: 3 }, { at: 3, units: 3 }];
  const input = { planner: "beam", beamWidth: 1 };
  assert.deepEqual(choose(subscriptions, requests, input), choose(subscriptions.toReversed(), requests, input));
});

test("beam also holds requests that cannot fit rather than exceeding quota", () => {
  const result = choose([sub("a")], [{ at: 0, units: 11 }, { at: 1, units: 11 }], { planner: "beam" });
  assert.equal(result.selectedId, null);
  assert.equal(result.retryAt, null);
  assert.deepEqual(result.plan, [null, null]);
});

for (const [name, request, options] of [
  ["spend before admission", { at: 0, units: 1, spendAt: -1 }, {}],
  ["fractional spend time", { at: 0, units: 1, spendAt: 0.5 }, {}],
  ["unbounded spend time", { at: 0, units: 1, spendAt: 10081 }, {}],
  ["unknown planner", { at: 0, units: 1 }, { planner: "random" }],
  ["zero beam width", { at: 0, units: 1 }, { beamWidth: 0 }],
  ["excessive beam width", { at: 0, units: 1 }, { beamWidth: 257 }]
]) test(`rejects ${name}`, () => assert.throws(() => choose([sub("a")], [request], options)));

test("narrow beam can lose future pinned work and reports that approximation", () => {
  const subscriptions = [sub("a", { weeklyResetAt: 60 }), sub("b", { weeklyResetAt: 80 }),
    sub("c", { sessionCapacity: 6, sessionRemaining: 6 })];
  const requests = [{ at: 0, units: 1, allowedIds: ["c"] }, { at: 1, units: 4 },
    { at: 2, units: 10, allowedIds: ["a"] }, { at: 3, units: 10, allowedIds: ["b"] }];
  const exact = choose(subscriptions, requests);
  const narrow = choose(subscriptions, requests, { planner: "beam", beamWidth: 1 });
  assert.deepEqual(exact.plan, ["c", "c", "a", "b"]);
  assert.equal(exact.score.blockedRequests, 0);
  assert.deepEqual(narrow.plan, ["c", "a", null, "b"]);
  assert.equal(narrow.score.blockedRequests, 1);
  assert.equal(narrow.optimal, false);
});

test("100 seeded five-request fleets match the independent oracle including delayed settlements", () => {
  let seed = 73;
  const draw = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let scenario = 0; scenario < 100; scenario++) {
    const subscriptions = ["a", "b", "c"].map((id, i) => {
      const capacity = 3 + draw(4);
      return sub(id, { sessionCapacity: capacity, sessionRemaining: draw(capacity + 1), sessionResetAt: 3 + i,
        weeklyCapacity: 10, weeklyRemaining: 3 + draw(8), weeklyResetAt: [7, 8, 10][i] });
    });
    const requests = Array.from({ length: 5 }, (_, i) => ({ at: i, units: 1 + draw(4), spendAt: i + draw(7 - i),
      ...(draw(3) === 0 ? { allowedIds: [["a", "b", "c"][draw(3)]] } : {}) }));
    const expected = enumerate(subscriptions, requests, 10);
    for (const planner of ["exact", "beam"]) {
      const actual = choose(subscriptions, requests, { horizon: 10, planner, beamWidth: 256 });
      assert.deepEqual(actual.plan, expected.plan, JSON.stringify({ scenario, planner, subscriptions, requests }));
      for (const [i, value] of Object.values(actual.score).entries()) assert(Math.abs(value - expected.score[i]) < 1e-8);
      assert.equal(actual.optimal, true);
    }
  }
});
