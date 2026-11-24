/* Records a captioned video walkthrough of the static demo.
 *
 *   node scripts/record-walkthrough.cjs <demo-url> <output-dir>
 *   e.g. node scripts/record-walkthrough.cjs https://muhammadhaiderabbas.github.io/AUREX-AI-Foundation/ ./video
 *
 * Produces <output-dir>/aurex-walkthrough.webm (convert with ffmpeg if you need mp4). The
 * captions match docs/video/walkthrough.md. Each scene is independent: if one fails (for
 * example a market is closed), it is logged and the recording carries on.
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://localhost:4173/AUREX-AI-Foundation/").replace(/\/?$/, "/");
const OUT = path.resolve(process.argv[3] || "video");
const W = 1280, H = 720;

const OVERLAY = () => {
  const ensure = (id, css) => {
    let el = document.getElementById(id);
    if (!el) { el = document.createElement("div"); el.id = id; el.style.cssText = css; document.documentElement.appendChild(el); }
    return el;
  };
  window.__cap = (title, body) => {
    const el = ensure("__cap", "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;max-width:1080px;width:calc(100% - 80px);" +
      "background:rgba(8,12,20,.92);color:#e8edf5;border:1px solid rgba(229,180,84,.55);border-radius:12px;padding:12px 18px;pointer-events:none;" +
      "font:15px/1.45 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)");
    el.innerHTML = `<div style="font-weight:700;color:#e5b454;letter-spacing:.04em;font-size:13px;text-transform:uppercase;margin-bottom:3px">${title}</div><div>${body}</div>`;
    el.style.display = title ? "block" : "none";
  };
  window.__card = (title, sub, items) => {
    const el = ensure("__card", "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:radial-gradient(circle at 30% 20%,#1b2540,#070a12 70%);color:#e8edf5;font-family:Inter,system-ui,sans-serif");
    el.innerHTML = `<div style="max-width:920px;padding:40px">
      <div style="font-size:54px;font-weight:800;letter-spacing:.16em">AUREX <span style="color:#e5b454">AI</span></div>
      <div style="font-size:26px;margin-top:10px;font-weight:600">${title}</div>
      <div style="font-size:17px;margin-top:10px;color:#a7b0c0">${sub}</div>
      ${items ? `<ul style="margin-top:22px;font-size:16px;line-height:1.7;color:#cdd5e2;padding-left:22px">${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : ""}
    </div>`;
    el.style.display = "flex";
  };
  window.__hideCard = () => { const el = document.getElementById("__card"); if (el) el.style.display = "none"; };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: "dark" });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  const wait = (ms) => page.waitForTimeout(ms);
  const say = (title, body) => page.evaluate(([t, b]) => window.__cap(t, b), [title, body]);
  const card = (title, sub, items) => page.evaluate(([t, s, i]) => window.__card(t, s, i), [title, sub, items]);
  const nav = (name) => page.getByRole("link", { name, exact: true }).click();
  const failed = [];
  const scene = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); } catch (e) { failed.push(`${name}: ${String(e.message).split("\n")[0]}`); }
    console.log(`${name.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };

  await page.goto(BASE + "login");

  await scene("01 title", async () => {
    await card("Autonomous multi-market research and paper-trading platform",
      "Crypto · Forex · Stocks · ETFs · Binary options simulator — virtual capital only",
      ["FastAPI + PostgreSQL backend, React trading terminal", "AI agent department, quant models, backtesting, risk engine",
       "Double-entry ledger, tamper-evident audit trail, live streaming", "This recording uses the public in-browser demo"]);
    await wait(7000);
    await page.evaluate(() => window.__hideCard());
  });

  await scene("02 launch", async () => {
    await say("Sign in", "One click creates a demo trader with a <b>£100 GBP</b> paper account. The demo runs entirely in your browser; the real system runs the FastAPI backend.");
    await wait(3500);
    await page.getByRole("button", { name: "Launch demo with £100" }).click();
    await page.getByRole("heading", { name: "Demo Trader" }).waitFor();
  });

  await scene("03 overview", async () => {
    await say("Overview", "The <b>LIVE</b> badge shows the account stream. Equity is marked to market on live prices every 2 seconds; the chart below grows in real time.");
    await page.getByTestId("portfolio-chart").waitFor({ timeout: 15000 }).catch(() => {});
    await wait(6000);
  });

  await scene("04 markets", async () => {
    await nav("Markets");
    await say("Markets", "Crypto, FX, stocks and ETFs with session calendars and stale-quote rules. The last candle ticks with every quote; indicators are computed server-side.");
    await page.getByTestId("price-chart").waitFor();
    await wait(4000);
    await page.getByRole("button", { name: "5m" }).click().catch(() => {});
    await wait(3500);
    await page.getByRole("tab", { name: "Forex" }).click();
    await page.getByRole("button", { name: /^GBP\/USD British/ }).click();
    await say("Markets · Forex", "Switching instrument keeps everything live. Stocks and ETFs follow real exchange hours, so they show as closed outside them.");
    await wait(4500);
  });

  await scene("05 paper order", async () => {
    await page.goto(BASE + "markets?symbol=BTC-USD");
    await page.getByRole("button", { name: "Buy", exact: true }).click();
    const d = page.locator("dialog");
    await say("Paper order", "Fractional quantities make a £100 account usable: 0.0001 BTC. Every order passes business checks and the independent risk gate before it fills on the live ask.");
    await d.getByLabel("Quantity").fill("0.0001");
    await wait(2500);
    await d.getByRole("button", { name: "Place paper buy order" }).click();
    await page.getByTestId("order-result").waitFor();
    await wait(4000);
    await d.getByRole("button", { name: "Close dialog" }).click();
  });

  await scene("06 ai trading", async () => {
    await nav("AI Trading");
    await say("AI agent department", "Technical, quant, regime, news, sentiment, fundamental, portfolio and risk agents each report evidence. A consensus engine decides, with explicit NO-TRADE rules.");
    await page.locator("#ai-sym").selectOption("ETH-USD");
    await page.getByRole("button", { name: "Run analysis" }).click();
    await page.getByTestId("decision").waitFor({ timeout: 30000 });
    await wait(5500);
    await page.mouse.wheel(0, 600);
    await wait(3000);
  });

  await scene("07 research", async () => {
    await nav("AI Research Lab");
    await say("AI Research Lab", "Hybrid vector + full-text retrieval over ingested documents. Reports separate verified, quote-checked facts from interpretation and flag contradictions.");
    await page.getByRole("button", { name: /outlook for Northwind/ }).click();
    await page.getByText("Verified facts").waitFor({ timeout: 20000 });
    await wait(5500);
  });

  await scene("08 model lab", async () => {
    await nav("Model Lab");
    await say("Model Lab", "Leak-free features, purged walk-forward validation against baselines after costs, and nine promotion gates. Models are promoted only by a human.");
    await page.getByLabel("Instrument").selectOption("BTC-USD");
    await page.getByLabel("Algorithm").selectOption("logistic");
    await page.getByLabel("History").selectOption("60");
    await page.getByRole("button", { name: "Train & validate" }).click();
    await page.getByTestId("gates").waitFor({ timeout: 60000 });
    await wait(5000);
  });

  await scene("09 backtesting", async () => {
    await nav("Backtesting");
    await say("Backtesting", "Event-driven simulation with latency, spread, slippage, fees, gaps and breakers. Parameters are optimised in-sample, then judged once out-of-sample against buy & hold.");
    await page.getByLabel("Strategy").selectOption("sma_crossover");
    await page.getByLabel("Instrument").selectOption("BTC-USD");
    await page.getByLabel("Period").selectOption("90");
    await page.getByRole("button", { name: "Run backtest" }).click();
    await page.getByTestId("metrics-table").waitFor({ timeout: 60000 });
    await wait(5500);
  });

  await scene("10 binary", async () => {
    await nav("Binary Options");
    await say("Binary options simulator", "HIGHER / LOWER contracts with an 80% payout: you must win <b>55.6%</b> just to break even. Paper only — banned for UK retail customers (FCA, 2019).");
    await page.getByTestId("live-tick-chart").waitFor({ timeout: 15000 });
    await wait(4500);
    await page.getByRole("button", { name: "Open Higher contract" }).click();
    await say("Binary options · live", "The contract's strike is drawn on the live chart. The countdown runs, the status flips in or out of the money, and settlement posts to the ledger automatically.");
    await wait(9000);
  });

  await scene("11 portfolio", async () => {
    await nav("Portfolio");
    await say("Portfolio", "Positions marked to the live bid, binary stakes at risk, allocation by asset class, and an equity curve that extends every 2 seconds.");
    await wait(7000);
  });

  await scene("12 risk", async () => {
    await nav("Risk Centre");
    await say("Risk Centre", "Limits for risk per trade, position size, exposure, daily loss and drawdown breakers, binary stake caps, kill switches and the autopilot — every decision is recorded.");
    await wait(4000);
    await page.mouse.wheel(0, 700);
    await wait(3500);
  });

  await scene("13 history & wallet", async () => {
    await nav("Trade History");
    await say("Trade history", "Every order with its full event timeline and the risk checks it passed or failed.");
    await wait(4000);
    await nav("Wallet");
    await say("Wallet", "Balances come from a double-entry ledger: every fill, fee, binary stake and payout is a balanced transaction.");
    await wait(4500);
  });

  await scene("14 analytics", async () => {
    await nav("Analytics");
    await say("Analytics", "Time-weighted returns, Sharpe, Sortino, drawdown, execution cost in basis points, risk-gate summaries and AI signal quality, with hashed reports and CSV exports.");
    await wait(6000);
  });

  await scene("15 admin & ops", async () => {
    await nav("Administration");
    await page.getByRole("button", { name: "Verify chain" }).click();
    await say("Security and operations", "A hash-chained audit trail that verifies end to end, TOTP two-factor auth, external anchoring, backups with restore drills, and go-live gates.");
    await wait(4000);
    await nav("Operations");
    await wait(4500);
  });

  await scene("16 closing", async () => {
    await say("", "");
    await card("Paper trading only — by design",
      "Live trading is disabled in code. Go-live gates report readiness; they do not switch anything on.",
      ["Try it: muhammadhaiderabbas.github.io/AUREX-AI-Foundation", "Code: github.com/MuhammadHaiderAbbas/AUREX-AI-Foundation",
       "Binary options are a simulator only (banned for UK retail customers)", "Not investment advice"]);
    await wait(7000);
  });

  const video = page.video();
  await context.close();
  await browser.close();
  const src = await video.path();
  const dst = path.join(OUT, "aurex-walkthrough.webm");
  fs.renameSync(src, dst);
  console.log(`\nvideo: ${dst}`);
  if (failed.length) console.log("scenes with problems:\n  " + failed.join("\n  "));
})();
