import { selectSubscription, emptyLedger, reserveAgent, acknowledgeCharges, Subscription, Selection } from "../src/index";

const subscription: Subscription = {
  id: "a", sessionCapacity: 100, sessionRemaining: 50, sessionResetAt: 300,
  weeklyCapacity: 1000, weeklyRemaining: 500, weeklyResetAt: 10080
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
