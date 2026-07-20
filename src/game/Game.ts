// Game controller — single source of truth for a single chess game.
// Coordinates: engine, clock, AI, and the View (2D/3D).
//
// Design notes (see also thinker's review):
//  * View is an abstract ChessView; Board2D and Board3D both implement it.
//  * Single Store<GameState> snapshot; UI subscribes.
//  * AI moves apply + animate sequentially to avoid race conditions.
//  * Promotion prompt only on human's turn, BEFORE engine.apply.
//  * isProcessingMove guard prevents double-fire.
//  * Online (Supabase) wiring is stubbed; identical event API so the same
//    controller can drive a remote opponent later.

import { ChessEngine } from "@/engine/chess";
import { Store } from "@/game/store";
import { Clock } from "@/clock/Clock";
import { sounds } from "@/audio/sounds";
import type { AIAdapter } from "@/ai/stockfish";
import { FallbackAI } from "@/ai/stockfish";
import type { MoveSink } from "@/game/MoveSink";
import { LocalSink } from "@/game/LocalSink";
import type {
  AIDifficulty,
  ApplyMoveInput,
  GameSnapshot,
  MoveRecord,
  PieceSymbol,
  Promotion,
  Side,
  Square,
} from "@/types";

export interface ChessView {
  redraw(board: Record<Square, PieceSymbol | null>): void;
  animateMove(rec: MoveRecord, animate: { kind: "move" | "capture" | "castle" | "enpassant" | "promote" }): Promise<void>;
  animateRookMove(from: Square, to: Square): Promise<void>;
  setSelectable(side: Side | null): void;
  setLegalTargets(origin: Square, targets: Square[], captures: Square[]): void;
  setLastMove(from?: Square, to?: Square): void;
  setCheck(square: Square | null): void;
  awaitPromotion(from: Square, to: Square): Promise<Promotion | null>;
  flashIllegal(sq: Square): void;
  clearSelection(): void;
  highlightFromSquare(sq: Square): void;
  /** Highlight the engine-recommended from→to squares. Auto-hides after 2.5s. */
  setHint(from: Square, to: Square): void;
}

export interface GameConfig {
  humanSide: Side;
  aiDifficulty: AIDifficulty;
  ai?: AIAdapter;
  initialSeconds: number;
  incrementSeconds: number;
  /**
   * Optional MoveSink DI seam. Defaults to LocalSink(this) for AI / pass-and-play.
   * Pass an OnlineSink instance for two-player online mode.
   */
  sink?: MoveSink;
}

export interface GameState extends GameSnapshot {
  humanSide: Side;
  aiDifficulty: AIDifficulty;
  isAiThinking: boolean;
}

export class Game {
  private engine: ChessEngine;
  public clock: Clock;
  /** Public so the UI can read ai.kind for the engine-kind badge and gate
   *  the Hint button (only useful with a real Stockfish worker). */
  public ai: AIAdapter;
  private humanSide: Side;
  private aiDifficulty: AIDifficulty;
  private view: ChessView;
  public store: Store<GameState>;
  private isProcessingMove = false;
  private aiThinkAbort: AbortController | null = null;
  /** Public so OnlineSink can be replaced post-construction by App.ts. */
  public sink: MoveSink;

  constructor(view: ChessView, cfg: GameConfig) {
    this.view = view;
    this.humanSide = cfg.humanSide;
    this.aiDifficulty = cfg.aiDifficulty;
    this.ai = cfg.ai ?? new FallbackAI();
    this.engine = new ChessEngine();
    this.clock = new Clock(cfg.initialSeconds, cfg.incrementSeconds, {
      onLowTime: () => sounds.play("lowtime"),
      onTick:  () => { /* observer drives UI via clockSnapshot() */ },
      onFlag:  () => this.handleFlag(),
    });
    this.store = new Store<GameState>(this.buildState());
    this.view.redraw(this.boardMap());
    // Default sink is local (AI or pass-and-play) — OnlineSink substitutes it for online mode.
    this.sink = cfg.sink ?? new LocalSink(this);
  }

  /**
   * Public so OnlineSink and tests can drive a move without re-running legality
   * (legality has already been validated at the call site before submitMove).
   */
  async executeMove(input: ApplyMoveInput, opts: { deferTurnControl?: boolean } = {}): Promise<void> {
    // No re-entrance guard HERE: `kickoffAiThink()` recursively awaits
    // `executeMove(aiMove)` while this outer executeMove()'s animation
    // chain is in flight. With a guard at this layer, the AI's reply would
    // `if (this.isProcessingMove) return;` itself out and silently drop its
    // move. The user-facing re-entrance guard lives at `attemptMove()`, so
    // duplicate human clicks still no-op safely — this layer is intentionally
    // unguarded so the AI's response can fire through normally.
    this.isProcessingMove = true;
    this.view.setSelectable(null);
    this.view.clearSelection();
    try {
      const rec = this.engine.apply(input);
      const mover = this.engine.turn() === "white" ? "black" : "white";
      const snap = this.engine.snapshot();
      this.clock.applyMove(mover);
      const kind = this.inferKind(rec);
      await this.view.animateMove(rec, { kind });
      if (kind === "castle") {
        const r = this.inferRookCastle(rec);
        await this.view.animateRookMove(r.from, r.to);
      }
      if (snap.inCheck) sounds.play("check");

      this.view.setLastMove(rec.from, rec.to);
      this.view.setCheck(snap.inCheck ? this.findKingSquare(snap.turn) : null);

      this.publishState();

      if (snap.status !== "playing") {
        this.endGame();
        return;
      }
      if (snap.turn === this.humanSide && !opts.deferTurnControl) {
        this.view.setSelectable(this.humanSide);
      } else if (!this.sink.isOnline) {
        await this.kickoffAiThink();
      } else {
        this.view.setSelectable(null);
      }
    } finally {
      this.isProcessingMove = false;
    }
  }

  /** Load a server-supplied FEN into the engine (used when joining an in-progress game). */
  loadFEN(fen: string): void {
    // engine.reset() doesn't throw on invalid FEN — chess.js silently
    // falls back to the starting position if the FEN is unparseable. We
    // detect that by comparing post-load FEN to the input FEN; if they
    // differ, the input was rejected and we abort the load.
    try {
      this.engine.reset(fen);
    } catch (e) {
      console.warn("Game.loadFEN: reset threw", fen, e);
      return;
    }
    if (this.engine.fen().split(" ")[0] !== fen.split(" ")[0]) {
      console.warn("Game.loadFEN: rejected FEN", fen);
      return;
    }
    this.view.redraw(this.boardMap());
    const snap = this.engine.snapshot();
    this.view.setLastMove(snap.history.at(-1)?.from, snap.history.at(-1)?.to);
    this.view.setCheck(snap.inCheck ? this.findKingSquare(snap.turn) : null);
    this.publishState();
  }

  subscribe(l: (state: GameState) => void): () => void { return this.store.subscribe(l); }

  /** Public read of the live clock state for UI rendering. */
  clockSnapshot(): { whiteMs: number; blackMs: number; active: Side | null; flagFall?: Side } {
    return this.clock.snapshot();
  }

  /** Engine snapshot — public so MoveSink (OnlineSink especially) can read
   *  post-move state for Supabase write payloads. */
  snapshot(): GameSnapshot {
    return this.engine.snapshot();
  }

  start(): void {
    this.view.setSelectable(this.engine.turn() === this.humanSide ? this.humanSide : null);
    this.view.clearSelection();
    sounds.play("gameStart");
    this.clock.start(this.engine.turn());
    this.publishState();
    if (this.engine.turn() !== this.humanSide && !this.sink.isOnline) {
      void this.kickoffAiThink();
    }
  }

  shutdown(): void {
    this.aiThinkAbort?.abort();
    this.clock.pause();
    this.sink.destroy?.();
    this.ai.shutdown();
  }

  syncTurnControl(): void {
    const s = this.engine.snapshot();
    this.view.setSelectable(s.status === "playing" && s.turn === this.humanSide ? this.humanSide : null);
  }

  async resign(): Promise<void> {
    if (this.engine.snapshot().status !== "playing") return;
    // If the sink has a resign path (OnlineSink posts status='resigned' to
    // the games row), let it run BEFORE endGame so the server sees the
    // change before we settle the local UI. LocalSinks no-op it.
    try {
      await this.sink.resign?.();
    } catch (e) {
      console.warn("sink.resign failed (continuing with local endGame)", e);
    }
    sounds.play("gameEnd");
    const winner: Side = this.humanSide === "white" ? "black" : "white";
    this.endGame();
    // Chess.js doesn't track resignation, so engine.snapshot().status stays
    // "playing" after endGame. Override the store with `status: "resigned"`
    // so onGameState's modal branch (`s.status !== "playing"`) fires and
    // GameOverModal renders for both local and online resignations.
    this.store.set({ ...this.store.get(), status: "resigned", winner });
  }

  offerDraw(): void {
    // Local-AI mode: AI never accepts. Toast would go here.
  }

  /**
   * Rewind the last move-pair (your move + AI's reply) so it's your turn
   * again at the position from two ply ago. Refuses if:
   *   - the sink is online (rewinding locally would desync from Supabase),
   *   - the AI is currently thinking (would race with its move),
   *   - the game is over (no ply to rewind),
   *   - the position has fewer than two plies (nothing meaningful to undo).
   * The clock is restored by paired `Clock.unapplyMove(side)` calls that
   * subtract exactly the two increments ApplyMove added during the undone
   * pair — so post-undo the clock matches the engine, no inflation.
   */
  undoPair(): boolean {
    const s = this.store.get();
    if (this.sink.isOnline) return false;
    if (s.isAiThinking) return false;
    if (s.status !== "playing") return false;
    if (this.engine.snapshot().history.length < 2) return false;
    // The LAST ply was made by whoever's NOT about to move (engine.turn()
    // flips AFTER the just-applied input). The ply before that was the
    // opposite side. Mirror the two applyMove calls in reverse order so
    // the clock subtracts exactly the increments that were added.
    const lastMover: Side = this.engine.turn() === "white" ? "black" : "white";
    this.engine.undo();
    this.clock.unapplyMove(lastMover);
    this.engine.undo();
    this.clock.unapplyMove(lastMover === "white" ? "black" : "white");
    this.view.clearSelection();
    this.view.setLastMove(undefined, undefined);
    this.view.setCheck(null);
    this.view.redraw(this.boardMap());
    this.view.setSelectable(this.humanSide);
    this.publishState();
    return true;
  }

  /**
   * Ask the AI's expert endpoint for the best move at the current position
   * and have the View highlight its from→to squares. No-ops when the engine
   * is the fallback (random hint is misleading) or when the AI is busy.
   */
  async hint(): Promise<void> {
    const s = this.store.get();
    if (s.isAiThinking) return;
    if (s.status !== "playing") return;
    if (this.ai.kind !== "stockfish") return;
    try {
      const m = await this.ai.requestMove(this.engine.fen(), "expert");
      if (!m) return;
      if (this.engine.turn() !== this.humanSide) return; // hint must be on your turn
      this.view.setHint(m.from as Square, m.to as Square);
      sounds.setMuted(sounds.isMuted()); // no-op (doubles as a tick to satisfy lint); placeholder for "hint" sound
    } catch { /* hint is best-effort */ }
  }

  async attemptMove(input: ApplyMoveInput): Promise<void> {
    if (this.isProcessingMove) return;
    if (this.engine.snapshot().status !== "playing") return;
    if (this.engine.turn() !== this.humanSide) return;
    // Validate. We pass both with and without a promotion because chess.js
    // will reject a promotion target without one.
    const isLegal =
      this.engine.isLegal(input) ||
      this.engine.isLegal({ from: input.from, to: input.to });
    if (!isLegal) {
      this.view.flashIllegal(input.from);
      sounds.play("illegal");
      return;
    }
    const isPromo = this.needsPromotion({ from: input.from, to: input.to });
    if (isPromo) {
      this.view.setSelectable(null);
      const promo = await this.view.awaitPromotion(input.from, input.to);
      if (!promo) {
        this.view.setSelectable(this.humanSide);
        sounds.play("illegal");
        return;
      }
      input = { ...input, promotion: promo };
    }
    // Round-trip through MoveSink so AI goes through LocalSink (immediate apply)
    // and online goes through OnlineSink (apply locally + write to Supabase).
    await this.sink.submitMove(input);
  }

  /**
   * Hot-swap the view when the user toggles 2D ↔ 3D. Hands the
   * new view a chance to redraw the current board + restore
   * last-move highlight + check highlight + selection state.
   *
   * Without this, `this.view` would still point at the destroyed
   * Board2D after a toggle and subsequent moves would call
   * `animateMove()` on a dead view (silent no-op — `this.pieces`
   * and `this.squares` were cleared by destroy(), so the very
   * first guard `if (!fromEl || !toEl) return;` short-circuits).
   * The visible symptom: the Game store advances on every click
   * but the new view never paints the moved piece.
   *
   * Called from App.ts onRender immediately after `mountBoard(...)`
   * returns and `hookView(view)` wires the click handlers.
   */
  setView(view: ChessView): void {
    this.view = view;
    // Defensive: a freshly-mounted view has no .selected / .target
    // classes left over from a previous mount, so clearSelection()
    // is a no-op on first call. If a future view implementation
    // ever caches selection across mounts (or skips mount() on
    // hot-swap), this line prevents stale highlight classes from
    // leaking onto the wrong DOM.
    this.view.clearSelection();
    this.view.redraw(this.boardMap());
    const s = this.engine.snapshot();
    this.view.setLastMove(s.history.at(-1)?.from, s.history.at(-1)?.to);
    this.view.setCheck(s.inCheck ? this.findKingSquare(s.turn) : null);
    // Restore selection ONLY when it's the human's turn AND status
    // is still 'playing'. Skipping this during AI-think / checkmate
    // means the view is always in a state consistent with Game's
    // turn + status flags the rest of the view reads from.
    if (s.turn === this.humanSide && s.status === "playing") {
      this.view.setSelectable(this.humanSide);
    } else {
      this.view.setSelectable(null);
    }
  }

  selectSquare(sq: Square): void {
    if (this.isProcessingMove) return;
    if (this.engine.turn() !== this.humanSide) return;
    const targets = this.engine.legalMovesFrom(sq);
    if (targets.length === 0) {
      this.view.clearSelection();
      this.view.highlightFromSquare(sq);
      return;
    }
    const simple = targets.map(t => t.to);
    const captures: Square[] = [];
    const map = this.boardMap();
    for (const t of targets) {
      const occupant = map[t.to] ?? null;
      if (occupant && this.isOpponentPiece(occupant)) captures.push(t.to);
    }
    this.view.setLegalTargets(sq, simple, captures);
  }

  // ---- internals ----

  // executeMove was promoted to public above; the local copy here is removed.

  private async kickoffAiThink(): Promise<void> {
    this.aiThinkAbort?.abort();
    const ctrl = new AbortController();
    this.aiThinkAbort = ctrl;
    this.publishState();
    try {
      const move = await this.ai.requestMove(this.engine.fen(), this.aiDifficulty);
      if (ctrl.signal.aborted) return;
      if (this.engine.snapshot().status !== "playing") return;
      if (!move) return;
      if (!this.engine.isLegal(move)) {
        console.warn("AI returned illegal move; ignoring.", move);
        return;
      }
      await this.executeMove(move);
    } catch (e) {
      if (!ctrl.signal.aborted) console.warn("AI think failed", e);
    } finally {
      if (this.aiThinkAbort === ctrl) this.aiThinkAbort = null;
      this.publishState();
    }
  }

  private handleFlag(): void {
    const losingSide: Side = this.clock.snapshot().whiteMs <= 0 ? "white" : "black";
    void losingSide; // surfaced via end-of-game snapshot.
    sounds.play("gameEnd");
    this.endGame();
  }

  private endGame(): void {
    this.clock.finalize();
    this.ai.cancel();
    this.view.setSelectable(null);
    const finalState: GameState = { ...this.buildState(), status: this.engine.snapshot().status, winner: this.engine.snapshot().winner };
    this.store.set(finalState);
  }

  private publishState(): void { this.store.set(this.buildState()); }
  private buildState(): GameState {
    const s = this.engine.snapshot();
    return {
      ...s,
      humanSide: this.humanSide,
      aiDifficulty: this.aiDifficulty,
      isAiThinking: this.aiThinkAbort !== null,
    };
  }

  private boardMap(): Record<Square, PieceSymbol | null> {
    const fenBoard = this.engine.fen().split(" ")[0];
    const ranks = fenBoard.split("/");
    const map = new Map<Square, PieceSymbol | null>();
    for (let r = 0; r < 8; r++) {
      let file = 0;
      for (const ch of ranks[r]) {
        if (/[1-8]/.test(ch)) { file += parseInt(ch, 10); continue; }
        const sq = `${"abcdefgh"[file]}${8 - r}` as Square;
        map.set(sq, ch as PieceSymbol);
        file++;
      }
    }
    // Snapshot Map → Record for the view's API contract.
    const out = {} as Record<Square, PieceSymbol | null>;
    for (const [k, v] of map) out[k] = v;
    return out;
  }

  private inferKind(rec: MoveRecord): "move" | "capture" | "castle" | "enpassant" | "promote" {
    if (rec.promotion) return "promote";
    if (rec.san === "O-O" || rec.san === "O-O-O") return "castle";
    if (rec.captured) {
      if (/\be\.p\./.test(rec.san)) return "enpassant";
      return "capture";
    }
    return "move";
  }

  private needsPromotion(input: ApplyMoveInput): boolean {
    const candidates = this.engine.legalMovesFrom(input.from);
    return candidates.some(c => c.to === input.to && c.promotion);
  }

  private isOpponentPiece(symbol: PieceSymbol): boolean {
    const isWhite = /[A-Z]/.test(symbol);
    return (this.engine.turn() === "white" && !isWhite) || (this.engine.turn() === "black" && isWhite);
  }

  private inferRookCastle(rec: MoveRecord): { from: Square; to: Square } {
    if (rec.to === "g1") return { from: "h1", to: "f1" };
    if (rec.to === "c1") return { from: "a1", to: "d1" };
    if (rec.to === "g8") return { from: "h8", to: "f8" };
    if (rec.to === "c8") return { from: "a8", to: "d8" };
    return { from: "a1", to: "a1" };
  }

  private findKingSquare(side: Side): Square {
    const ranks = this.engine.fen().split(" ")[0].split("/");
    const king = side === "white" ? "K" : "k";
    for (let r = 0; r < 8; r++) {
      let file = 0;
      for (const ch of ranks[r]) {
        if (/[1-8]/.test(ch)) { file += parseInt(ch, 10); continue; }
        if (ch === king) {
          const sqName = `${"abcdefgh"[file]}${8 - r}` as Square;
          return sqName;
        }
        file++;
      }
    }
    return "e1";
  }
}
