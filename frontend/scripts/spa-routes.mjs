// GitHub Pages serves 404.html (with HTTP status 404) for unknown paths. Give every app route its
// own copy of index.html so deep links like /markets answer 200, and keep 404.html for the rest.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const routes = [...app.matchAll(/path="([a-z-]+)"/g), ...app.matchAll(/path="\/([a-z-]+)"/g)].map((m) => m[1]);
for (const r of new Set(routes)) {
  mkdirSync(`dist/${r}`, { recursive: true });
  copyFileSync("dist/index.html", `dist/${r}/index.html`);
}
copyFileSync("dist/index.html", "dist/404.html");
console.log(`spa-routes: ${new Set(routes).size} routes`);
