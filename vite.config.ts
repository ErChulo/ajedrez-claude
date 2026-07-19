import { defineConfig } from "vite";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Adds COOP `same-origin` + COEP `credentialless` to every response served
 * by Vite's dev + preview middleware. This re-enables `SharedArrayBuffer`
 * and the `crossOriginIsolated` document feature in the browser, which
 * Stockfish's pthread-compiled WASM (`shared: !0` in the Emscripten
 * `WebAssembly.Memory` call inside public/stockfish.js) requires to boot.
 * Without these headers the eager probe times out and the app falls back
 * to "⚠ Random" even though Stockfish is fine.
 *
 * Production deployments should set the same two headers via their host
 * (Netlify `_headers`, Vercel `vercel.json`, Cloudflare Workers, etc.).
 */
const crossOriginIsolation = (): Plugin => ({
  name: "cross-origin-isolation",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
      next();
    });
  },
});

export default defineConfig({
  plugins: [crossOriginIsolation()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          gsap: ["gsap"],
          chess: ["chess.js"],
        },
      },
    },
  },
  worker: {
    format: "es",
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    // Exclude playwright config + e2e tests + report dirs so vitest stays in
    // jsdom unit-test land and never tries to load Playwright/Test runner.
    exclude: [
      "node_modules/**",
      "dist/**",
      ".git/**",
      "./e2e/**",
      "./playwright-report/**",
      "./test-results/**",
      "./playwright.config.ts",
    ],
  },
});
