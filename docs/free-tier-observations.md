# Free-tier observations

A free model can provide useful capacity even when its provider exposes no numerical quota.
Treat a completed free request as an availability observation. It does not establish remaining
percentage, a reset timestamp, or the number of future requests that will fit.

## Assess availability without fabricating headroom

Both APIs assess one caller-defined allowance scope. Group observations consistently; one
conversation does not prove that the provider enforces a conversation-specific quota. Classify
the actual completed provider/model after any fallback. A requested free model followed by a
paid response is `paid_success`, not `free_success`. Operational failures are `error`.

This synthetic example has a refusal at the start, a paid fallback 20 minutes later, and a
verified free success after 180 minutes:

```js
import { assessFreeTier } from "@usestring/headroom-routing";

const standing = assessFreeTier({
  nowMs: 180 * 60_000,
  observations: [
    { atMs: 0, outcome: "free_limit" },
    { atMs: 20 * 60_000, outcome: "paid_success" },
    { atMs: 180 * 60_000, outcome: "free_success" }
  ]
});
```

The recovery interval is 180 minutes wide. Paid fallback did not establish free recovery.
An intended check schedule cannot narrow the interval when checks were missed or the host slept.
The result does not distinguish a five-hour limit, a daily limit, independent overlapping limits,
or another reset rule. More elapsed idle time cannot narrow a historical observation gap.

The JavaScript API uses integer milliseconds on one clock, with `maxAgeMs` defaulting to two
minutes. Go callers use `headroom.AssessFreeTier(observations, now)` with `FreeTierObservation`
values and the same two-minute freshness policy. Inputs are not mutated. Future timestamps,
unknown outcomes and conflicting observations at the same time are rejected: JavaScript throws;
Go returns reason `invalid`.

`availability` describes the latest relevant observation; always inspect freshness before calling
it current. Paid successes do not refresh free availability. A later error makes availability
unknown, while a new free-limit refusal starts a new unresolved recovery cycle. The interval
ends at the first free success after the latest refusal, even if more successes follow.

Both APIs leave numerical headroom and reset time unknown and return `usable: false`.
They do not construct a five-hour/weekly subscription for the planner or authorize scored routing.
Provider adapters, probing and persistence remain the consuming application's responsibility.

## Calibrating an allowance

Record actual completion timestamps, the billed provider/model and cumulative metered usage.
Include compaction and other metered calls across driver restarts; current context length and
conversation-turn counts alone can omit consumption. Keep paid fallback separate. An operational
failure is not evidence that a quota was exhausted.

A run that did not start at a known reset measures consumption through refusal, not a fresh-window
capacity. Cached, uncached, output and reasoning tokens may have different quota weights. Control
or account for other consumers before treating one conversation's usage as the whole allowance.
Further controlled cycles are needed before assigning a fixed capacity, reset period or scope.
