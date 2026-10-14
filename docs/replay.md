# Replay evaluation

Run `npm run evaluate` from the repository root. It emits deterministic JSON for all scenario/policy
pairs. These are synthetic work-unit scenarios, not measurements of a provider or claims about
production block rates. The exact selector's existing exhaustive tests remain the idealized oracle.

The replay keeps provider capacity separate from the allocator's snapshot. Agents launch with an
estimate, can remain idle, and spend their actual cost only at completion. Reports arrive on a fixed
schedule. Locally measured charges enter the ledger immediately but remain pending until a report
includes them. Historical costs update only after successful completion. No future actual cost is
passed into the selector. Optional `expectedDuration` is a prior timing estimate supplied to
selection; actual `duration` remains separate. Missing timing retains the immediate-charge forecast.

Resets fully replenish fixed windows. The replay can advance a known reset clock between reports,
while retaining ongoing work and pending charges in the windows they still affect. Real adapters
must verify these semantics. There is no gradual refill, migration, retry queue, or cancellation
model. Every admitted agent completes or encounters a simulated limit before the scenario ends.

## Selected scenario outcomes

| Scenario | Snapshot-only policy | Reservations with mean estimate | Reservations with tail estimate |
| --- | --- | --- | --- |
| 100 idle launches; 50 units left; 10-unit buffer; each costs 10 | Earliest expiry admits 100; 95 session blocks. | Four admissions, four completions, zero blocks. | Four admissions, four completions, zero blocks. |
| History `[10,10,10,10,20]`; four jobs actually cost 20; same capacity/buffer | Earliest expiry admits four; two session blocks. | Estimate 12 admits three; two complete and one blocks. | Estimate 20 admits two; both complete and neither blocks. |
| 40 units expire in one hour; another account has more five-hour headroom | Headroom-only policy leaves the 40 units unused. | Uses the expiring account; zero units lost at that reset. | Uses the expiring account; zero units lost at that reset. |
| 60 launches over 20 hours; three accounts with staggered resets | Earliest expiry completes 49 with 11 session blocks; headroom-only completes all 60. | All 60 complete with zero blocks. | All 60 complete with zero blocks. |
| Cost-tail history but all four new jobs cost only 10; weekly quota expires at the horizon | Earliest expiry completes four; 10 weekly units expire unused. | Three complete; 20 weekly units expire unused. | Two complete; 30 weekly units expire unused. |

The first scenario reproduces overcommitment from an unchanged reading. The cost-tail scenario
shows why an average alone can still fail even after reservations are added. The tail estimate
does not reduce completed jobs in that particular scenario; that result is not universal.

Two negative controls bound the claims. A 60-unit job cannot fit the available 50 units when its
history suggested 10. Likewise, 30 units of previously unseen external usage can consume more
than a 10-unit buffer protects. The replay includes these failures rather than giving the allocator
information that an online router would not have had.

The tests also sweep 90 combinations of report intervals, job costs, burst sizes, and reset times.
No simulated block occurs when each actual cost is covered by its reservation and all usage is
tracked. They assert the selected accounts for the decisive cases and verify deterministic replay.

## Policy and integration boundaries

Higher cost quantiles deliberately trade unused capacity and waiting against failed launches.
The nearest-rank percentile is an empirical estimate, not a confidence bound. Rare outliers,
distribution changes, and samples from the wrong job class can invalidate it. Calibrate this
tradeoff from observed launch histories before using it to allocate real subscriptions.

`allocateAgent` combines selection and reservation; it does not own a distributed lock. Persist its
state with an atomic comparison against the revision read. Only start a process after that commit
succeeds. An `already_reserved` response means a retry must not launch another process. Retain launch
tombstones and pending-charge identities for the application's retry horizon.

`applyUsageSnapshot` combines the report and acknowledgments; it does not infer charge attribution.
Its observation times use the model's integer-minute timeline and must strictly advance for newly
incorporated spend. A provider integration with finer observation timing requires a separately
validated time/observation adapter. Keep the entire account pool represented while its ledger
retains account reservations. Ledger spend/completion transitions must also advance the storage
revision in the same transaction.

Two further scenarios test idle agents across resets. When an agent is expected to spend after an
early weekly reset, reservations select the account with more session room: 190 weekly units
expire unused, compared with 200 for earliest-expiry selection. With two 10-unit idle commitments
across a reset of a 20-unit session quota, the ledger holds a third launch; both admitted agents
complete. Snapshot-only selection admits the third and produces one session block.

The default exact planner is exponential in forecast size. An optional bounded beam planner uses
the same capacity rules, reports whether pruning occurred, and is compared with the independent
oracle on small cases. Replay currently uses the default exact planner for each individual launch.
Neither mode establishes real forecast accuracy or provides a live production integration.
