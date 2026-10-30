import { selectSubscription, emptyLedger, reserveAgent, acknowledgeCharges, Subscription, Selection } from "../src/index";
import { estimateAgentUnits, createRoutingState, allocateAgent, applyUsageSnapshot } from "../src/index";

const subscription: Subscription = {
  id: "a", sessionCapacity: 100, sessionRemaining: 50, sessionResetAt: 300,
  weeklyCapacity: 1000, weeklyRemaining: 500, weeklyResetAt: 10080, expiresAt: 10080
};
const ledger = reserveAgent(emptyLedger(), { id: "agent", subscriptionId: "a", estimatedUnits: 10 });
const decision: Selection = selectSubscription({ subscriptions: [subscription], ledger, requests: [{ at: 0, units: 10 }] });
const selected: string | null = decision.selectedId;
const retry: number | null = decision.retryAt;
acknowledgeCharges(ledger, [], "weekly");

// @ts-expect-error Selection can return no feasible subscription.
const definitelySelected: string = decision.selectedId;
// @ts-expect-error Only the two declared quota windows are supported.
acknowledgeCharges(ledger, [], "monthly");
void [selected, retry, definitelySelected];

const cost = estimateAgentUnits([10, 10, 10, 10, 20]);
const state = createRoutingState({ subscriptions: [subscription] });
const allocation = allocateAgent(state, { id: "agent", at: 0, estimatedUnits: cost.units, expectedRevision: state.revision });
if (allocation.status === "reserved") {
  const account: string = allocation.selectedId;
  const candidatePlan: (string | null)[] = allocation.decision.plan;
  void [account, candidatePlan];
}
applyUsageSnapshot(allocation.state, { subscriptions: [subscription], observedAt: 1, expectedRevision: allocation.state.revision });
// @ts-expect-error A fresh allocation must name the state revision it read.
allocateAgent(state, { id: "other", at: 0, estimatedUnits: 10 });
// @ts-expect-error Cost estimation has no randomized mode.
estimateAgentUnits([], { mode: "random" });

const timed = selectSubscription({ subscriptions: [subscription], requests: [{ at: 0, units: 10, spendAt: 60 }],
  planner: "beam", beamWidth: 8 });
const planner: "exact" | "beam" = timed.planner;
const optimal: boolean = timed.optimal;
allocateAgent(state, { id: "timed", at: 0, estimatedUnits: 10, spendAt: 60, expectedRevision: 0, planner: "beam", beamWidth: 8 });
// @ts-expect-error Only deterministic exact and beam planners are declared.
selectSubscription({ subscriptions: [subscription], requests: [{ at: 0, units: 1 }], planner: "random" });
void [planner, optimal];
