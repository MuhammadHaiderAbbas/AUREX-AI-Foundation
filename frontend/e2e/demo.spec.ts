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

  // Deep link + reload survives (SPA fallback + persisted session)
  await page.goto("markets?symbol=AAPL");
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("price-chart")).toBeVisible();

  expect(errors).toEqual([]);
});
