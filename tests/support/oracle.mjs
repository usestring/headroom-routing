// A minute-by-minute enumerator checks the event-based planner independently on small fleets.
export function enumerate(subscriptions, requests, horizon) {
  const outcomes = [];
  function walk(state, time, index, plan, score) {
    if (index < requests.length && requests[index].at === time) {
      const request = requests[index];
      const held = (entry) => entry.holds.reduce((sum, charge) => sum + charge.units, 0);
      const fits = state.flatMap((entry, i) => entry.s - held(entry) - entry.sb - (request.useReservedCapacity ? 0 : entry.sp) >= request.units
        && entry.w - held(entry) - entry.wb - (request.useReservedCapacity ? 0 : entry.wp) >= request.units
        && (request.allowedIds == null || request.allowedIds.includes(entry.id)) ? [i] : []);
      for (const i of fits) {
        const delayed = (request.spendAt ?? request.at) > time;
        const next = state.map((entry, j) => j !== i ? entry : delayed
          ? { ...entry, holds: [...entry.holds, { at: request.spendAt, units: request.units }] }
          : { ...entry, s: entry.s - request.units, w: entry.w - request.units });
        const pressure = next.reduce((sum, entry) => sum + (entry.sc - entry.s + entry.sb + entry.holds.reduce((sum, charge) => sum + charge.units, 0)) ** 2 / entry.sc, 0);
        walk(next, time, index + 1, [...plan, state[i].id], [score[0], score[1], score[2], score[3], score[4] + pressure]);
      }
      if (!fits.length) walk(state, time, index + 1, [...plan, null], [score[0] + 1, ...score.slice(1)]);
      return;
    }
    if (time === horizon) { outcomes.push({ plan, score }); return; }
    const exposure = state.reduce((sum, entry) => sum + (entry.sc - entry.s + entry.sb + entry.holds.reduce((sum, charge) => sum + charge.units, 0)) ** 2 / entry.sc / 300, 0);
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
      for (const charge of copy.holds.filter((charge) => charge.at === time + 1)) {
        copy.s -= charge.units;
        copy.w -= charge.units;
      }
      copy.holds = copy.holds.filter((charge) => charge.at !== time + 1);
      return copy;
    });
    walk(next, time + 1, index, plan, nextScore);
  }
  const state = subscriptions.map((entry) => ({ id: entry.id, sc: entry.sessionCapacity, s: entry.sessionRemaining,
    sr: entry.sessionResetAt, wc: entry.weeklyCapacity, w: entry.weeklyRemaining, wr: entry.weeklyResetAt, holds: [],
    sb: entry.sessionBuffer ?? 0, wb: entry.weeklyBuffer ?? 0, sp: entry.sessionReserve ?? 0, wp: entry.weeklyReserve ?? 0 }));
  walk(state, 0, 0, [], [0, 0, 0, 0, 0]);
  const compare = (a, b) => {
    for (let i = 0; i < 5; i++) if (Math.abs(a.score[i] - b.score[i]) > 1e-9) return a.score[i] - b.score[i];
    return JSON.stringify(a.plan).localeCompare(JSON.stringify(b.plan));
  };
  return outcomes.sort(compare)[0];
}

