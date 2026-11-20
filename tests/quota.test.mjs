import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { accountsFromQuotaReport, calculateHeadroom, rankAccounts } from "../src/index.mjs";
import { run } from "../src/cli.mjs";

const nowMs = Date.parse("2026-11-01T12:00:00Z");
const hour = 3_600_000;
const at = (hours) => new Date(nowMs + hours * hour).toISOString();
const weekly = (changes = {}) => ({ name: "weekly", usedPercent: 20, observedAt: at(0), resetsAt: at(84), durationHours: 168, ...changes });
const account = (windows = [weekly()], changes = {}) => ({ id: "local-codex", provider: "codex", scope: "local", status: "ok", windows, ...changes });
const calculate = (value, options = {}) => calculateHeadroom([value], { nowMs, ...options }).accounts[0];
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const matches = (actual, expected) => assert.deepEqual(pick(actual, Object.keys(expected)), expected);

test("remaining allowance and projected waste are separate, and forecasts use the original observation time", () => {
  matches(calculate(account()), { usable: true, remainingPercent: 80, availablePercent: 70 });
  matches(calculate(account()).windows[0], { projectedUnusedPercent: 60, burnBasis: "window-average" });
  const measured = account([weekly({ usedPercent: 40, observedAt: at(-6), resetsAt: at(12), burnPercentPerHour: 2 })]);
  matches(calculate(measured, { maxAgeMs: 6 * hour }).windows[0], { projectedUnusedPercent: 24, burnBasis: "measured" });
});

test("every limit constrains immediate availability, including a full model-specific week", () => {
  const value = account([weekly(), weekly({ name: "five_hour", usedPercent: 95, resetsAt: at(2), durationHours: 5 })]);
  matches(calculate(value), { usable: false, status: "reserve", tier: "reserve", remainingPercent: 5, availablePercent: 0 });
  matches(calculate(account([...value.windows, weekly({ name: "seven_day_opus", usedPercent: 105 })])), {
    usable: false, status: "exhausted", remainingPercent: 0
  });
});

test("a reserve-tier account stays usable when the reserve is not strict, but exhaustion never is", () => {
  const low = account([weekly({ usedPercent: 95 })]);
  matches(calculate(low, { strictReserve: false }), { usable: true, status: "reserve", tier: "reserve" });
  matches(calculate(account([weekly({ usedPercent: 100 })]), { strictReserve: false }), { usable: false, status: "exhausted" });
});

test("unknown, stale, future, reset and unhealthy readings cannot grant optional work", () => {
  const cases = [
    [account([weekly({ usedPercent: null })]), "unknown"],
    [account([weekly({ observedAt: null })]), "unknown"],
    [account([weekly({ observedAt: at(1) })]), "unknown"],
    [account([weekly({ resetsAt: at(200) })]), "unknown"],
    [account([weekly({ observedAt: at(-1) })]), "stale"],
    [account([weekly({ resetsAt: at(0) })]), "reset-unobserved"],
    [account([weekly({ resetsAt: null })]), "unknown"],
    [account([], { status: "unavailable" }), "unavailable"],
    [account([weekly()], { status: "partial" }), "partial"],
    [account([], { status: "ok" }), "unknown"]
  ];
  for (const [input, status] of cases) {
    const result = calculate(input, { strictReserve: false });
    matches(result, { status, usable: false, availablePercent: 0, remainingPercent: null, score: 0 });
    assert.ok(result.windows.every((window) => window.projectedUnusedPercent === null));
  }
});

test("freshness is recomputed on reuse and a passed reset does not invent a refill", () => {
  const input = [account()];
  assert.equal(calculateHeadroom(input, { nowMs }).accounts[0].usable, true);
  assert.equal(calculateHeadroom(input, { nowMs: nowMs + 5 * 60_000 }).accounts[0].status, "stale");
  assert.equal(calculateHeadroom(input, { nowMs: nowMs - 3_000 }).accounts[0].usable, true);
  assert.equal(calculateHeadroom(input, { nowMs: nowMs - 10_000 }).accounts[0].status, "unknown");
  assert.equal(calculateHeadroom(input, { nowMs: nowMs + 85 * hour, maxAgeMs: 86 * hour }).accounts[0].status, "reset-unobserved");
});

test("calendar-month forecasts require measured burn, while fresh windows need a usable history", () => {
  const monthly = weekly({ name: "monthly", durationHours: undefined, resetsAt: at(200) });
  assert.equal(calculate(account([monthly])).windows[0].projectedUnusedPercent, null);
  assert.equal(calculate(account([{ ...monthly, burnPercentPerHour: 0.1 }])).windows[0].projectedUnusedPercent, 60);
  assert.equal(calculate(account([weekly({ resetsAt: at(167.5) })])).windows[0].projectedUnusedPercent, null);
});

test("selection never substitutes another account, and invalid inputs are explicit errors", () => {
  const values = [account(), account([weekly()], { id: "devbox-codex", scope: "devbox" })];
  assert.deepEqual(calculateHeadroom(values, { nowMs, accountIds: ["local-codex"] }).accounts.map(({ id }) => id), ["local-codex"]);
  assert.throws(() => calculateHeadroom(values, { nowMs, accountIds: ["missing"] }));
  assert.throws(() => calculateHeadroom([account(), account()], { nowMs }));
  assert.throws(() => calculate(account([weekly(), weekly()])));
  assert.throws(() => calculate(account([weekly({ usedPercent: NaN })])));
  assert.throws(() => calculateHeadroom(values, { nowMs, reservePercent: -1 }));
});

test("ranking spends allowance that resets sooner, keeps the reserve tier last and deprioritized providers after all", () => {
  const soon = account([weekly({ usedPercent: 60, resetsAt: at(12) })], { id: "soon", provider: "codex" });
  const later = account([weekly({ usedPercent: 10, resetsAt: at(72) })], { id: "later", provider: "claude" });
  const low = account([weekly({ usedPercent: 95, resetsAt: at(1) })], { id: "low", provider: "codex" });
  const fallback = account([weekly({ usedPercent: 0, resetsAt: at(1) })], { id: "fallback", provider: "opencode-go" });
  const { accounts } = calculateHeadroom([soon, later, low, fallback], { nowMs, strictReserve: false });
  assert.deepEqual(rankAccounts(accounts, { deprioritize: ["opencode-go"] }).map(({ id }) => id), ["soon", "later", "low", "fallback"]);
  // Within the reserve tier, quota that resets sooner still wins.
  const lowLater = account([weekly({ usedPercent: 92, resetsAt: at(72) })], { id: "low-later", provider: "claude" });
  const reserveOnly = calculateHeadroom([lowLater, low], { nowMs, strictReserve: false }).accounts;
  assert.equal(rankAccounts(reserveOnly)[0].id, "low");
  assert.deepEqual(rankAccounts(calculateHeadroom([low], { nowMs }).accounts), []);
});

const resetOffer = (id, hours, changes = {}) => ({ id, accountId: "local-codex", expiresAt: at(hours), ...changes });

test("confirmed exhaustion recommends the earliest unused reset that reopens an eligible account", () => {
  const exhausted = account([weekly({ usedPercent: 100 })]);
  const resetOffers = [
    resetOffer("later", 240),
    resetOffer("expired", 0),
    resetOffer("used", 1, { redeemedAt: at(-1) }),
    resetOffer("wrong-window", 2, { windows: ["five_hour"] }),
    resetOffer("first", 3, { windows: ["weekly"] })
  ];
  const options = { nowMs, resetOffers };
  const result = calculateHeadroom([exhausted, account([weekly()], { id: "local-claude", provider: "claude" })], options);
  assert.deepEqual(result.resetRecommendations, [
    { offerId: "first", accountId: "local-codex", provider: "codex", expiresAt: at(3), reason: "ordinary-quota-exhausted" }
  ]);
  matches(result.accounts[0], { status: "exhausted", availablePercent: 0, usable: false });
  for (const alternative of [95, null]) {
    const other = account([weekly({ usedPercent: alternative })], { id: "devbox-codex" });
    // The offer lapses before this account's own weekly refill, so it adds capacity regardless of the other account.
    assert.deepEqual(calculateHeadroom([exhausted, other], options).resetRecommendations, [
      { offerId: "first", accountId: "local-codex", provider: "codex", expiresAt: at(3), reason: "expiring-reset-adds-weekly-capacity" }
    ]);
    assert.deepEqual(calculateHeadroom([exhausted, other], { ...options, accountIds: [exhausted.id] }).resetRecommendations, result.resetRecommendations);
  }
});

test("a final-week offer can bridge the gap after its expiry and before automatic refill", () => {
  // The weekly average reaches 100% in 56 hours, and the weekly refill is in 84 hours.
  const input = account([weekly({ usedPercent: 60 })]);
  const withOffer = (offer, value = input) => calculateHeadroom([value], { nowMs, resetOffers: [offer] });
  const result = withOffer(resetOffer("bridge", 48));
  assert.deepEqual(result.resetRecommendations.map(({ reason }) => reason), ["expiring-reset-adds-weekly-capacity"]);
  assert.deepEqual(result.accounts, calculateHeadroom([input], { nowMs }).accounts);
  assert.deepEqual(withOffer(resetOffer("still-valid-at-exhaustion", 56)).resetRecommendations, []);
  assert.deepEqual(withOffer(resetOffer("does-not-cover-week", 48, { windows: ["five_hour"] })).resetRecommendations, []);
  assert.deepEqual(withOffer(resetOffer("weekly-refill", 48), account([weekly({ usedPercent: 60, burnPercentPerHour: 0.25 })])).resetRecommendations, []);
  assert.deepEqual(withOffer(resetOffer("ineligible", 24), account([weekly({ usedPercent: 20, burnPercentPerHour: 2 })])).resetRecommendations, []);
});

test("a deferred offer is still redeemed once its account is exhausted while another account has quota", () => {
  const other = account([weekly({ usedPercent: 50 })], { id: "devbox-codex" });
  const offer = resetOffer("deferred", 60);
  assert.deepEqual(calculateHeadroom([account([weekly({ usedPercent: 60 })]), other], { nowMs, resetOffers: [offer] }).resetRecommendations, []);
  // At projected exhaustion (+56h) the weekly refill is still 28 hours away and the offer expires in 4.
  const later = { nowMs: nowMs + 57 * hour, resetOffers: [offer] };
  const exhausted = account([weekly({ usedPercent: 100, observedAt: at(57) })]);
  const otherLater = { ...other, windows: [weekly({ usedPercent: 50, observedAt: at(57) })] };
  assert.deepEqual(calculateHeadroom([exhausted, otherLater], later).resetRecommendations.map(({ offerId }) => offerId), ["deferred"]);
  const refillsFirst = account([weekly({ usedPercent: 100, observedAt: at(57), resetsAt: at(59) })]);
  assert.deepEqual(calculateHeadroom([refillsFirst, other], later).resetRecommendations, []);
});

const reportWindow = (agent, changes = {}) => ({ agent, name: "secondary", label: "weekly", usedPercent: 20, snapshotAt: at(0), resetsAt: at(84), ...changes });
const report = {
  sources: [{ name: "local-codex", adapter: "codex", host: "local", status: "ok" }],
  resetTimeline: [reportWindow("local-codex")],
  fleet: {
    sources: [{ name: "fleet-claude-example", adapter: "claude", host: "fleet", status: "ok" }],
    resetTimeline: [
      reportWindow("fleet-claude-example", { name: "weekly_all" }),
      reportWindow("fleet-claude-example", { name: "session", label: "5h", resetsAt: at(2) })
    ]
  }
};

test("quota reports normalize personal and fleet groups without carrying unrelated fields", () => {
  const result = calculateHeadroom(accountsFromQuotaReport({ ...report, credentials: "do-not-copy" }), { nowMs });
  assert.deepEqual(result.accounts.map(({ scope }) => scope), ["local", "fleet"]);
  assert.ok(result.accounts.every(({ usable }) => usable));
  assert.equal(result.accounts[0].windows[0].projectedUnusedPercent, 60);
  assert.ok(!JSON.stringify(result).includes("do-not-copy"));
});

test("Claude needs an account-wide weekly window but not a 5h one; OpenCode Go needs weekly and monthly", () => {
  const claudeWeeklyOnly = { sources: [{ name: "c", adapter: "claude", status: "ok" }], resetTimeline: [reportWindow("c", { name: "weekly_all" })] };
  assert.equal(calculateHeadroom(accountsFromQuotaReport(claudeWeeklyOnly), { nowMs }).accounts[0].usable, true);
  for (const adapter of ["claude", "opencode-go"]) {
    const partial = { sources: [{ name: "partial", adapter, status: "ok" }], resetTimeline: [reportWindow("partial")] };
    matches(calculateHeadroom(accountsFromQuotaReport(partial), { nowMs }).accounts[0], { usable: false, status: "partial" });
  }
  assert.throws(() => accountsFromQuotaReport({}));
  assert.throws(() => accountsFromQuotaReport({ ...report, resetTimeline: [reportWindow("missing")] }));
  assert.throws(() => accountsFromQuotaReport({ ...report, resetTimeline: [reportWindow("local-codex", { usedPercent: "20" })] }));
});

test("the CLI reads either input format and selects with exit status 75 when nothing is usable", () => {
  const options = ["--now", at(0)];
  const fromReport = run(["quota", ...options], { stdin: () => JSON.stringify(report) });
  assert.equal(fromReport.code, 0);
  assert.equal(JSON.parse(fromReport.stdout).accounts.length, 2);
  const fromAccounts = run(["quota", "--select", ...options], { stdin: () => JSON.stringify({ accounts: [account()] }) });
  assert.equal(JSON.parse(fromAccounts.stdout).id, "local-codex");
  const filtered = run(["quota", "--select", "--provider", "claude", ...options], { stdin: () => JSON.stringify({ accounts: [account()] }) });
  assert.equal(filtered.code, 75);
  const low = JSON.stringify({ accounts: [account([weekly({ usedPercent: 95 })])] });
  assert.equal(run(["quota", "--select", ...options], { stdin: () => low }).code, 75);
  assert.equal(run(["quota", "--select", "--strict-reserve", "false", ...options], { stdin: () => low }).code, 0);
  assert.throws(() => run(["quota", "--reserve", "lots"], { stdin: () => low }));
  assert.equal(run([]).code, 2);
});

test("the installed bin runs as a standalone executable", () => {
  const bin = fileURLToPath(new URL("../bin/headroom-routing.mjs", import.meta.url));
  const input = JSON.stringify({ accounts: [account([weekly({ observedAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 84 * hour).toISOString() })])] });
  assert.equal(JSON.parse(execFileSync(process.execPath, [bin, "quota", "--select"], { input })).id, "local-codex");
  const failed = spawnSync(process.execPath, [bin, "quota"], { input: "not json" });
  assert.equal(failed.status, 1);
  assert.match(String(failed.stderr), /^headroom-routing: /);
});
