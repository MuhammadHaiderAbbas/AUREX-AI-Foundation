import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * GitHub Pages cannot send response headers, so the static demo carries its Content-Security-Policy
 * in a <meta> tag (frame-ancestors cannot be set this way; Pages pages can be framed). The full
 * deployment sets a stricter CSP header in Caddy instead.
 */
const DEMO_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com",
  "font-src 'self'", "connect-src 'self' https://api.exchange.coinbase.com wss://ws-feed.exchange.coinbase.com https://api.coinbase.com https://api.coingecko.com https://api.frankfurter.dev", "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join("; ");
const demoCsp = (): Plugin => ({
  name: "aurex-demo-csp",
  apply: "build",
  transformIndexHtml: (html) => process.env.VITE_DEMO_MODE === "true"
    ? html.replace("<meta charset=\"UTF-8\" />", `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}" />\n    <meta name="referrer" content="no-referrer" />`)
    : html,
});

export default defineConfig({
  // GitHub Pages serves the demo from /<repo>/; everything else uses the root.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss(), demoCsp()],
  // Never inline fonts as data: URIs, so the CSP can keep font-src 'self'.
  build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    host: true,
    // Same-origin API in dev so the httpOnly refresh cookie works without CORS.
    proxy: { "/api": { target: process.env.AUREX_API_URL ?? "http://localhost:8000", changeOrigin: false, ws: true } },
  },
});
