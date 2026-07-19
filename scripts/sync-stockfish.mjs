#!/usr/bin/env node
// Sync the Stockfish binary + shim from node_modules into public/.
// Run on `postinstall` so the vendored assets stay in lockstep with the
// installed dep version.  Without this, public/stockfish.{js,wasm} would
// silently drift whenever `npm install` happens.
//
// Idempotent — re-running is a no-op if the destination already matches.
// If node_modules/stockfish.wasm is missing (e.g., a fresh checkout
// before `npm install`), the script logs a warning and exits 0 so the
// surrounding install isn't aborted — the user gets a clean message and
// can re-run `npm install` to populate the source.

import { cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(here, "..");
const src = resolve(root, "node_modules/stockfish.wasm");
const pub = resolve(root, "public");

if (!existsSync(src)) {
  console.warn(
    "[sync-stockfish] node_modules/stockfish.wasm not found; skipping sync. " +
      "Run `npm install` to populate, and re-run `npm run sync:stockfish`."
  );
  process.exit(0);
}

mkdirSync(pub, { recursive: true });
// stockfish.worker.js is the secondary worker script that Emscripten's
// pthread init spawns via PThread.loadWasmModuleToWorker. Without it
// Emscripten fetches the WASM binary as a worker script and the browser
// fails to parse it, surfacing in the console as
//   "pthread sent an error! undefined:undefined: undefined".
for (const f of ["stockfish.js", "stockfish.wasm", "stockfish.worker.js"]) {
  cpSync(resolve(src, f), resolve(pub, f));
  console.log(`[sync-stockfish] copied ${f} → public/${f}`);
}
