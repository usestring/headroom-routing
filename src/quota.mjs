import assert from "node:assert/strict";

const HOUR_MS = 3_600_000;
const WEEK_HOURS = 7 * 24;
const MAX_AGE_MS = 120_000;
const CLOCK_SKEW_MS = 5_000;
const DEFAULT_RESERVE = 10;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value, what) {
  assert(isObject(value), `Expected ${what} to be an object`);
  return value;
}

function array(value, what) {
  assert(Array.isArray(value), `Expected ${what} to be an array`);
  return value;
}

function text(value, what) {
  assert(typeof value === "string" && value.trim().length > 0, `Expected ${what} to be a nonempty string`);
  return value;
}

function optionalText(value, what) {
  return value == null ? null : text(value, what);
}

function optionalNumber(value, what) {
  if (value == null) return null;
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0, `Expected ${what} to be a nonnegative finite number`);
  return value;
}

/** Fixed window lengths in hours. Calendar months vary, so they return undefined. */
export function durationHours(name, label) {
  if (label === "weekly" || name === "seven_day" || name.startsWith("seven_day_")) return WEEK_HOURS;
  if (label === "5h" || name === "five_hour") return 5;
  const minutes = /^window_(\d+)m$/.exec(name)?.[1];
  if (minutes && Number(minutes) > 0) return Number(minutes) / 60;
  return undefined;
}

/**
 * Converts a quota report (`sources` plus `resetTimeline`, with an optional `fleet` group of the same
 * shape) into normalized accounts. A Claude login needs an account-wide weekly window; an OpenCode Go
 * login needs weekly and monthly windows. Incomplete readings are `partial` and cannot be used.
 */
export function accountsFromQuotaReport(report) {
  const root = object(report, "quota report");
  const groups = [{ group: root, scope: "personal" }];
  if (root.fleet != null) groups.push({ group: object(root.fleet, "fleet"), scope: "fleet" });
  return groups.flatMap(({ group, scope }) => {
    const sources = array(group.sources, "sources").map((source) => object(source, "source"));
    const windows = array(group.resetTimeline, "resetTimeline").map((window) => object(window, "resetTimeline entry"));
    const names = new Set(sources.map((source) => text(source.name, "source name")));
    assert(windows.every((window) => names.has(text(window.agent, "window agent"))), "Quota window has no source");
    return sources.map((source) => {
      const own = windows.filter((window) => window.agent === source.name);
      const provider = text(source.adapter, "source adapter");
      const complete = provider === "claude"
        ? own.some((window) => ["weekly_all", "weekly"].includes(String(window.name)))
        : provider === "opencode-go"
          ? ["weekly", "monthly"].every((label) => own.some((window) => window.label === label))
          : true;
      return {
        id: source.name,
        provider,
        scope: optionalText(source.host, "source host") ?? scope,
        status: source.status !== "ok" || !own.length ? "unavailable" : complete ? "ok" : "partial",
        windows: own.map((window) => {
          const name = text(window.name, "window name");
          const label = optionalText(window.label, "window label") ?? undefined;
          return {
            name,
            label,
            usedPercent: optionalNumber(window.usedPercent, "usedPercent"),
            observedAt: optionalText(window.snapshotAt, "snapshotAt"),
            resetsAt: optionalText(window.resetsAt, "resetsAt"),
            durationHours: durationHours(name, label),
            burnPercentPerHour: optionalNumber(window.burnPctPerHour, "burnPctPerHour")
          };
        })
      };
    });
  });
}

function burnRate(window, hoursUntilReset) {
  if (window.burnPercentPerHour != null) return window.burnPercentPerHour;
  if (window.durationHours === undefined || window.usedPercent === null) return null;
  const elapsedHours = window.durationHours - hoursUntilReset;
  return elapsedHours >= 1 ? window.usedPercent / elapsedHours : null;
}

function isLongWindow(window) {
  return window.durationHours === WEEK_HOURS || window.label === "weekly" || window.label === "monthly";
}

function windowHeadroom(window, healthy, nowMs, maxAgeMs, reserve) {
  const { usedPercent, durationHours: hours, burnPercentPerHour: measured } = window;
  assert(usedPercent === null || (Number.isFinite(usedPercent) && usedPercent >= 0), "Invalid quota utilization");
  assert(hours === undefined || (Number.isFinite(hours) && hours > 0), "Invalid quota duration");
  assert(measured == null || (Number.isFinite(measured) && measured >= 0), "Invalid quota burn rate");
  const observed = Date.parse(window.observedAt ?? "");
  const latest = window.latestObservedAt == null ? observed : Date.parse(window.latestObservedAt);
  const reset = Date.parse(window.resetsAt ?? "");
  let status = "ok";
  if (!healthy) status = "unavailable";
  else if (usedPercent === null || !Number.isFinite(observed) || !Number.isFinite(reset) || !Number.isFinite(latest)) status = "unknown";
  else if (Math.max(observed, latest) > nowMs + CLOCK_SKEW_MS) status = "unknown";
  else if (hours !== undefined && reset - observed > hours * HOUR_MS) status = "unknown";
  else if (nowMs - observed > maxAgeMs) status = "stale";
  else if (reset <= nowMs) status = "reset-unobserved";
  const remainingPercent = status === "ok" ? Math.max(0, 100 - usedPercent) : null;
  const result = {
    ...window,
    status,
    remainingPercent,
    availablePercent: remainingPercent === null ? 0 : Math.max(0, remainingPercent - reserve),
    projectedUnusedPercent: null,
    burnBasis: null
  };
  if (status !== "ok") return result;
  // Projecting from the observation, not from now, keeps consumption since the reading in the forecast.
  const hoursFromObservationToReset = (reset - observed) / HOUR_MS;
  const rate = burnRate(window, hoursFromObservationToReset);
  if (rate !== null) {
    result.projectedUnusedPercent = Math.max(0, 100 - usedPercent - rate * hoursFromObservationToReset);
    result.burnBasis = measured == null ? "window-average" : "measured";
  }
  return result;
}

// Spare weekly or monthly allowance per squared hour to reset: an account whose allowance expires
// soonest ranks first, so quota that would otherwise be lost at reset is spent before quota that
// will still be there next week. Below the reserve, the margin would be negative and invert the
// reset-time preference, so reserve-tier accounts rank on raw remaining allowance instead.
function rankScore(windows, nowMs, reserve, tier) {
  let score = Infinity;
  for (const window of windows) {
    if (window.remainingPercent === null || !isLongWindow(window)) continue;
    const hours = Math.max((Date.parse(window.resetsAt) - nowMs) / HOUR_MS, 0.25) ** 2;
    score = Math.min(score, (tier === "reserve" ? window.remainingPercent : window.remainingPercent - reserve) / hours);
  }
  return Number.isFinite(score) ? score : 0;
}

function projectedWeeklyExhaustion(window) {
  if (window.durationHours !== WEEK_HOURS || window.remainingPercent === null) return null;
  const observed = Date.parse(window.observedAt ?? "");
  const hoursUntilRefill = (Date.parse(window.resetsAt ?? "") - observed) / HOUR_MS;
  const rate = burnRate(window, hoursUntilRefill);
  if (rate === null || rate === 0) return null;
  const hoursUntilExhaustion = window.remainingPercent / rate;
  return hoursUntilExhaustion < hoursUntilRefill ? observed + hoursUntilExhaustion * HOUR_MS : null;
}

function offerTimestamp(value) {
  assert(typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value), "Reset timestamps must include a time zone");
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp), "Invalid reset timestamp");
  return timestamp;
}

function recommendResets(accounts, offers, nowMs, reservePercent) {
  assert(Array.isArray(offers), "Reset offers must be an array");
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const unconfirmedExhaustion = new Set(accounts.filter(({ status }) => status !== "exhausted").map(({ provider }) => provider));
  const seen = new Set();
  const active = offers.flatMap((offer) => {
    assert(offer && typeof offer.id === "string" && offer.id.trim() && !seen.has(offer.id), "Duplicate or empty reset offer ID");
    assert(typeof offer.accountId === "string" && offer.accountId.trim(), "Missing reset offer account ID");
    assert(
      offer.windows === undefined || (Array.isArray(offer.windows) && offer.windows.every((window) => typeof window === "string" && window.trim())),
      "Invalid reset offer windows"
    );
    seen.add(offer.id);
    const expires = offerTimestamp(offer.expiresAt);
    if (offer.redeemedAt != null) offerTimestamp(offer.redeemedAt);
    return expires > nowMs && offer.redeemedAt == null ? [{ offer, expires }] : [];
  });
  active.sort((left, right) => left.expires - right.expires || (left.offer.id < right.offer.id ? -1 : 1));

  const recommendations = new Map();
  for (const { offer, expires } of active) {
    const account = byId.get(offer.accountId);
    if (!account || account.remainingPercent === null || recommendations.has(account.provider)) continue;
    const clears = (window) => !offer.windows?.length || offer.windows.includes(window.name);
    if (!account.windows.every((window) => clears(window) ? reservePercent < 100 : window.availablePercent > 0)) continue;
    // Codex accepts a reset only when a covered window has more than 20% usage.
    if (account.provider === "codex" && !account.windows.some((window) => clears(window) && (window.usedPercent ?? 0) > 20)) continue;

    let reason;
    if (!unconfirmedExhaustion.has(account.provider)) {
      reason = "ordinary-quota-exhausted";
    } else if (account.status === "exhausted") {
      // Another account still has quota, so redeem only when this account's own refill comes too late.
      const reopens = Math.max(...account.windows.filter(({ remainingPercent }) => remainingPercent === 0).map(({ resetsAt }) => Date.parse(resetsAt ?? "")));
      if (expires >= reopens) continue;
      reason = "expiring-reset-adds-weekly-capacity";
    } else {
      if (expires - nowMs > WEEK_HOURS * HOUR_MS) continue;
      const projected = account.windows.flatMap((window) => {
        const exhaustion = projectedWeeklyExhaustion(window);
        return exhaustion === null ? [] : [{ window, exhaustion }];
      });
      const earliest = Math.min(...projected.map(({ exhaustion }) => exhaustion));
      // Wait when ordinary quota runs out early enough to redeem the offer at exhaustion.
      if (!projected.length || earliest <= expires || projected.some(({ window, exhaustion }) => exhaustion === earliest && !clears(window))) continue;
      reason = "expiring-reset-adds-weekly-capacity";
    }
    recommendations.set(account.provider, { offerId: offer.id, accountId: account.id, provider: account.provider, expiresAt: offer.expiresAt, reason });
  }
  return [...recommendations.values()];
}

/**
 * Calculates per-window and per-account headroom from normalized quota readings. Pure when `nowMs`
 * is supplied. Any unavailable, unknown, stale or already-reset window makes its account unusable.
 */
export function calculateHeadroom(accounts, options = {}) {
  const { nowMs = Date.now(), maxAgeMs = MAX_AGE_MS, reservePercent = DEFAULT_RESERVE, accountIds, resetOffers, strictReserve = true } = options;
  assert(Array.isArray(accounts), "Quota accounts must be an array");
  assert(Number.isFinite(nowMs) && Number.isFinite(new Date(nowMs).getTime()), "Invalid calculation time");
  assert(Number.isFinite(maxAgeMs) && maxAgeMs >= 0, "Invalid maximum observation age");
  assert(Number.isFinite(reservePercent) && reservePercent >= 0 && reservePercent <= 100, "Invalid quota reserve");
  const byId = new Map();
  for (const account of accounts) {
    object(account, "quota account");
    assert(typeof account.id === "string" && account.id && !byId.has(account.id), "Duplicate or empty quota account ID");
    array(account.windows, "account windows");
    assert(new Set(account.windows.map(({ name }) => name)).size === account.windows.length, "Duplicate quota window");
    byId.set(account.id, account);
  }
  const selected = accountIds
    ? [...new Set(accountIds)].map((id) => {
        const account = byId.get(id);
        assert(account, `Unknown quota account: ${id}`);
        return account;
      })
    : accounts;
  const report = {
    calculatedAt: new Date(nowMs).toISOString(),
    reservePercent,
    accounts: selected.map((account) => {
      const healthy = account.status === "ok";
      const windows = account.windows.map((window) => windowHeadroom(window, healthy, nowMs, maxAgeMs, reservePercent));
      let status = healthy ? "unknown" : account.status === "partial" ? "partial" : "unavailable";
      let remainingPercent = null;
      let availablePercent = 0;
      if (healthy && windows.length) {
        status = windows.find((window) => window.status !== "ok")?.status ?? "ok";
        if (status === "ok") {
          remainingPercent = Math.min(...windows.map((window) => window.remainingPercent));
          availablePercent = Math.min(...windows.map((window) => window.availablePercent));
          if (remainingPercent === 0) status = "exhausted";
          else if (availablePercent === 0) status = "reserve";
        }
      }
      const tier = status === "reserve" ? "reserve" : "normal";
      return {
        id: account.id,
        provider: account.provider,
        scope: account.scope,
        status,
        usable: status === "ok" || (status === "reserve" && !strictReserve),
        tier,
        remainingPercent,
        availablePercent,
        score: status === "ok" || status === "reserve" ? rankScore(windows, nowMs, reservePercent, tier) : 0,
        windows
      };
    })
  };
  if (resetOffers !== undefined) report.resetRecommendations = recommendResets(report.accounts, resetOffers, nowMs, reservePercent);
  return report;
}

/**
 * Orders usable accounts for the next job: normal tier before reserve tier, then by score, then by
 * the preferred provider and account ID. Providers listed in `deprioritize` come after all others.
 */
export function rankAccounts(accounts, { preferred, deprioritize = [] } = {}) {
  const last = new Set(deprioritize);
  return accounts.filter((account) => account.usable)
    .sort((a, b) => Number(last.has(a.provider)) - Number(last.has(b.provider))
      || Number(a.tier === "reserve") - Number(b.tier === "reserve")
      || b.score - a.score
      || Number(b.provider === preferred) - Number(a.provider === preferred)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Normalizes either a quota report or `{ accounts: QuotaAccount[] }` input. */
export function readQuotaInput(input) {
  const root = object(input, "headroom input");
  return Array.isArray(root.accounts) ? root.accounts : accountsFromQuotaReport(root);
}
