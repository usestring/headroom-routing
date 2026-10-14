import assert from "node:assert/strict";
import { units } from "./reservations.mjs";

export function estimateAgentUnits(history, options = {}) {
  const { defaultUnits = 10, mode = "quantile", quantile = 0.9, minimumSamples = 5, maxSamples = 50 } = options;
  assert(Array.isArray(history), "history must contain completed-agent costs");
  units(defaultUnits, "defaultUnits", 1);
  units(minimumSamples, "minimumSamples", 1);
  units(maxSamples, "maxSamples", minimumSamples);
  assert(maxSamples <= 10_000, "maxSamples cannot exceed 10000");
  assert(mode === "mean" || mode === "quantile", "unknown cost estimator");
  assert(Number.isFinite(quantile) && quantile >= 0 && quantile <= 1, "quantile must be in [0, 1]");
  for (const cost of history) units(cost, "completed cost", 1);
  const samples = history.slice(-maxSamples);
  if (samples.length === 0) return { units: defaultUnits, sampleCount: 0, source: "fallback", mode };
  if (samples.length < minimumSamples) {
    return { units: Math.max(defaultUnits, ...samples), sampleCount: samples.length, source: "cold_start", mode };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const count = BigInt(samples.length);
  const estimate = mode === "mean" ? Number((samples.reduce((sum, cost) => sum + BigInt(cost), 0n) + count - 1n) / count)
    : sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
  return { units: estimate, sampleCount: samples.length, source: "history", mode };
}
