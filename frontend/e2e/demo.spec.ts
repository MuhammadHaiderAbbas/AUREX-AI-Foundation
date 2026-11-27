import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Runs against the static GitHub Pages build (VITE_DEMO_MODE=true). Set AUREX_E2E_DEMO=1.
test.skip(!process.env.AUREX_E2E_DEMO, "demo build only");

test("static demo: Launch demo opens a £100 GBP account", async ({ page }) => {
  await page.goto("login");
  await page.getByRole("button", { name: "Launch demo", exact: true }).click();
  await expect(page.getByRole("link", { name: "£100 paper account" })).toBeVisible();
  await expect(page.getByText("£100.00").first()).toBeVisible();
  await expect(page.getByText("US$100,000.00")).toHaveCount(0);
});

test("public website: home, markets, product and legal pages, then sign up", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /Trade with an AI desk that/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
  await expect(page.getByTestId("public-markets")).toBeVisible();
  await expect(page.getByText("Eight specialists. One accountable decision.")).toBeVisible();
  await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Markets" }).click();
  await expect(page.getByRole("heading", { name: "Today's crypto and forex markets" })).toBeVisible();
  await page.getByRole("tab", { name: "Forex" }).click();
  await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "AI Trading" }).click();
  await expect(page.getByText("Honest by design")).toBeVisible();
  await page.goto("legal/risk");
  await expect(page.getByRole("heading", { name: "Risk disclosure" })).toBeVisible();
  await page.getByRole("link", { name: "Sign up" }).first().click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("static demo: trader tour of the app", async ({ page }) => {
  test.setTimeout(120_000);   // a long end-to-end tour that talks to real Coinbase and CoinGecko APIs
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("login");
  await expect(page.getByText("Public demo.")).toBeVisible();
  // This tour trades sizes a £100 account cannot afford, so it uses the US$100,000 alternative
  await page.getByRole("button", { name: "Launch demo with US$100,000", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Demo Trader" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Demo paper account" })).toBeVisible();
  await expect(page.getByText("US$100,000.00").first()).toBeVisible();
  await expect(page.getByTestId("live-status")).toContainText(/Live · polling/i);
  await expect(page.getByTestId("app-ticker")).toBeVisible();
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);

  // Trade terminal: data source labelled, chart renders, timeframes
  await page.getByRole("link", { name: "Trade", exact: true }).click();
  await expect(page.getByTestId("trade-terminal")).toBeVisible();
  await expect(page.getByText(/^(Synthetic data|Crypto & FX live · stocks simulated)$/)).toBeVisible();
  await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
  await page.getByRole("tab", { name: "Forex" }).click();
  await page.getByRole("button", { name: /^GBP\/USD British/ }).click();
  await expect(page).toHaveURL(/symbol=GBPUSD/);
  await page.getByRole("button", { name: "1d" }).click();
  await expect(page.getByText(/\d+ candles · source (Synthetic|ECB reference)/)).toBeVisible();

  // Wallet: double-entry ledger in the browser
  await page.goto("app/wallet");
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.getByLabel("Amount (USD)").fill("250");
  await page.getByRole("button", { name: "Deposit virtual cash" }).click();
  await expect(page.getByText("Deposited US$250.00")).toBeVisible();

  // Settings from the account menu
  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: /^Security/ }).click();
  await expect(page.getByTestId("sessions")).toContainText("This session");
  await page.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByText("demo@aurex.example").first()).toBeVisible();

  // Research Lab: traders start with the fictional sample library
  await page.getByRole("link", { name: "Research", exact: true }).click();
  await page.getByRole("button", { name: /outlook for Northwind/ }).click();
  await expect(page.getByText("Verified facts")).toBeVisible();
  await expect(page.getByText("Contradictory evidence")).toBeVisible();
  await expect(page.getByText("Cites the fictional sample corpus; not real market information.")).toBeVisible();

  // AI desk: run, explained decision, all eight agents
  await page.getByRole("link", { name: "AI Desk" }).click();
  await page.getByLabel("Instrument").selectOption("EUR/USD");
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByTestId("decision")).toHaveText(/BUY|NO TRADE/);
  for (const a of ["technical", "quant", "regime", "news", "portfolio", "risk"]) await expect(page.getByTestId(`agent-${a}`)).toBeVisible();
  await expect(page.getByTestId("agent-news")).not.toContainText("Error");

  // Backtesting in the browser
  await page.goto("app/backtests");
  await expect(page.getByText("Configure backtest")).toBeVisible();
  await page.getByLabel("Strategy").selectOption("donchian_breakout");
  await page.getByLabel("Instrument").selectOption("BTC-USD");
  await page.getByLabel("Period").selectOption("90");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(page.getByTestId("metrics-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("oos-headline")).toContainText("Sharpe");

  // Paper execution and the risk engine in the browser
  await tradeFlow(page);
  await riskFlow(page);
  await analyticsFlow(page);

  // A £100 GBP account alongside the $100k demo account, then paper binary options on it
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.getByLabel("Account name").fill("Small paper");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Small paper" })).toBeVisible();
  await binaryFlow(page, "Small paper · GBP");

  // Two-factor authentication in the browser (Launch demo then asks for a code)
  await mfaFlow(page, "Demo-Account-2026!", async () => {
    await page.getByRole("button", { name: "Launch demo", exact: true }).click();
  });

  // Deep link + reload survives (per-route pages + persisted session); old links still work
  await page.goto("app/trade?symbol=AAPL");
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("price-chart")).toBeVisible();
  await page.goto("wallet");
  await expect(page).toHaveURL(/\/app\/wallet$/);

  expect(errors).toEqual([]);
});

test("static demo: admin console is separate and can put the site on hold", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("login");
  await page.getByRole("button", { name: "Explore the admin console" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("app");                                       // administrators do not trade
  await expect(page).toHaveURL(/\/admin$/);

  // Overview: readiness, anchoring, integrity
  await expect(page.getByTestId("ops-ready")).toContainText("Live trading disabled");
  await page.getByRole("button", { name: "Anchor now" }).click();
  await expect(page.getByTestId("ops-anchoring")).toContainText("covers record");
  await page.getByRole("button", { name: "Run integrity check" }).click();
  await expect(page.getByTestId("integrity-result")).toContainText("anchors_match_chain");

  // Users & audit
  await page.getByRole("link", { name: "Users & audit" }).click();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact — \d+ records verified/)).toBeVisible();
  const auditDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  expect((await auditDownload).suggestedFilename()).toMatch(/^aurex-audit-.*\.jsonl$/);

  // Model Lab in the browser: logistic regression and LightGBM with walk-forward validation
  await page.getByRole("link", { name: "Model Lab" }).click();
  await expect(page.getByText("Train a candidate")).toBeVisible();
  await page.getByLabel("Instrument").selectOption("EUR/USD");
  await page.getByLabel("Algorithm").selectOption("logistic");
  await page.getByLabel("History").selectOption("60");
  await page.getByRole("button", { name: "Train & validate" }).click();
  await expect(page.getByTestId("gates")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("gates")).toContainText("Plausible performance");
  await expect(page.getByRole("button", { name: "Promote" })).toBeDisabled();
  await page.getByRole("button", { name: "Drift check" }).click();
  await expect(page.getByText(/max PSI/)).toBeVisible();
  await page.getByLabel("Algorithm").selectOption("lightgbm");
  await page.getByRole("button", { name: "Train & validate" }).click();
  await expect(page.getByText(/EUR\/USD · LightGBM · 4h/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Agents and the research library
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByText("Risk Agent")).toBeVisible();
  await page.getByRole("link", { name: "Research library" }).click();
  await page.getByRole("button", { name: "Add document" }).click();
  await page.getByLabel("Title").fill("Desk memo on GBP/USD");
  await page.getByLabel("Text", { exact: true }).fill("Sterling weakened after softer inflation data, and traders now expect GBP/USD volatility to stay elevated.");
  await page.getByLabel("Source").fill("Demo desk");
  await page.locator("dialog").getByRole("button", { name: "Index document" }).click();
  await expect(page.getByText(/Indexed “Desk memo on GBP\/USD”/)).toBeVisible();
  await page.locator("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^Desk memo on GBP\/USD Demo desk/ })).toBeVisible();

  // Trading controls: kill switch, then maintenance mode
  await page.getByRole("link", { name: "Trading controls" }).click();
  await page.getByLabel("Halt reason").fill("demo drill");
  await page.getByRole("button", { name: "Halt all trading" }).click();
  await expect(page.getByText("Trading halted").first()).toBeVisible();
  await page.getByRole("button", { name: "Resume trading" }).click();
  await expect(page.getByText("Risk gate on")).toBeVisible();
  await page.getByLabel("Message for traders (optional)").fill("Upgrading the AI desk");
  await page.getByRole("button", { name: "Put the site on hold" }).click();
  await expect(page.getByText(/The site is on hold/)).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);                     // wait until the session is really gone
  await page.goto("./");
  await expect(page.getByRole("status")).toContainText("Upgrading the AI desk");
  await page.goto("login");
  await page.getByRole("button", { name: "Launch demo", exact: true }).click();
  // traders are locked out: sign-in is refused with the maintenance message (banner + error) and they stay on the login page
  await expect(page.getByText("Upgrading the AI desk")).toHaveCount(2, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Explore the admin console" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto("admin/controls");
  await page.getByRole("button", { name: "Bring the site back online" }).click();
  await expect(page.getByRole("button", { name: "Put the site on hold" })).toBeVisible();
  expect(errors).toEqual([]);
});

// Shared with the static demo spec (kept in sync manually: Playwright specs don't share imports here).
async function tradeFlow(page: import("@playwright/test").Page) {
  await page.goto("app/trade?symbol=BTC-USD");
  await page.getByRole("button", { name: "Buy", exact: true }).click();
  const dialog = page.locator("dialog");
  await expect(dialog.getByText("Tradable")).toBeVisible();
  await dialog.getByLabel("Quantity").fill("0.05");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("Filled 0.05 BTC-USD");
  // A resting limit far below the market
  await dialog.getByRole("button", { name: "New order" }).click();
  await dialog.getByLabel("Order type").selectOption("LIMIT");
  await dialog.getByLabel("Quantity").fill("0.01");
  await dialog.getByLabel("Limit price").fill("1000.00");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("LIMIT order working");
  // Oversized order is rejected with a reason (no leverage)
  await dialog.getByRole("button", { name: "New order" }).click();
  await dialog.getByLabel("Quantity").fill("100");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("insufficient cash");
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^BTC-USD/ })).toBeVisible();
  await expect(page.getByText("1 of 5 positions")).toBeVisible();

  await page.goto("app/history");
  await page.getByRole("button", { name: "Cancel order BTC-USD" }).click();
  await expect(page.getByRole("button", { name: "Cancel order BTC-USD" })).toHaveCount(0);
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await page.getByRole("cell", { name: "REJECTED" }).first().click();
  await expect(page.getByTestId("order-timeline")).toContainText("insufficient cash");

  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  await page.getByRole("button", { name: "Close BTC-USD" }).click();
  await expect(dialog.getByLabel("Quantity")).toHaveValue("0.05");
  await dialog.getByRole("button", { name: "Place paper sell order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("Filled 0.05 BTC-USD");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByText("No open positions")).toBeVisible();
  await expect(page.getByText("Closed positions")).toBeVisible();

  await page.goto("app/wallet");
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await expect(page.getByText("Trade · sell")).toBeVisible();
  await expect(page.getByText(/^Sell 0.05 BTC-USD @/)).toBeVisible();
}

// Shared with the static demo spec (kept in sync manually).
async function riskFlow(page: import("@playwright/test").Page) {
  await page.goto("app/risk");
  await expect(page.getByTestId("risk-status")).toContainText("Trading allowed");
  await page.getByLabel("Max position size").fill("2");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  // The gate refuses an oversized order and shows every check
  await page.goto("app/trade?symbol=BTC-USD");
  await page.getByRole("button", { name: "Buy", exact: true }).click();
  const dialog = page.locator("dialog");
  await dialog.getByLabel("Quantity").fill("0.05");
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("risk: position would be");
  await expect(dialog.getByTestId("risk-checks")).toContainText("Position size");
  // A small bracketed order passes and places protective orders
  await dialog.getByRole("button", { name: "New order" }).click();
  await dialog.getByLabel("Quantity").fill("0.01");
  const ask = Number((await dialog.getByText(/^Ask/).textContent())!.replace(/[^\d.]/g, ""));
  await dialog.getByLabel("Stop loss (optional)").fill((Math.floor(ask * 0.95 * 100) / 100).toFixed(2));
  await dialog.getByLabel("Take profit (optional)").fill((Math.ceil(ask * 1.1 * 100) / 100).toFixed(2));
  await dialog.getByRole("button", { name: "Place paper buy order" }).click();
  await expect(page.getByTestId("order-result")).toContainText("Filled 0.01 BTC-USD");
  await expect(page.getByTestId("order-result")).toContainText("Protective orders placed: STOP");
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  // Decisions log, kill switch
  await page.goto("app/risk");
  await page.getByLabel("Decision filter").selectOption("false");
  await expect(page.getByRole("cell", { name: /position would be/ })).toBeVisible();
  await page.getByLabel("Kill switch reason").fill("e2e drill");
  await page.getByRole("button", { name: "Engage" }).click();
  await expect(page.getByTestId("risk-status")).toContainText("account kill switch is engaged: e2e drill");
  await expect(page.getByTestId("risk-events")).toContainText("Kill switch engaged");
  await page.getByRole("button", { name: "Release" }).click();
  await expect(page.getByTestId("risk-status")).toContainText("Trading allowed");

  // Autopilot through the gate
  const ap = page.getByTestId("autopilot");
  for (const s of ["ETH-USD", "SPY"]) await ap.getByRole("button", { name: s, exact: true }).click();   // leave BTC-USD only
  await ap.getByRole("button", { name: "Start" }).click();
  await expect(ap.getByText("running")).toBeVisible();
  await ap.getByRole("button", { name: "Run cycle now" }).click();
  await expect(ap.getByTestId("cycle-result")).toContainText("BTC-USD");
  await ap.getByRole("button", { name: "Emergency stop" }).click();
  await page.locator("dialog").getByRole("button", { name: "Confirm emergency stop" }).click();
  await expect(page.getByTestId("risk-status")).toContainText("kill switch is engaged");
  await expect(ap.getByText("stopped")).toBeVisible();
  await page.getByRole("button", { name: "Release" }).click();
}

// Shared with the static demo spec (kept in sync manually). Expects tradeFlow to have run first.
async function analyticsFlow(page: import("@playwright/test").Page) {
  await page.goto("app/analytics?period=all");
  await expect(page.getByTestId("perf-metrics")).toContainText("Return (TWR)");
  await expect(page.getByText(/need at least 20/)).toBeVisible();
  await page.getByRole("tab", { name: "Trades" }).click();
  await expect(page.getByTestId("trade-stats")).toContainText("Closed trades");
  await expect(page.getByRole("cell", { name: "BTC-USD" }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Execution" }).click();
  await expect(page.getByTestId("execution-stats")).toContainText("All-in cost");
  await expect(page.getByTestId("rejections")).toContainText("Insufficient cash");
  await page.getByRole("tab", { name: "Risk" }).click();
  await expect(page.getByText("Gate decisions")).toBeVisible();
  await page.getByRole("tab", { name: "AI quality" }).click();
  await expect(page.getByTestId("ai-stats")).toContainText("Signal edge");
  await page.getByRole("tab", { name: "Report" }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByTestId("report-hash")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("report")).toContainText("Ledger balanced");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Round trips (CSV)" }).click();
  expect((await download).suggestedFilename()).toMatch(/^aurex-trades-all-\d{8}\.csv$/);
}

// RFC 6238 code for a base32 secret (used to act as the user's authenticator app).
function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/\s/g, "").toUpperCase()) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", key).update(msg).digest();
  const o = d[d.length - 1]! & 0x0f;
  return String((d.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Shared with the other spec (kept in sync manually). Enrols, signs out, signs back in with a code.
async function mfaFlow(page: import("@playwright/test").Page, password: string, signIn: () => Promise<void>) {
  await page.goto("app/settings/security");
  const card = page.getByTestId("two-factor");
  await card.getByRole("button", { name: "Set up two-factor authentication" }).click();
  await card.getByLabel("Confirm your password").fill(password);
  await card.getByRole("button", { name: "Continue" }).click();
  const secret = (await card.getByTestId("mfa-secret").textContent())!.replace(/\s/g, "");
  await card.getByLabel("6-digit code").fill(totpCode(secret));
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card.getByTestId("recovery-codes")).toContainText("will not be shown again");
  await card.getByRole("button", { name: "I have saved them" }).click();
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await page.getByTestId("user-menu").click(); await page.getByRole("menuitem", { name: "Log out" }).click();
  await signIn();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await page.getByLabel("Authentication code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Invalid authentication code")).toBeVisible();
  // the enrolment code's time step is spent (no replay): use the next one, within the drift window
  await page.getByLabel("Authentication code").fill(totpCode(secret, Math.floor(Date.now() / 30_000) + 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
}

// Shared with the static demo spec (kept in sync manually).
async function binaryFlow(page: import("@playwright/test").Page, account?: string) {
  await page.goto("app/binary");
  if (account) await page.getByLabel("Account", { exact: true }).selectOption({ label: account });
  await expect(page.getByRole("note", { name: "Binary options warning" })).toContainText("banned for retail customers in the UK");
  await expect(page.getByTestId("binary-maths")).toContainText("55.6%");
  await expect(page.getByTestId("live-tick-chart")).toBeVisible();
  await page.getByLabel("Instrument", { exact: true }).selectOption("BTC-USD");
  await expect(page.getByTestId("binary-price")).toContainText("Market open");
  await expect(page.locator("#bin-expiry option[value='30']")).toHaveCount(0);     // shortest expiry is 1 minute
  // 2.50 is 2.5% of £100: above the 2% binary stake cap
  await page.getByLabel("Stake (GBP)").fill("2.50");
  await page.getByRole("button", { name: "Open Higher contract" }).click();
  await expect(page.getByText(/binary limit 2%/).first()).toBeVisible();
  await expect(page.getByTestId("risk-checks")).toContainText("Stake (maximum loss)");
  await page.getByLabel("Stake (GBP)").fill("1.00");
  await page.getByRole("button", { name: "Lower", exact: true }).click();
  await page.getByRole("button", { name: "Open Lower contract" }).click();
  await expect(page.getByRole("status")).toContainText("Opened LOWER BTC-USD");
  await expect(page.getByTestId("binary-open-row")).toHaveCount(1);
  await expect(page.getByTestId("binary-stats")).toContainText("£1.00");          // at risk now
  // Switch binaries off in the Risk Centre; new contracts are then refused
  const acct = new URL(page.url()).searchParams.get("account");
  await page.goto(`app/risk?account=${acct}`);
  await page.getByLabel("Allow binary options").click();
  await expect(page.getByLabel("Allow binary options")).not.toBeChecked();
  await page.goto(`app/binary?account=${acct}`);
  await page.getByRole("button", { name: "Open Higher contract" }).click();
  await expect(page.getByText(/binary trading is switched off/).first()).toBeVisible();
  // The one-button AI bot: it refuses to run while binaries are switched off, and says why
  // defaults: BTC and ETH only (real Coinbase prices), so no simulated-prices warning while the feed is live
  await page.getByRole("button", { name: "Start AI bot" }).click();
  await expect(page.getByTestId("bot-status")).toHaveText("PAUSED");
  await expect(page.getByTestId("bot-paused-reason")).toContainText("switched off");
  await page.goto("app/wallet");
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
}
