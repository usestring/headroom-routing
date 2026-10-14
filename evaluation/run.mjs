import { runReplay, POLICIES } from "./replay.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const rows = SCENARIOS.flatMap((scenario) => POLICIES.map((policy) => {
  const { selected, ...metrics } = runReplay(scenario, policy);
  return { scenario: scenario.name, ...metrics };
}));
process.stdout.write(JSON.stringify({ scenarios: SCENARIOS.length, policies: POLICIES, results: rows }, null, 2) + "\n");
