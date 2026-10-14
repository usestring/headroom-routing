import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSubscription } from "../src/model.mjs";

// A minute-by-minute enumerator checks the event-based planner independently on small fleets.
function enumerate(subscriptions, requests, horizon) {
  const outcomes = [];
  function walk(state, time, index, plan, score) {
    if (index < requests.length && requests[index].at === time) {
      const request = requests[index];
      const fits = state.flatMap((entry, i) => entry.s >= request.units && entry.w >= request.units
        && (request.allowedIds == null || request.allowedIds.includes(entry.id)) ? [i] : []);
      for (const i of fits) {
        const next = state.map((entry, j) => j === i ? { ...entry, s: entry.s - request.units, w: entry.w - request.units } : entry);
        const pressure = next.reduce((sum, entry) => sum + (entry.sc - entry.s) ** 2 / entry.sc, 0);
        walk(next, time, index + 1, [...plan, state[i].id], [score[0], score[1], score[2], score[3], score[4] + pressure]);
      }
      if (!fits.length) walk(state, time, index + 1, [...plan, null], [score[0] + 1, ...score.slice(1)]);
      return;
    }
    if (time === horizon) { outcomes.push({ plan, score }); return; }
    const exposure = state.reduce((sum, entry) => sum + (entry.sc - entry.s) ** 2 / entry.sc / 300, 0);
    const nextScore = [...score];
    nextScore[3] += exposure;
    const next = state.map((entry) => {
      const copy = { ...entry };
      if (copy.sr === time + 1) { copy.s = copy.sc; copy.sr += 300; }
      if (copy.wr === time + 1) {
        nextScore[1] += copy.w;
        nextScore[2] += copy.w * (horizon - copy.wr + 1);
        copy.w = copy.wc;
        copy.wr += 10080;
      }
      return copy;
    });
    walk(next, time + 1, index, plan, nextScore);
  }
  const state = subscriptions.map((entry) => ({ id: entry.id, sc: entry.sessionCapacity, s: entry.sessionRemaining,
    sr: entry.sessionResetAt, wc: entry.weeklyCapacity, w: entry.weeklyRemaining, wr: entry.weeklyResetAt }));
  walk(state, 0, 0, [], [0, 0, 0, 0, 0]);
  const compare = (a, b) => {
    for (let i = 0; i < 5; i++) if (Math.abs(a.score[i] - b.score[i]) > 1e-9) return a.score[i] - b.score[i];
    return JSON.stringify(a.plan).localeCompare(JSON.stringify(b.plan));
  };
  return outcomes.sort(compare)[0];
}

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
