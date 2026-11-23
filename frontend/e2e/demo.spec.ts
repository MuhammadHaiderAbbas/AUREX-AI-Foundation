import { expect, test } from "@playwright/test";

// Runs against the static GitHub Pages build (VITE_DEMO_MODE=true). Set AUREX_E2E_DEMO=1.
test.skip(!process.env.AUREX_E2E_DEMO, "demo build only");

test("static demo: launch, markets, wallet, admin, deep links", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("login");
  await expect(page.getByText("Public demo.")).toBeVisible();
  await page.getByRole("button", { name: "Launch demo" }).click();
  await expect(page.getByRole("heading", { name: "Demo Trader" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Demo paper account" })).toBeVisible();
  await expect(page.getByText("US$100,000.00").first()).toBeVisible();

  // Markets: synthetic data clearly labelled, chart renders, indicators toggle
  await page.getByRole("link", { name: "Markets", exact: true }).click();
  await expect(page.getByText("Synthetic data")).toBeVisible();
  await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
  await page.getByRole("tab", { name: "Forex" }).click();
  await page.getByRole("button", { name: /^GBP\/USD British/ }).click();
  await expect(page).toHaveURL(/symbol=GBPUSD/);
  await page.getByRole("button", { name: "1d" }).click();
  await expect(page.getByText(/\d+ candles · source Synthetic/)).toBeVisible();

  // Wallet: double-entry ledger in the browser
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.getByLabel("Amount (USD)").fill("250");
  await page.getByRole("button", { name: "Deposit virtual cash" }).click();
  await expect(page.getByText("Deposited US$250.00")).toBeVisible();

  // First demo user is admin: audit chain verifies
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact — \d+ records verified/)).toBeVisible();

  // Research Lab: the demo user starts with the fictional sample corpus
  await page.getByRole("link", { name: "AI Research Lab" }).click();
  await page.getByRole("button", { name: /outlook for Northwind/ }).click();
  await expect(page.getByText("Verified facts")).toBeVisible();
  await expect(page.getByText("Contradictory evidence")).toBeVisible();
  await expect(page.getByText("Cites the fictional sample corpus; not real market information.")).toBeVisible();
  await page.getByRole("tab", { name: "Corpus" }).click();
  await page.getByRole("button", { name: "Add document" }).click();
  await page.getByLabel("Title").fill("Desk memo on GBP/USD");
  await page.getByLabel("Text", { exact: true }).fill("Sterling weakened after softer inflation data, and traders now expect GBP/USD volatility to stay elevated.");
  await page.getByLabel("Source").fill("Demo desk");
  await page.locator("dialog").getByRole("button", { name: "Index document" }).click();
  await expect(page.getByText(/Indexed “Desk memo on GBP\/USD”/)).toBeVisible();
  await page.locator("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^Desk memo on GBP\/USD Demo desk/ })).toBeVisible();

  // Agent department in the browser: run, explained decision, all eight agents
  await page.getByRole("link", { name: "AI Trading" }).click();
  await page.getByLabel("Instrument").selectOption("EUR/USD");
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByTestId("decision")).toHaveText(/BUY|NO TRADE/);
  for (const a of ["technical", "quant", "regime", "news", "portfolio", "risk"]) await expect(page.getByTestId(`agent-${a}`)).toBeVisible();
  await expect(page.getByTestId("agent-news")).not.toContainText("Error");

  // Model Lab in the browser: logistic regression with walk-forward validation
  await page.getByRole("link", { name: "Model Lab" }).click();
  await page.getByLabel("Instrument").selectOption("EUR/USD");
  await page.getByLabel("Algorithm").selectOption("logistic");
  await page.getByLabel("History").selectOption("60");
  await page.getByRole("button", { name: "Train & validate" }).click();
  await expect(page.getByTestId("gates")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("gates")).toContainText("Plausible performance");
  await expect(page.getByRole("button", { name: "Promote" })).toBeDisabled();
  await page.getByRole("button", { name: "Drift check" }).click();
  await expect(page.getByText(/max PSI/)).toBeVisible();

  // Backtesting in the browser
  await page.getByRole("link", { name: "Backtesting" }).click();
  await page.getByLabel("Strategy").selectOption("donchian_breakout");
  await page.getByLabel("Instrument").selectOption("BTC-USD");
  await page.getByLabel("Period").selectOption("90");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(page.getByTestId("metrics-table")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("oos-headline")).toContainText("Sharpe");

  // Paper execution in the browser
  await tradeFlow(page);

  // Deep link + reload survives (SPA fallback + persisted session)
  await page.goto("markets?symbol=AAPL");
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("price-chart")).toBeVisible();

  expect(errors).toEqual([]);
});

// Shared with the static demo spec (kept in sync manually: Playwright specs don't share imports here).
async function tradeFlow(page: import("@playwright/test").Page) {
  await page.goto("markets?symbol=BTC-USD");
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

  await page.getByRole("link", { name: "Trade History", exact: true }).click();
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

  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await expect(page.getByText("Trade · sell")).toBeVisible();
  await expect(page.getByText(/^Sell 0.05 BTC-USD @/)).toBeVisible();
}
