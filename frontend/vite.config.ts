import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the demo from /<repo>/; everything else uses the root.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    host: true,
    // Same-origin API in dev so the httpOnly refresh cookie works without CORS.
    proxy: { "/api": { target: process.env.AUREX_API_URL ?? "http://localhost:8000", changeOrigin: false, ws: true } },
  },
});
