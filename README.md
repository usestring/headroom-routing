# Headroom routing

A standalone reference implementation for choosing an agent's subscription without overcommitting
its five-hour quota or wasting quota at a weekly reset. It includes a deterministic planner and a
projected-spend ledger for running and idle agents.

The module has no runtime dependencies. It is an executable theory with scenario tests, rather than
a production allocator: provider adapters, persistence, atomic transactions, and measured cost
estimates belong in the application that uses it. The exact planner is intended for small forecasts
and for evaluating cheaper routing policies.

## Run locally

Requires Node.js 22 or newer. No install is needed:

```sh
npm run build
npm test
```

The same runtime tests can run with `bun test ./tests/`. Type declarations are included; a type
smoke check is `tsc --noEmit --strict --target es2020 --module es2020 --moduleResolution node tests/type-contract.ts`.

## Import the module

From this checkout:

```js
import { selectSubscription, emptyLedger, reserveAgent } from "./src/index.mjs";

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

let ledger = emptyLedger();
const decision = selectSubscription({
  subscriptions,
  ledger,
  requests: [{ at: 0, units: 10 }]
});

if (decision.selectedId !== null) {
  ledger = reserveAgent(ledger, {
    id: "agent-1",
    subscriptionId: decision.selectedId,
    estimatedUnits: 10
  });
}
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

Among accounts that fit, the reference planner minimizes predicted unserved requests first, weekly
waste second, and five-hour concentration afterward. When weekly waste ties, it prefers quota that
expires earlier. It returns a null selection and a possible retry time when nothing fits.

`recordSpend` moves measured usage from future estimates into pending charges. `acknowledgeCharges`
removes pending debt only when the corresponding snapshot includes it. `completeAgent` releases
unused estimates after final spend is accounted for; it retains pending charges. Ongoing projected
work survives a quota reset. `reviseFutureSpend` allows estimates to change.

The caller must make selection and reservation atomic across every allocator sharing an account.
It must also apply refreshed snapshots and charge acknowledgments atomically. A reported aggregate
usage change alone does not identify which agent's spend was incorporated.

## Scope and limits

All capacities use comparable integer work units; an average agent cost is an explicit assumption.
The window model fully replenishes at observed resets and then repeats every five hours or seven
days. Sliding windows and windows activated by first use require different state transitions.
The planner assumes one work unit charges both windows equally.

A deterministic choice is not a guarantee about unknown future demand. Forecast and estimate
quality determine how useful its predictions are. Search is bounded to 50,000 states by default
and fails explicitly when the bound is exceeded.

Read [the full theory and OSS comparison](docs/theory.md) for the objective, timing semantics,
reservation reconciliation, scenario expectations, and integration requirements.

## License

MIT. Copyright (c) 2026 Relativity Labs Inc.
