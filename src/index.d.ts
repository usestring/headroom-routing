export interface Subscription {
  id: string;
  sessionCapacity: number;
  sessionRemaining: number;
  sessionResetAt: number;
  weeklyCapacity: number;
  weeklyRemaining: number;
  weeklyResetAt: number;
  sessionBuffer?: number;
  weeklyBuffer?: number;
  sessionReserve?: number;
  weeklyReserve?: number;
  availableAt?: number;
  enabled?: boolean;
}

export interface Request {
  at: number;
  spendAt?: number;
  units: number;
  allowedIds?: readonly string[];
  useReservedCapacity?: boolean;
}

export interface AgentReservation {
  id: string;
  subscriptionId: string;
  estimatedUnits: number;
  futureUnits: number;
  completed: boolean;
}

export interface PendingCharge {
  id: string;
  agentId: string;
  spentUnits: number;
  sessionResetAt: number;
  weeklyResetAt: number;
  sessionIncluded: boolean;
  weeklyIncluded: boolean;
}

export interface Ledger {
  agents: readonly AgentReservation[];
  charges: readonly PendingCharge[];
}

export interface Score {
  blockedRequests: number;
  expiredWeeklyUnits: number;
  earlyExpiryUnitMinutes: number;
  sessionExposure: number;
  admissionPressure: number;
}

export interface Candidate {
  id: string;
  score: Score;
  plan: (string | null)[];
}

export interface Selection {
  selectedId: string | null;
  reason: "selected" | "no_capacity";
  retryAt: number | null;
  score: Score;
  plan: (string | null)[];
  candidates: Candidate[];
  projectedHeadroom: { id: string; sessionRemaining: number; weeklyRemaining: number }[];
  exploredStates: number;
  planner: "exact" | "beam";
  optimal: boolean;
}

export interface SelectionInput {
  subscriptions: readonly Subscription[];
  requests: readonly Request[];
  ledger?: Ledger;
  now?: number;
  horizon?: number;
  maxStates?: number;
  planner?: "exact" | "beam";
  beamWidth?: number;
}

export const SESSION_MINUTES: 300;
export const WEEK_MINUTES: 10080;
export function selectSubscription(input: SelectionInput): Selection;
export function compareScores(left: Score, right: Score): -1 | 0 | 1;
export function emptyLedger(): Ledger;
export function reserveAgent(ledger: Ledger, input: { id: string; subscriptionId: string; estimatedUnits: number }): Ledger;
export function recordSpend(ledger: Ledger, input: { id: string; agentId: string; spentUnits: number; sessionResetAt: number; weeklyResetAt: number }): Ledger;
export function reviseFutureSpend(ledger: Ledger, agentId: string, futureUnits: number): Ledger;
export function completeAgent(ledger: Ledger, agentId: string): Ledger;
export function acknowledgeCharges(ledger: Ledger, chargeIds: readonly string[], window: "session" | "weekly"): Ledger;
export function projectedSpend(ledger: Ledger, subscription: Subscription): { futureUnits: number; sessionUnits: number; weeklyUnits: number };

export interface CostEstimatorOptions {
  defaultUnits?: number;
  mode?: "mean" | "quantile";
  quantile?: number;
  minimumSamples?: number;
  maxSamples?: number;
}

export interface CostEstimate {
  units: number;
  sampleCount: number;
  source: "fallback" | "cold_start" | "history";
  mode: "mean" | "quantile";
}

export interface RoutingState {
  subscriptions: readonly Subscription[];
  ledger: Ledger;
  observedAt: number;
  lastAllocatedAt: number;
  revision: number;
}

export interface AllocationInput {
  id: string;
  spendAt?: number;
  at: number;
  estimatedUnits: number;
  expectedRevision: number;
  allowedIds?: readonly string[];
  useReservedCapacity?: boolean;
  forecast?: readonly Request[];
  horizon?: number;
  maxStates?: number;
  planner?: "exact" | "beam";
  beamWidth?: number;
}

export type AllocationResult =
  | { state: RoutingState; status: "reserved"; selectedId: string; decision: Selection }
  | { state: RoutingState; status: "waiting"; selectedId: null; decision: Selection }
  | { state: RoutingState; status: "already_reserved"; selectedId: string; decision: null };

export interface UsageSnapshotInput {
  subscriptions: readonly Subscription[];
  observedAt: number;
  expectedRevision: number;
  includedCharges?: { session?: readonly string[]; weekly?: readonly string[] };
}

export function estimateAgentUnits(history: readonly number[], options?: CostEstimatorOptions): CostEstimate;
export function createRoutingState(input: { subscriptions: readonly Subscription[]; ledger?: Ledger; observedAt?: number }): RoutingState;
export function allocateAgent(state: RoutingState, input: AllocationInput): AllocationResult;
export function applyUsageSnapshot(state: RoutingState, input: UsageSnapshotInput): RoutingState;
