# Subscription headroom routing: executable theory

This dependency-free reference model chooses one subscription for an agent launch. It is an
offline specification and test oracle; no production selector imports it. Run from the repository
root:

```sh
bun test ./tests/
npm test
```

## What existing OSS provides

Public sources inspected on 2026-10-14:

| Source | Relevant behavior | Gap for this model |
| --- | --- | --- |
| [TeamClaude](https://github.com/KarpelesLab/teamclaude), [quota documentation](https://github.com/KarpelesLab/teamclaude/blob/master/docs/quota.md) | Pools subscriptions, rotates near five-hour or weekly limits, prefers earlier weekly resets, tracks model-specific limits, optionally waits on exhaustion. | The inspected documentation does not establish joint optimization of future request fit, expiry waste, and projected spend from idle agents. |
| [Bucket4j](https://github.com/bucket4j/bucket4j) | Token-bucket admission primitives and multiple bandwidth limits. | Enforces limits; does not choose among expiring subscriptions for this objective. |
| [redis-cell](https://github.com/brandur/redis-cell) | GCRA rate limiting and retry/reset timing. | Useful pacing machinery; does not optimize weekly expiry across accounts. Its README also states best-effort maintenance. |

These are useful precedents. This search did not find a ready-made algorithm with the combined
objective below. That is a bounded finding, not proof that no such project exists. Earliest-deadline
scheduling alone does not cover this problem: quotas are opportunities to spend, requests are
indivisible, and the short window can prevent use of the long one.

## Inputs and assumptions

All capacity is expressed in integer **comparable work units**. For an initial experiment, one
average agent might cost 10 units. This is an assumption, not a provider token conversion. A
production adapter must calibrate model and plan differences: 50% on two different subscriptions
does not imply equal capacity. This model assumes the same unit of work charges both applicable
windows by the same amount. Window-specific or subscription-specific conversion costs require
an expanded state and matching tests before using the model for those plans.

Each subscription supplies `sessionCapacity`, `sessionRemaining`, `sessionResetAt`,
`weeklyCapacity`, `weeklyRemaining`, and `weeklyResetAt`, plus optional `sessionBuffer`,
`weeklyBuffer`, `availableAt`, and `enabled`. Reset times and request times are integer minutes.
`now` defaults to zero. Unknown quota fields and reset times in the past are rejected. The caller
must supply fresh observations; this model does not verify a snapshot's observation age.
A next reset exactly at `now` is applied before admission.

The window model is a full replenishment at an observed reset, followed by fixed 300-minute and
10,080-minute periods. It does not assume gradual refill. A genuinely sliding window needs a
timestamped spend history; a window anchored by first use needs an activation transition. A single
reported percentage/reset pair cannot resolve either behavior. Verify the provider's semantics
before integrating. Request cost is reserved in full at admission. The forecast charges it then
unless an expected `spendAt` is supplied; a mid-agent reset never rescues a request that cannot fit
when it launches.

`requests[0]` is the launch being decided, at `now`. Later entries are a caller-supplied deterministic
forecast, with `{at, units, spendAt?, allowedIds?}`. Compatibility belongs in `allowedIds`; include every
binding model-specific weekly limit when adapting real provider data. The horizon covers every
current weekly reset and is at most one week. Requests at the horizon are outside the forecast.
The default horizon is the latest current weekly reset, or one minute after now if all just reset.

## Projected spend and admission

Maintain an agent ledger alongside the provider snapshot:

```text
projected spend for a window = remaining expected agent work
                            + actual work not yet included in that window's report

admissible headroom = reported remaining - projected spend - safety buffer
```

The launch fits only if its estimated cost is no greater than admissible headroom in **both**
windows. A known outage or incompatible model also excludes the subscription. Equality at the
buffered boundary is allowed; the buffer remains untouched. Negative projected headroom is kept
visible as oversubscription, rather than clamped into a misleading zero reading.

For example: a five-hour capacity of 100, a snapshot showing 50 remaining, a buffer of 10, and an
average launch cost of 10 admits four idle agents. Their reservations consume the 40 allocatable
units immediately. The fifth launch waits even if the provider still reports 50 remaining.

The buffer is a configuration input, not a tuned recommendation. A starting hypothesis is 10% of
five-hour capacity and zero weekly buffer. Average cost plus a buffer reduces risk; it cannot
guarantee safety against arbitrarily expensive agents. Later, estimate the remaining cost by job
class, or choose a cost quantile and an explicit acceptable block probability. Include untracked
external sessions and reporting lag when sizing the buffer.

`src/reservations.mjs` models the ledger with immutable transitions:

1. `reserveAgent`: reserve the full estimate before launching, including for idle agents. Retries
   with the same id are idempotent; conflicting retries fail.
2. `recordSpend`: move locally measured cost from future work into pending charges tagged with
   their session and weekly reset identities. Spend above the estimate increases pending debt.
3. `acknowledgeCharges`: remove a pending charge from the projected tally only when the matching
   window's snapshot is known to include it. Session and weekly reports can acknowledge separately.
4. `completeAgent`: release unspent future work after the process has stopped and final local
   charges are accounted for. Already-spent, unreported work remains reserved. A proved launch
   failure before any spend can complete with no charges.
5. `reviseFutureSpend`: change the remaining estimate as better evidence arrives.

Completion without known final spend is **not** evidence for releasing the reservation. No expiry
timer silently clears idle agents. Pending charges from an expired window no longer bind the new
window; remaining future work still does. Tombstones preserve retry idempotence.

Acknowledgment is an explicit attribution contract. Do not infer it from an arbitrary fall in an
aggregate usage percentage: another agent or external consumer may have caused that change.
If inclusion cannot be established, retain pending debt conservatively. A production integration
must reconcile the new snapshot and acknowledgments in the same atomic update and reject older
snapshots. The pure ledger helpers do not provide persistence or that transaction.

**Selection and reservation must also be atomic across the entire subscription pool.** In one
transaction or locked critical section, read the snapshot and ledger, select, then write the launch
reservation. Two allocators reading the same 40 units otherwise still overcommit. Start the agent
after that reservation commits; retain or reconcile the reservation after an uncertain launch
failure. A shared ledger is required when multiple services use the same subscription.

## Decision criterion

For each feasible subscription, simulate routing the remaining forecast and minimize this tuple
in order:

```text
(unserved request count,
 total weekly work units expired unused,
 expiry-weighted unused units,
 five-hour pressure integrated over time,
 pressure across successive admissions)
```

This is a lexicographic objective: one predicted unserved request is worse than any amount of
weekly waste. It avoids an arbitrary exchange rate between a blocked agent and tokens. If all
choices cause some unserved requests, choose the smallest count, then the lowest waste. Requests
have equal priority; minimizing blocked work units or weighting important jobs is a different
policy. The model always serves a request when one account fits. It never intentionally refuses
a small feasible request to save capacity for several future requests.

At a weekly reset, remaining unused units contribute to total waste. Buffers and frozen future
reservations count as unused rather than being mistaken for completed work. Known pending actual
charges count as spent. When total waste ties, an unused unit expiring at minute `r` contributes
`horizon - r + 1` to expiry-weighted waste. This favors spending earlier-expiring quota without
sacrificing lower total waste or request completion.

For five-hour pressure, let `C_i` be nominal session capacity and `u_i` be its committed fraction,
including projected spend and buffer. The instantaneous pressure is:

```text
P = sum_i C_i * u_i^2
time exposure = integral P(t) dt / 300
admission pressure = sum over accepted launches of P immediately after admission
```

Squaring penalizes concentration; weighting by capacity favors proportional use of unequal plans.
Time exposure also makes consuming an account just before its session reset cheaper than consuming
one whose reset is far away. Admission pressure spreads simultaneous launches even when they have
identical final utilization. The last tie is stable subscription id order, independent of input
order. Only the two floating pressure terms use a `1e-9` comparison tolerance.

The ledger's current future reservations are conservatively frozen through the forecast. They
remain committed after resets until the caller supplies completion or revised estimates. This
can overestimate future contention. The forecast's new launches are charged in full at their
arrival by default. With `spendAt`, their unspent commitments survive resets until settlement.
They are not charged twice through the ledger.

## How the reference implementation computes a choice

`src/model.mjs` uses memoized dynamic programming. A state contains remaining capacity, unspent forecast commitments, and next reset
times for every subscription. At each forecast arrival it applies all intervening resets and settlements, tries
every compatible account with capacity, and keeps the best suffix under the tuple. If none fits,
it records an unserved request and proceeds without overdrawing any account. It also integrates
pressure between events and accounts for weekly expiry through the horizon.

The return value includes `selectedId`, the forecast `plan`, the winning `score`, scores for each
feasible current candidate, projected headroom, and the explored state count. With no feasible
account, `selectedId` is null and `retryAt` is the first time the request could fit after known
resets/outages under the frozen ledger. Null retry time means resets alone cannot make it fit.
Returning wait prevents an upstream limit failure; the score counts inability to serve at the
forecast arrival, not an actual dispatched 429. Queuing and delayed execution are outside this model.

This is exact for the declared objective and work-conserving forecasts within the numeric
comparison tolerance. Search is exponential in the worst case, bounded by `maxStates` (50,000 by
default) and 100 requests. Exceeding the bound fails explicitly. Use it as a small-case oracle,
then assess a bounded planner or heuristic against it before connecting real routing.

## Expected behavior

| Situation | Expected selection |
| --- | --- |
| Weekly quota expires soon; both accounts can serve future work | Spend earlier-expiring quota. |
| Earlier-expiring account has insufficient projected session headroom | Choose an account that fits. |
| Small current request would consume the only account able to fit an upcoming large request | Put the small request on another account. |
| Equal expiry and completion outcomes | Spread five-hour commitment, accounting for capacity and reset time. |
| Five-hour capacity renews soon | Its current headroom can be spent more aggressively if the request fits now. |
| All accounts lack room | Wait; report earliest feasible time rather than deliberately exceeding a limit. |
| Plenty of weekly quota but no session renewal before weekly expiry | Report unavoidable weekly waste; never force an unsafe launch to burn it. |
| Many launches share an unchanged provider snapshot | Every reservation reduces the next launch's admissible headroom. |

The tests exercise these selections, boundaries, compatibility, outage/reset timing, unequal plans,
insufficient aggregate capacity, indivisible requests, forecast dependence, buffers, reservations,
and reconciliation. An independent minute-by-minute exhaustive enumerator checks the event-based
planner on 576 small demand/reset scenarios. That grid checks both the selected plan and its score.

## What determinism can and cannot guarantee

The routing decision is deterministic given the same snapshot, ledger, forecast, buffers, and
eligible accounts. Future workload and actual agent cost are not thereby known. With two identical
accounts, a future request pinned to whichever account we chose can make the current choice wrong;
the same snapshot could instead be followed by a request pinned to the other account. No snapshot-only
rule can be optimal in both futures.

The safe admission/reservation rule is useful without a forecast. With only the current request,
the optimizer favors earlier weekly expiry and then spreads session pressure. Strong claims about
future block avoidance require a calibrated forecast and cost estimates. Replay real launch
histories with their information available at the time, measure unused weekly units and actual
limit incidents, and compare against earliest-expiry and headroom-only baselines before rollout.
Perfect-forecast tests establish the theoretical choices; they do not establish real-world forecast
accuracy or tune the buffer.

## Expected spend timing

A request can supply `spendAt`, an integer minute at or after admission and within one week of
`now`. The entire cost still has to fit both windows immediately. In the forecast, it stays held
until that time and is charged as one lump then. Resets replenish capacity while carrying unspent
commitments into the new window. Settlement replaces a hold with actual spend; it does not create
extra headroom. At a shared timestamp, resets happen before settlement, then arrivals in supplied
order. Spend at the weekly reset belongs to the renewed window.

Only projected spend before a weekly reset reduces that window's predicted waste. A reservation
for an idle agent that will spend after the reset cannot count as finishing the old quota. For
example, with an early weekly reset in 10 minutes and expected spend in 20 minutes, an account with
more session headroom can win because neither account can burn the early quota with that job.

Omitting `spendAt` preserves the immediate-charge forecast. Supply timing estimates for jobs that
can remain idle across resets. This is a single-lump timing model; distributed spend across an
agent's lifetime requires a spend schedule rather than claiming this estimate describes every
provider charge. A timestamp after the evaluation horizon is allowed and leaves the commitment
unspent in that forecast.

Timing is a forecast input. The actual ledger never releases a reservation when an expected time
passes; only measured spend, revised estimates, and verified completion change real debt.
`allocateAgent` accepts `spendAt` for selection and still reserves the full cost before launch.
Existing ledger future work remains frozen in the forecast because its settlement time is unknown.

The independent minute-by-minute oracle keeps provider remaining units separate from unpaid
commitments. In addition to the original 576 cases, 6,912 timing/reset combinations and 100 seeded
five-request fleets check both selected plans and all score components. Boundary scenarios cover
settlement before, at, and after resets; out-of-order settlement; simultaneous window resets; and
commitments beyond the horizon.
