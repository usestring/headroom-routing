import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription } from "../src/model.mjs";

import { enumerate } from "./support/oracle.mjs";

test("independent exhaustive oracle agrees on 576 small demand and reset scenarios", () => {
  let checked = 0;
  for (const aRemaining of [0, 1, 2, 3]) for (const bRemaining of [0, 1, 2, 3]) {
    for (const firstUnits of [1, 2, 3]) for (const secondUnits of [1, 2, 3]) {
      for (const aReset of [2, 300]) for (const allowedIds of [undefined, ["a"]]) {
        const subscriptions = [
          { id: "a", sessionCapacity: 3, sessionRemaining: aRemaining, sessionResetAt: aReset,
            weeklyCapacity: 4, weeklyRemaining: 3, weeklyResetAt: 3 },
          { id: "b", sessionCapacity: 3, sessionRemaining: bRemaining, sessionResetAt: 300,
            weeklyCapacity: 4, weeklyRemaining: 4, weeklyResetAt: 6 }
        ];
        const requests = [{ at: 0, units: firstUnits }, { at: 2, units: secondUnits, allowedIds }];
        const expected = enumerate(subscriptions, requests, 6);
        const actual = selectSubscription({ subscriptions, requests, horizon: 6 });
        assert.deepEqual(actual.plan, expected.plan, JSON.stringify({ subscriptions, requests }));
        const actualScore = Object.values(actual.score);
        for (let i = 0; i < 5; i++) assert(Math.abs(actualScore[i] - expected.score[i]) < 1e-8);
        checked++;
      }
    }
  }
  assert.equal(checked, 576);
});
