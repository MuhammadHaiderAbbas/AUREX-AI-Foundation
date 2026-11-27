// GitHub Pages serves 404.html (with HTTP status 404) for unknown paths. Give every route its own copy
// of index.html so deep links (/markets, /app/trade, /admin/users, ...) answer 200; keep 404.html for the rest.
import { copyFileSync, mkdirSync } from "node:fs";

const PUBLIC = ["markets", "ai-trading", "security", "about", "legal/terms", "legal/privacy", "legal/risk", "login", "register"];
const APP = ["", "trade", "ai", "research", "portfolio", "history", "analytics", "wallet", "risk", "backtests", "binary",
  "settings", "settings/profile", "settings/security", "settings/accounts"].map((r) => (r ? `app/${r}` : "app"));
const ADMIN = ["", "controls", "users", "models", "agents", "research"].map((r) => (r ? `admin/${r}` : "admin"));
const LEGACY = ["wallet", "portfolio", "history", "risk", "analytics", "settings", "backtests", "binary", "research", "strategies", "operations"];

const routes = [...new Set([...PUBLIC, ...APP, ...ADMIN, ...LEGACY])];
for (const r of routes) {
  mkdirSync(`dist/${r}`, { recursive: true });
  copyFileSync("dist/index.html", `dist/${r}/index.html`);
}
copyFileSync("dist/index.html", "dist/404.html");
console.log(`spa-routes: ${routes.length} routes`);
