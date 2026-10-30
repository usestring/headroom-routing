# Headroom routing

A standalone reference implementation for choosing an agent's subscription without overcommitting
its five-hour quota or wasting quota at a weekly reset. It includes a deterministic planner and a
projected-spend ledger for running and idle agents.

The module has no runtime dependencies. It is an executable theory with scenario tests, rather than
a production allocator: provider adapters, persistence, atomic transactions, and measured cost
estimates belong in the application that uses it. The exact planner is intended for small forecasts
and for evaluating cheaper routing policies. An optional beam planner provides bounded forecast
search and explicitly reports when its result is approximate.

## Run locally

Requires Node.js 22 or newer. No install is needed:

```sh
npm run build
npm test
npm run evaluate
```

The same runtime tests can run with `bun test ./tests/`. Type declarations are included; a type
smoke check is `tsc --noEmit --strict --target es2020 --module es2020 --moduleResolution node tests/type-contract.ts`.

## Import the module

From this checkout:

```js
import { createRoutingState, allocateAgent, estimateAgentUnits } from "./src/index.mjs";

const subscriptions = [{
  id: "account-a",
  sessionCapacity: 100,
  sessionRemaining: 50,
  sessionResetAt: 300,
  sessionBuffer: 10,
  weeklyCapacity: 1000,
  weeklyRemaining: 500,
  weeklyResetAt: 10080
}];

const state = createRoutingState({ subscriptions });
const estimate = estimateAgentUnits([10, 10, 10, 10, 20]);
const allocation = allocateAgent(state, {
  id: "agent-1",
  at: 0,
  estimatedUnits: estimate.units,
  spendAt: 60,
  expectedRevision: state.revision
});
// Commit allocation.state using a transaction or compare-and-swap before launching.
```

The package already declares an ESM export and TypeScript types under the working name
`@usestring/headroom-routing`. It is marked `private: true`, version `0.0.0`, and is not published
to npm. The API and its assumptions should be evaluated before a public package release. There is
no release or publish workflow.

## Allocation rule

```text
admissible headroom = reported remaining
                   - projected unreported agent spend
                   - safety buffer
```

A launch reserves its entire estimated cost immediately, even if the agent stays idle. It must fit
within both the session and weekly windows. For 50 units remaining, a 10-unit buffer, and a 10-unit
agent estimate, four agents may launch against an unchanged provider snapshot.

Optional `spendAt` describes when a forecast job is expected to spend its cost. Its full reservation
survives intervening resets, and only spend before weekly expiry counts toward using that quota.
Omitting it retains the immediate-charge forecast. Expected times never release actual ledger debt.

Optional `expiresAt` is a fixed subscription expiration, in the same integer-minute time scale as
the reset timestamps. Remaining quota is lost at that deadline and never replenished afterward.
For example, `expiresAt: 60` prevents admissions and expected spend at minute 60 or later, even if
a quota reset falls at the same time. Resets before expiration still replenish normally. Unused
quota at expiration contributes to `expiredWeeklyUnits` and the earlier-expiry preference. Omit
`expiresAt` for a subscription that continues renewing. The horizon must cover each account's next
weekly reset or fixed expiration, whichever comes first.

Among accounts that fit, the reference planner minimizes predicted unserved requests first, weekly
waste second, and five-hour concentration afterward. When weekly waste ties, it prefers quota that
expires earlier. It returns a null selection and a possible retry time when nothing fits.

`recordSpend` moves measured usage from future estimates into pending charges. `acknowledgeCharges`
removes pending debt only when the corresponding snapshot includes it. `completeAgent` releases
unused estimates after final spend is accounted for; it retains pending charges. Ongoing projected
work survives a quota reset. `reviseFutureSpend` allows estimates to change.

`allocateAgent` returns the decision and reservation in one immutable state transition. Retrying an
accepted agent id returns `already_reserved`; a waiting id can retry after capacity becomes available.
An outdated `expectedRevision` is rejected when the function receives the current state. The caller
must commit the returned state with a transaction or compare-and-swap in shared storage **before**
launching. These helpers cannot prevent two processes from both committing states derived from
the same old revision. Retries must not start a second agent.

`applyUsageSnapshot` updates remaining capacity and explicitly acknowledged charges together. It
rejects older observations, conflicting readings at the same time, and acknowledgments of newly
spent work against a reused observation. A reported aggregate usage change alone does not identify
which agent's spend was incorporated. Attribution must come from the application's accounting.

## Agent-cost uncertainty

`estimateAgentUnits` uses completed-agent costs known at allocation time. With no history it uses an
explicit assumption, 10 units by default. During cold start it retains the larger of that assumption
and the observed maximum. After five samples it uses the nearest-rank 90th percentile over the last
50 samples, or an explicitly selected rounded-up mean. These defaults are hypotheses, not calibrated
safety recommendations. Keep histories separate for different models and job classes.

The estimate and session buffer cover different uncertainties. An estimate reserves for a plausible
agent cost; the buffer leaves pool capacity for cost errors, reporting lag, and untracked work.
Neither guarantees against arbitrarily expensive agents or unseen external usage. Higher estimates
can avoid failed launches while also holding work unnecessarily when jobs are cheaper than expected.

## Deterministic replay

`npm run evaluate` prints JSON comparisons against snapshot-only earliest-expiry and headroom
policies. Nine synthetic scenarios cover idle bursts, expensive cost tails, weekly expiry, sustained
demand through staggered resets, unseen cost outliers, external usage, overreservation, and idle work crossing weekly and session resets. Both baseline policies
respect the same buffers; their omitted reservation tally isolates delayed-accounting effects.

The allocator sees only snapshots and completed cost history available at each launch. Actual costs
are charged later in a separate simulated provider state. Held launches and upstream quota blocks
are reported separately. A held launch is attempted once; replay does not model a retry queue.
Observed results and limitations are in [the replay notes](docs/replay.md).

## Go headroom score

The `headroom` Go package (`github.com/usestring/headroom-routing/headroom`) is a smaller,
stateless rule for ranking accounts from one provider reading each. It works on utilization
percentages, keeps no reservation ledger, and plans no forecast.

```go
now := time.Now()
current := headroom.Assess(currentUsage, now)
st := headroom.Assess(headroom.Usage{ObservedAt: readAt, Windows: windows}, now)
if st.Usable && headroom.WorthSwitching(current.Score, st.Score) {
	// move the session to this account
}
```

What leaving an account loses is weekly quota that resets before it is spent, so each account
scores its weekly headroom weighted by how soon that headroom expires:

```text
ceiling  = 95 - 10 × (time to reset ÷ period)        85 just after a reset, 95 just before
headroom = ceiling - utilization                      percentage points
score    = headroom ÷ (hours to the weekly reset)²    hours floored at 15 minutes
```

Squaring the hours lets the quota closest to being lost win: 40 points left two hours from a reset
scores 10, while 80 points left three days out scores about 0.015. Every window must be under its
ceiling for an account to be usable, but only weekly windows score; the five-hour window refills
all day, so it can shut an account but never ranks one. With several weekly windows the lowest
score counts. A reading older than two minutes, missing the `five_hour` or `seven_day` window, or
with an unknown utilization is not usable, and `Standing.Reason` says why. A running session moves
only to an account scoring at least 1.5 times higher (`WorthSwitching`), since a move costs a
restart and the prompt cache.

Run its tests with `go test ./...`.

For a subscription with a fixed end, set `Usage.ExpiresAt`. The scorer uses the earlier of that
deadline and each window's reset for urgency and reserve tapering. `Standing.ResetsAt` reports
that effective deadline. At or after expiration the account is unusable with reason `"expired"`;
a zero `ExpiresAt` retains recurring-window behavior.

## Scope and limits

All capacities use comparable integer work units; an average agent cost is an explicit assumption.
The window model fully replenishes at observed resets and then repeats every five hours or seven
days. Sliding windows and windows activated by first use require different state transitions.
The planner assumes one work unit charges both windows equally.

A deterministic choice is not a guarantee about unknown future demand. Forecast and estimate
quality determine how useful its predictions are. The default exact search is bounded to 50,000 states
and fails explicitly when the bound is exceeded. For larger forecasts, choose `planner: "beam"`
and `beamWidth` (1..256, default 32). It evaluates every current candidate while pruning suffix
states to that width. Results include `planner` and `optimal`; any beam pruning reports
`optimal: false`. Bounded search can miss future request fits and is tested with an explicit
counterexample. Both modes require every admitted estimate to fit both buffered quota windows.

Read [the full theory and OSS comparison](docs/theory.md) for the objective, timing semantics,
reservation reconciliation, scenario expectations, and integration requirements.

## License

MIT. Copyright (c) 2026 Relativity Labs Inc.
