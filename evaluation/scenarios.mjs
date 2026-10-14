const account = (id, fields = {}) => ({ id, sessionCapacity: 100, sessionRemaining: 50, sessionResetAt: 300,
  sessionBuffer: 10, weeklyCapacity: 1000, weeklyRemaining: 500, weeklyResetAt: 10080, ...fields });
const burst = (count, units = 10, at = 0, duration = 60) => Array.from({ length: count }, (_, index) => ({
  id: `agent-${index}`, at, duration, actualUnits: units
}));

export const SCENARIOS = [
  { name: "idle-burst-delayed-report", subscriptions: [account("a")], agents: burst(100), horizon: 120, reportInterval: 120 },
  { name: "expensive-tail", subscriptions: [account("a")], agents: burst(4, 20), history: [10, 10, 10, 10, 20], horizon: 120, reportInterval: 120 },
  { name: "weekly-expiry", subscriptions: [account("early", { sessionRemaining: 40, sessionBuffer: 0, weeklyRemaining: 40, weeklyResetAt: 60 }),
    account("later", { sessionRemaining: 100, sessionBuffer: 0, weeklyRemaining: 1000 })],
    agents: burst(4, 10, 0, 10).map((agent, index) => ({ ...agent, at: index * 10 })), horizon: 60, reportInterval: 60 },
  { name: "sustained-staggered-resets", subscriptions: [account("a", { sessionRemaining: 100 }),
    account("b", { sessionRemaining: 100, sessionResetAt: 240 }), account("c", { sessionRemaining: 100, sessionResetAt: 180 })],
    agents: burst(60, 10, 0, 30).map((agent, index) => ({ ...agent, at: index * 20 })), horizon: 1260, reportInterval: 90 },
  { name: "unseen-cost-outlier", subscriptions: [account("a")], agents: burst(1, 60), history: [10, 10, 10, 10, 10], horizon: 120, reportInterval: 120 },
  { name: "unseen-external-spend", subscriptions: [account("a")], agents: burst(4, 10), horizon: 120, reportInterval: 120,
    externalSpend: [{ at: 1, subscriptionId: "a", units: 30 }] },
  { name: "tail-overreservation", subscriptions: [account("a", { weeklyRemaining: 50, weeklyResetAt: 120 })],
    agents: burst(4, 10), history: [10, 10, 10, 10, 20], horizon: 120, reportInterval: 120 }
];
