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

  // Deep link + reload survives (SPA fallback + persisted session)
  await page.goto("markets?symbol=AAPL");
  await expect(page.getByText("Apple Inc.").first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("price-chart")).toBeVisible();

  expect(errors).toEqual([]);
});
