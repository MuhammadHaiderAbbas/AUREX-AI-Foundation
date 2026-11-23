import { expect, test } from "@playwright/test";

const PASSWORD = "Correct-Horse-42";

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
