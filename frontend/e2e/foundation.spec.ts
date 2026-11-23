import { expect, test } from "@playwright/test";

const PASSWORD = "Correct-Horse-42";

test.describe.configure({ mode: "serial" });
test.skip(!!process.env.AUREX_E2E_DEMO, "requires the API backend");

test("register, fund a paper account, move virtual cash, persist session", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("E2E Trader");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "E2E Trader" })).toBeVisible();
  await expect(page.getByText("Paper mode")).toBeVisible();
  await expect(page.getByText("No paper accounts yet")).toBeVisible();

  // Create a paper account with the default virtual balance
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.getByLabel("Account name").fill("Alpha paper");
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Alpha paper" })).toBeVisible();
  await expect(page.getByText("US$100,000.00").first()).toBeVisible();

  // Wallet: deposit then attempt an overdraw
  await page.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.getByLabel("Amount (USD)").fill("2500.50");
  await page.getByRole("button", { name: "Deposit virtual cash" }).click();
  await expect(page.getByText("Deposited US$2,500.50")).toBeVisible();
  await expect(page.getByText("Virtual deposit").first()).toBeVisible();

  await page.getByRole("tab", { name: "Withdraw" }).click();
  await page.getByLabel("Amount (USD)").fill("999999");
  await page.getByRole("button", { name: "Withdraw virtual cash" }).click();
  await expect(page.getByRole("alert")).toContainText("Insufficient virtual cash");

  // Session survives a reload via the httpOnly refresh cookie
  await page.reload();
  await expect(page.getByText("Ledger balanced (debits = credits)")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Virtual deposit").first()).toBeVisible();

  // Placeholder modules are clearly labelled
  await page.getByRole("link", { name: /Risk Centre/ }).click();
  await expect(page.getByText("scheduled for Phase 9")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/wallet");
  await expect(page).toHaveURL(/\/login$/);
});

test("admin can verify the audit chain", async ({ page }) => {
  test.skip(!process.env.AUREX_E2E_ADMIN_EMAIL, "set AUREX_E2E_ADMIN_EMAIL / AUREX_E2E_ADMIN_PASSWORD");
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.AUREX_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText(/Chain intact — \d+ records verified/)).toBeVisible();
});

test("non-admin users do not see administration", async ({ page }) => {
  const email = `e2e-u-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Plain User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Plain User" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/);
});

test("markets stream live quotes and render charts", async ({ page }) => {
  const email = `e2e-m-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Market User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Market User" })).toBeVisible();
  await expect(page.getByText("Watchlist").first()).toBeVisible();

  await page.getByRole("link", { name: "Markets", exact: true }).click();
  await expect(page.getByText("Streaming")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
  await page.getByRole("tab", { name: "ETFs" }).click();
  await page.getByRole("button", { name: "Add QQQ to watchlist" }).click();
  await expect(page.getByRole("button", { name: "Remove QQQ from watchlist" })).toBeVisible();
  await page.getByRole("button", { name: /^QQQ Invesco/ }).click();
  await expect(page.getByTestId("last-price")).not.toHaveText("—");
});

test("research lab: corpus, grounded report with citations", async ({ page }) => {
  test.skip(!process.env.AUREX_E2E_ADMIN_EMAIL, "needs an admin to load the corpus");
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.AUREX_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.AUREX_E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "AI Research Lab" }).click();
  await page.getByRole("tab", { name: "Corpus" }).click();
  await page.getByRole("button", { name: "Load sample corpus" }).click();
  await expect(page.getByText(/\d+ indexed/)).toBeVisible();
  await expect(page.getByText("Fictional sample").first()).toBeVisible();

  await page.getByRole("tab", { name: "Research" }).click();
  await page.getByLabel("Research question").fill("What did the central bank decide on the policy rate?");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Verified facts")).toBeVisible();
  await expect(page.getByText("Interpretation (automated heuristic)")).toBeVisible();
  await expect(page.getByRole("meter", { name: "Evidence confidence" })).toBeVisible();
  await page.getByRole("button", { name: "Source 1" }).first().click();
  await expect(page.getByText(/voted seven to two/).last()).toBeVisible();

  await page.getByLabel("Research question").fill("volcanic eruptions in Iceland tourism");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByText("Insufficient evidence", { exact: true })).toBeVisible();
});

test("agent desk: run analysis, explained decision, evidence", async ({ page }) => {
  const email = `e2e-ai-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Agent User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "New paper account" }).click();
  await page.locator("dialog").getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Main paper account" })).toBeVisible();

  await page.getByRole("link", { name: "AI Trading" }).click();
  await page.getByLabel("Instrument").selectOption("ETH-USD");
  await page.getByRole("button", { name: "Run analysis" }).click();
  const decision = page.getByTestId("decision");
  await expect(decision).toHaveText(/BUY|NO TRADE/);
  if ((await decision.textContent())?.includes("NO TRADE")) await expect(page.getByText("Why no trade")).toBeVisible();
  else await expect(page.getByTestId("proposal")).toBeVisible();
  for (const a of ["technical", "quant", "regime", "fundamental", "news", "sentiment", "portfolio", "risk"]) {
    await expect(page.getByTestId(`agent-${a}`)).toBeVisible();
  }
  await expect(page.getByTestId("agent-fundamental")).toContainText("Abstained");
  await page.getByTestId("agent-technical").getByRole("button", { name: /Evidence/ }).click();
  await expect(page.getByText("RSI(14)")).toBeVisible();
  await expect(page.getByText(/ETH-USD · (BUY|No trade)/)).toBeVisible();
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page.getByText("Risk Agent")).toBeVisible();
});
