import { createRoutingState, allocateAgent, estimateAgentUnits, type Subscription } from "@usestring/headroom-routing";

const subscriptions: Subscription[] = [{ id: "a", sessionCapacity: 100, sessionRemaining: 100, sessionResetAt: 300,
  weeklyCapacity: 1000, weeklyRemaining: 1000, weeklyResetAt: 10080 }];
const state = createRoutingState({ subscriptions });
const estimate = estimateAgentUnits([10, 10, 10, 10, 20]);
const result = allocateAgent(state, { id: "agent", at: 0, estimatedUnits: estimate.units, expectedRevision: state.revision,
  spendAt: 60, planner: "beam", beamWidth: 8 });
if (result.status === "reserved") {
  const account: string = result.selectedId;
  const planner: "exact" | "beam" = result.decision.planner;
  const optimal: boolean = result.decision.optimal;
  void [account, planner, optimal];
}
// @ts-expect-error A waiting selection is nullable outside its status guard.
const guaranteed: string = result.selectedId;
void guaranteed;
