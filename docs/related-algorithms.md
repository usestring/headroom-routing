# Related resource-allocation algorithms

Subscription headroom routing has close precedents in inventory theory. The useful framing is
allocation of expiring capacity with replenishment at known times and multiple demand classes. The
reserve option is a critical-level admission policy. The memoized forecast search is dynamic
programming over that policy's feasible choices, and the Go score is an expiry-urgency heuristic.
Neither the problem family nor these techniques should be described as unprecedented.

Sources below were inspected on 2026-10-28. This is a comparison of assumptions and behavior, not
a claim to have exhaustively searched the literature or proved equivalence to a published optimum.

| Precedent | Shared decision | Difference from this implementation |
| --- | --- | --- |
| Critical-level inventory rationing | Refuse ordinary demand below a stock threshold to conserve it for more important demand before replenishment. | The library accepts thresholds from the caller; it does not derive optimal levels from demand distributions and shortage costs. |
| Airline revenue management: protection levels and booking limits | Preserve finite capacity for more valuable demand while avoiding unused capacity at a deadline. | This planner minimizes blocked-request count before weekly waste, rather than expected revenue. Each job also consumes two quota windows. |
| First-expiry allocation | Use capacity nearer expiry to reduce waste. | Always choosing earliest expiry can strand later indivisible or account-restricted jobs; the planner examines future feasibility. |
| Token buckets and rate limiting | Admit work only when the applicable capacity constraints permit it. | A standard rate bucket replenishes incrementally; this model replenishes fully at resets and also chooses among accounts. |

## The closest precedent: critical-level inventory rationing

Donald M. Topkis's 1968 paper, *Optimal Ordering and Rationing Policies in a Nonstationary Dynamic
Inventory Model with n Demand Classes*, explicitly asks whether to satisfy a demand or conserve
stock for a more important class between successive procurements. Under its stated conditions,
the optimal policy uses class- and time-dependent critical rationing levels.

Source: [Management Science, DOI 10.1287/mnsc.15.3.160](https://doi.org/10.1287/mnsc.15.3.160);
the [bibliographic record and abstract](https://cir.nii.ac.jp/crid/1363670318378118272) describe the
critical-level policy directly.

Map inventory to remaining quota, procurement to reset, demand to job cost, and priority classes
to ordinary/sensitive services. The implemented ordinary admission condition for each window is:

```text
remaining - outstanding commitments - safety buffer - job cost >= protected floor
```

Sensitive work uses a zero protected floor while retaining the safety buffer. Both classes debit
the same stock. This is the two-class protection mechanism; the library does not inherit the
paper's optimality theorem, stochastic-demand assumptions, or optimal procurement decisions.

A physical stockpile often carries unused stock into the next delivery. Subscription quota in this
model expires and is replaced at reset. A nonperishable stockpile shares the depletion and priority
problem, but perishable inventory is closer to the use-it-or-lose-it part.

## Expiring capacity: Littlewood's rule and revenue management

Littlewood's 1972 rule protects seats for higher-fare demand instead of selling every seat to the
first lower-fare request. In the basic two-class model, with continuous high-value demand
distribution `F_H` and values `v_H > v_L > 0`, its protection level is:

```text
y = inverseCDF(F_H, 1 - v_L / v_H)
```

This provides a principled way to size a reserve when demand and relative values are available.
It is not a universal quota formula: the model's assumptions about demand order, fares, and capacity
must hold. A service requiring a hard availability target may instead choose a quantile of its
anticipated sensitive demand before reset. That requires a calibrated demand forecast, which this
library does not supply. The agent-cost quantile already in the library estimates one job's cost;
it is not a forecast of total sensitive demand before replenishment.

Sources: [Littlewood's rule and its formula](https://en.wikipedia.org/wiki/Littlewood%27s_rule),
[Netessine and Shumsky's yield-management tutorial (2002)](https://doi.org/10.1287/ited.3.1.34),
and [Takagi's multi-period extension](https://doi.org/10.3934/jimo.2020064), whose abstract describes
optimal protection levels for multiple periods of a single perishable resource.

## Expiry weighting and rate limiting

The simple first-expiry rule is a useful baseline, but the Go formula
`headroom / hoursUntilReset^2` also weighs the amount left. Squaring time is this package's heuristic
choice; these sources do not establish it as an optimal inventory or revenue-management rule.
`headroom / hoursUntilReset` would instead describe the average spend rate required to use that
headroom before reset. Neither formula alone models demand uncertainty, job compatibility, or
shared reservations. The exact JavaScript planner optimizes its stated finite forecast objective;
that does not prove the Go score optimal for unknown future demand.

[RFC 2697](https://www.rfc-editor.org/rfc/rfc2697.html) specifies token-bucket metering with a
committed information rate and burst capacities. Such machinery is useful for admission and pacing,
but full renewal at reset is a different transition from incremental refill. Multiple applicable
quota windows must all permit admission; choosing the account with the most tokens alone does not
resolve expiry waste or future job fit. Existing OSS comparisons are in [the theory](theory.md).

## What the reserve option establishes

The implementation adds caller-selected protection levels while retaining the existing accounting
and optimization objective. Defaults remain unchanged. A reserve can protect important demand
without knowing exactly when it will arrive, at the cost of potentially holding ordinary work and
wasting protected units. The next empirical question is reserve sizing: replay measured demand
with fixed floors and demand-based floors, then compare sensitive blocks, ordinary holds, and
unused quota. No reserve size or inverse-square score is calibrated by this literature comparison.
