// Stockfish manager — main-thread facade + deterministic fallback.
//
//   - StockfishAI: spawns a worker that loads `stockfish.wasm`; communicates
//     over UCI via postMessage.
//   - FallbackAI:   if Stockfish fails to bootstrap (offline, missing wasm),
//     we still answer moves. We prefer captures when available, otherwise
//     random from the engine's legal moves. Capture detection uses an
//     expanded FEN walker (not charAt on a compressed rank) — that avoids
//     the FEN-compression pitfall (e.g. rank "4P3" vs file index 4).
//   - createAI():  factory. Eagerly probes Stockfish (Promise resolves after
//     either the engine signals `readyok` or the 2.5 s bootstrap timeout
//     elapses). Returns whichever adapter booted. The chosen adapter's
//     `kind` field is the source of truth for surfacing "Stockfish" vs
//     "Random fallback" in the UI.

import { ChessEngine } from "@/engine/chess";
import type { ApplyMoveInput, AIDifficulty } from "@/types";

export type AIEngineKind = "stockfish" | "fallback";

export interface AIAdapter {
  /**
   * Discriminator for which underlying engine answers moves. Set synchronously
   * in the constructor; surfaced in the UI as an engine-kind badge so the
   * user knows whether they're playing against the real engine or the
   * deterministic capture-preferring fallback.
   */
  readonly kind: AIEngineKind;
  requestMove(fen: string, difficulty: AIDifficulty): Promise<ApplyMoveInput | null>;
  cancel(): void;
  shutdown(): void;
}

const SKILL_BY_LEVEL: Record<AIDifficulty, number> = {
  beginner: 1, easy: 5, intermediate: 10, advanced: 15, expert: 20,
};
const TIME_BY_LEVEL_MS: Record<AIDifficulty, number> = {
  beginner: 200, easy: 400, intermediate: 800, advanced: 1500, expert: 4000,
};

export class StockfishAI implements AIAdapter {
  public readonly kind: AIEngineKind = "stockfish";
  private worker: Worker | null = null;
  private ready = false;
  private startingPromise: Promise<boolean> | null = null;

  async requestMove(fen: string, difficulty: AIDifficulty): Promise<ApplyMoveInput | null> {
    const booted = await this.ensureStarted();
    if (!booted || !this.worker) return null;
    return new Promise((resolve) => {
      const w = this.worker!;
      const skill = SKILL_BY_LEVEL[difficulty] ?? 10;
      const moveTime = TIME_BY_LEVEL_MS[difficulty] ?? 800;

      const onMsg = (e: MessageEvent) => {
        const line: string = typeof e.data === "string" ? e.data : ((e.data as { line?: string })?.line ?? "");
        if (line.startsWith("bestmove") || line.startsWith("engine_load_failed")) {
          w.removeEventListener("message", onMsg);
          if (line.startsWith("engine_load_failed") || line === "bestmove (none)") return resolve(null);
          const uci = line.split(/\s+/)[1];
          if (!uci || uci === "(none)") return resolve(null);
          const from = uci.slice(0, 2);
          const to = uci.slice(2, 4);
          const promotion = (uci.length === 5 ? uci[4] : undefined) as ApplyMoveInput["promotion"];
          resolve({ from: from as ApplyMoveInput["from"], to: to as ApplyMoveInput["to"], promotion });
        }
      };
      w.addEventListener("message", onMsg);
      try {
        w.postMessage(`setoption name Skill Level value ${skill}`);
        w.postMessage(`position fen ${fen}`);
        w.postMessage(`go movetime ${moveTime}`);
      } catch { resolve(null); }
    });
  }

  cancel(): void {
    if (!this.worker) return;
    try { this.worker.postMessage("stop"); } catch { /* worker may be terminating */ }
  }

  shutdown(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.startingPromise = null;
  }

  /** Returns true once uciok+readyok have been seen, false on load failure / timeout. */
  async ensureStarted(): Promise<boolean> {
    if (this.ready && this.worker) return true;
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = new Promise<boolean>((resolve) => {
      try {
        // Classic worker — `new Worker(...)` without `{ type: "module" }`.
        // Vite's worker pipeline bundles module workers and disallows
        // importScripts; the bridge at public/stockfish-bridge.js is a
        // classic script that calls importScripts("/stockfish.js") to
        // load the shim, then bridges UCI to/from the main thread. The
        // bridge's own command queue prevents uci/isready posted during
        // the ~1 s WASM-load window from being silently dropped.
        const w = new Worker("/stockfish-bridge.js");
        const timeout = window.setTimeout(() => {
          w.removeEventListener("message", onMsg);
          w.removeEventListener("message", onReady);
          w.terminate();
          this.worker = null;
          this.ready = false;
          resolve(false);
        }, 2500);
        const finish = (ok: boolean) => {
          window.clearTimeout(timeout);
          this.worker = w;
          this.ready = ok;
          resolve(ok);
        };
        const onReady = (ev: MessageEvent) => {
          const l: string = typeof ev.data === "string" ? ev.data : "";
          if (l === "readyok") finish(true);
        };
        const onMsg = (e: MessageEvent) => {
          const line: string = typeof e.data === "string" ? e.data : "";
          if (line === "engine_load_failed") {
            w.terminate();
            this.worker = null;
            this.ready = false;
            window.clearTimeout(timeout);
            resolve(false);
            return;
          }
          if (line === "uciok") {
            w.removeEventListener("message", onMsg);
            w.addEventListener("message", onReady);
            try { w.postMessage("isready"); } catch { /* ignore */ }
          }
        };
        w.addEventListener("message", onMsg);
        try { w.postMessage("uci"); } catch { /* ignore */ }
      } catch {
        this.ready = false;
        resolve(false);
      }
    });
    try { return await this.startingPromise; } finally { this.startingPromise = null; }
  }
}

/**
 * In-thread fallback that picks a legal move. Prefers captures.
 * Capture detection uses an expanded FEN walker (handles rank compression correctly).
 */
export class FallbackAI implements AIAdapter {
  public readonly kind: AIEngineKind = "fallback";

  async requestMove(fen: string, _difficulty: AIDifficulty): Promise<ApplyMoveInput | null> {
    const engine = new ChessEngine(fen);
    const map = expandBoardFromFen(fen);
    const moves = engine.legalMovesAll();
    if (moves.length === 0) return null;
    const captures = moves.filter((m) => Boolean(map[m.to]));
    const pool = captures.length ? captures : moves;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return sanitize(pick, fen);
  }

  cancel(): void { /* no-op */ }
  shutdown(): void { /* no-op */ }
}

/** Expand only the piece-occupancy from the FEN's rank portion, ignoring digits. */
function expandBoardFromFen(fen: string): Record<string, string> {
  const board: Record<string, string> = {};
  const ranks = fen.split(" ")[0].split("/");
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (/[1-8]/.test(ch)) { file += parseInt(ch, 10); continue; }
      if (file < 8) {
        const sq = `${"abcdefgh"[file]}${8 - r}`;
        board[sq] = ch;
        file++;
      }
    }
  }
  return board;
}

/** Belt-and-braces sanity: validate the picked move through chess.js. */
function sanitize(input: ApplyMoveInput, fen: string): ApplyMoveInput {
  const engine = new ChessEngine(fen);
  if (engine.isLegal(input)) return input;
  if (engine.isLegal({ from: input.from, to: input.to })) {
    return { from: input.from, to: input.to };
  }
  return engine.legalMovesAll()[0] ?? input;
}

/**
 * Eager factory: try Stockfish; if it fails to boot within 2.5 s, return
 * FallbackAI. Awaiting this Promise before constructing Game guarantees
 * `game.ai.kind` is the truthful answer from the very first frame, so the
 * UI engine-kind badge reflects reality on first paint.
 */
export async function createAI(): Promise<AIAdapter> {
  const sf = new StockfishAI();
  const ok = await sf.ensureStarted();
  if (ok) return sf;
  sf.shutdown();
  return new FallbackAI();
}
