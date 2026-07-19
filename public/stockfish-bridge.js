/* Stockfish bridge worker — classic-script, hand-written, NOT bundled by Vite.
 *
 * Why a classic worker?  Vite's worker pipeline (worker.format = "es" + the
 * `new Worker(url, { type: "module" })` invocations elsewhere) bans
 * `importScripts` per HTML spec — calling it from a module worker throws
 * "Not allowed: importScripts()".  Placing this file under public/ and
 * constructing the worker WITHOUT `{ type: "module" }` puts it in the
 * classic-worker scope where `importScripts` is supported, and Vite serves
 * the file verbatim (no bundling).
 *
 * Why a command queue?  The Stockfish bootstrap path:
 *     importScripts("/stockfish.js")   // ~150 ms
 *     Stockfish({ locateFile: ... })    // ~50 ms (JS init only)
 *     await engine.ready               // ~hundreds of ms (WASM compile/load)
 * takes well over the main-thread's 2.5 s probe budget IF commands posted
 * during the window were silently dropped.  Without buffering, `uci` posted
 * during boot would arrive at `self.onmessage` before `engine` was bound
 * and would be discarded — the main-thread probe would then time out and
 * fall back to "⚠ Random" even though Stockfish is fine.  We queue every
 * command during boot and drain in order once the engine is bound.
 *
 * v1.8 follow-up: removed the dead `engineReady` boolean flag (verified per
 * code-review) and re-ordered the bootstrap so:
 *     1. bindEngine (listener wired, engineLinesBound = true)
 *     2. await inst.ready (WASM compile settles — the shim's
 *        engine.postMessage() internally queues until postRun regardless,
 *        but awaiting the documented Promise is the safe play)
 *     3. drain pendingCommands
 *     4. post "worker_loaded"
 *
 * File lineage:
 *   public/stockfish.js       — vendored shim
 *   public/stockfish.wasm     — vendored binary
 *   public/stockfish-bridge.js — this file
 *
 * Vendored assets stay in lockstep with node_modules/stockfish.wasm via
 * scripts/sync-stockfish.mjs postinstall.
 */

/* global self, importScripts, Stockfish */

(function () {
  "use strict";

  /** Queue of UCI commands that arrived while the engine was bootstrapping.
   * Drained in FIFO order once the engine is fully ready. */
  var pendingCommands = [];

  var engine = null;
  var engineLinesBound = false;
  var loadFailed = false;

  function post(line) {
    try { self.postMessage(line); } catch (_) { /* worker torn down */ }
  }

  function bindEngine(e) {
    engine = e;
    if (typeof e.addMessageListener === "function") {
      e.addMessageListener(function (line) { post(line); });
      engineLinesBound = true;
    }
  }

  /** Drain any UCI commands posted during the boot window, in FIFO order. */
  function drainPending() {
    if (pendingCommands.length === 0 || !engineLinesBound) return;
    var drain = pendingCommands;
    pendingCommands = [];
    for (var i = 0; i < drain.length; i++) {
      try { engine.postMessage(drain[i]); } catch (_) { /* engine may be mid-reinit */ }
    }
  }

  self.onmessage = function (ev) {
    var cmd = typeof ev.data === "string" ? ev.data : "";
    if (!cmd) return;

    if (loadFailed) {
      // Degraded mode — pretend to be a UCI engine that returns no moves
      // so the main thread gives up quickly and falls back to FallbackAI.
      if (cmd === "uci") post("uciok");
      else if (cmd === "isready") post("readyok");
      else if (cmd.indexOf("go") === 0) post("bestmove (none)");
      return;
    }

    if (!engine || !engineLinesBound) {
      pendingCommands.push(cmd);
      return;
    }
    try { engine.postMessage(cmd); } catch (_) { /* engine may be mid-reinit */ }
  };

  (async function bootstrap() {
    try {
      // 1. Load the shim into the worker scope as a classic script. Vite
      //    serves /stockfish.js verbatim from public/.
      importScripts("/stockfish.js");
      var factory = self.Stockfish;
      if (typeof factory !== "function") {
        throw new Error("Stockfish global missing after importScripts");
      }

      // 2. Instantiate the engine.
      //
      //    Two things to know about this stockfish.wasm@^0.10.0 shim:
      //
      //    a. **MODULARIZE-thunked**: the factory body ends with
      //       `return Stockfish.ready`, where
      //       `Stockfish.ready = new Promise((resolve) => ia(z))` is
      //       resolved by Emscripten runtime-init once WASM compiles.
      //       So `factory({...})` returns the ready **Promise**, NOT the
      //       module. Without `await`, `inst.addMessageListener` is
      //       undefined, `bindEngine` does nothing, `engineLinesBound`
      //       stays `false`, the drain in step 5 is a no-op, and the
      //       main-thread probe silently times out and falls back to
      //       "⚠ Random" even though Stockfish booted fine. Awaiting it
      //       gives us the module post-WASM-init.
      //
      //    b. **locateFile must forward the requested path**: Emscripten
      //       calls `locateFile` for both the main binary (path ==
      //       `stockfish.wasm`) AND for pthread sat-workers (path ==
      //       `stockfish.worker.js`). Returning a hard-coded
      //       `/stockfish.wasm` here previously sent the browser to fetch
      //       the WASM binary as a JS worker; the parse failed with an
      //       empty ErrorEvent, which Emscripten logs as
      //         "pthread sent an error! undefined:undefined: undefined".
      //       Forwarding `path` lets Emscripten satisfy both requests
      //       from public/ (the worker file is vendored by
      //       scripts/sync-stockfish.mjs alongside the shim + binary).
      //
      //    c. **mainScriptUrlOrBlob**: pthread workers re-import
      //       /stockfish.js. Inside that re-execution, the shim detects
      //       ENVIRONMENT_IS_PTHREAD (set by Emscripten's Worker
      //       constructor `{ name: "em-pthread" }`) and joins the
      //       SharedArrayBuffer-backed heap instead of re-initiating
      //       the main module. Without this hint Emscripten's
      //       PThread.loadWasmModuleToWorker falls back to
      //       `_scriptDir + 'stockfish.worker.js'`, where `_scriptDir`
      //       is `document.currentScript.src` (undefined in worker
      //       scope), so the fallback computes an invalid URL.
      var inst = await factory({
        locateFile: function (path) { return "/" + path; },
        // pthread shim spawns secondary Workers via PThread.loadWasmModuleToWorker
        // which defaults to `_scriptDir + 'stockfish.worker.js'`. `_scriptDir`
        // is `document.currentScript.src` — undefined inside a worker scope —
        // so Emscripten has nowhere to spawn from and logs
        //   "pthread sent an error! undefined:undefined: undefined"
        // Telling it our shim's URL explicitly puts pthread workers on
        // /stockfish.js (same-origin, same COOP/COEP context), at which
        // point each worker re-imports the shim, sees ENVIRONMENT_IS_PTHREAD,
        // and joins the SharedArrayBuffer-backed heap.
        mainScriptUrlOrBlob: "/stockfish.js",
      });
      if (!inst) throw new Error("Stockfish() resolved to a falsy module");

      // 3. Wire the engine → main-thread line bridge FIRST so any uciok /
      //    readyok emitted during the wait below reaches the main thread.
      bindEngine(inst);

      // 4. (No separate `await inst.ready` needed — step 2 already awaited
      //    the same Promise, so WASM init has settled before we reach here.)

      // 5. Drain UCI commands posted during the boot window.
      drainPending();

      // 6. Signal worker readiness so the main-thread probe can move past
      //    its bootstrap phase.
      post("worker_loaded");
    } catch (err) {
      // Belt-and-braces diagnostic visibility: any future shim / pthread /
      // SharedArrayBuffer / locateFile regression surfaces here instead of
      // silently timing out the main-thread probe. The message is mirrored
      // to the main thread as `engine_load_failed` for the probe to act on,
      // while the worker console keeps the actual cause for human eyes.
      try { console.error("[stockfish-bridge] boot failed:", err && err.message ? err.message : err); } catch (_) { /* worker may be terminating */ }
      loadFailed = true;
      post("engine_load_failed");
    }
  })();
})();
