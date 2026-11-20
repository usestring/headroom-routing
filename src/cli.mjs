import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { calculateHeadroom, rankAccounts, readQuotaInput } from "./quota.mjs";

// Exit status when no account can take work, so a caller can tell "wait" from a failed run.
const NO_CAPACITY = 75;

const USAGE = `Usage: headroom-routing quota [options] < input.json

Reads quota readings as JSON from --input or stdin and prints a headroom report.
Input is either { "accounts": QuotaAccount[] } or a quota report with sources and resetTimeline.

Options:
  --input <file|->            Input file (default: stdin)
  --account <id>              Limit to this account; repeat for several
  --provider <name>           With --select, consider only this provider; repeat for several
  --preferred <provider>      With --select, break score ties toward this provider
  --deprioritize <provider>   With --select, rank this provider after all others; repeat for several
  --reserve <percent>         Allowance held back on every window (default 10)
  --strict-reserve <bool>     true (default): an account at or below the reserve is unusable;
                              false: it stays usable but ranks after every account above it
  --max-age-seconds <n>       Oldest acceptable observation (default 120)
  --reset-offers <file>       JSON array of expiring reset offers to evaluate
  --now <iso-time>            Calculation time (default: now)
  --select                    Print only the best account as JSON; exit ${NO_CAPACITY} when none is usable
  -h, --help                  Show this help
`;

function number(value, flag) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} needs a number`);
  return parsed;
}

function boolean(value, flag) {
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new Error(`${flag} needs true or false`);
  return value === "true";
}

export function run(argv, { stdin = () => readFileSync(0, "utf8"), readFile = (path) => readFileSync(path, "utf8") } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      input: { type: "string" },
      account: { type: "string", multiple: true },
      provider: { type: "string", multiple: true },
      preferred: { type: "string" },
      deprioritize: { type: "string", multiple: true },
      reserve: { type: "string" },
      "strict-reserve": { type: "string" },
      "max-age-seconds": { type: "string" },
      "reset-offers": { type: "string" },
      now: { type: "string" },
      select: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) return { stdout: USAGE, code: 0 };
  if (positionals.length === 0) return { stdout: "", stderr: USAGE, code: 2 };
  if (positionals.length !== 1 || positionals[0] !== "quota") throw new Error(`unknown command: ${positionals.join(" ")}`);

  const raw = values.input === undefined || values.input === "-" ? stdin() : readFile(values.input);
  const maxAgeSeconds = number(values["max-age-seconds"], "--max-age-seconds");
  const nowMs = values.now === undefined ? undefined : Date.parse(values.now);
  if (nowMs !== undefined && !Number.isFinite(nowMs)) throw new Error("--now needs an ISO 8601 time");
  const report = calculateHeadroom(readQuotaInput(JSON.parse(raw)), {
    nowMs,
    accountIds: values.account,
    reservePercent: number(values.reserve, "--reserve"),
    strictReserve: boolean(values["strict-reserve"], "--strict-reserve"),
    maxAgeMs: maxAgeSeconds === undefined ? undefined : maxAgeSeconds * 1000,
    resetOffers: values["reset-offers"] === undefined ? undefined : JSON.parse(readFile(values["reset-offers"]))
  });
  if (!values.select) return { stdout: JSON.stringify(report, null, 2) + "\n", code: 0 };
  const providers = values.provider ? new Set(values.provider) : null;
  const [best] = rankAccounts(report.accounts.filter((account) => !providers || providers.has(account.provider)), {
    preferred: values.preferred,
    deprioritize: values.deprioritize
  });
  return best ? { stdout: JSON.stringify(best) + "\n", code: 0 } : { stdout: "", stderr: "no account has usable headroom\n", code: NO_CAPACITY };
}
