// OnlineSink — Supabase-backed implementation of MoveSink.
// Owns two realtime subscriptions plus the move-write flow:
//
//   submitMove(input)
//     - apply locally → engine state, animations, clock tick (optimistic UI)
//     - read snapshot.history[-1] to get the just-applied MoveRecord
//     - INSERT one row into `moves` and UPDATE `games.{fen,turn,clocks,last_move_at}`
//     - on INSERT failure (RLS out-of-turn, network): log warn — local state stays
//       optimistic. Reconciling requires a server pull.
//
//   realtime: moves.subscribe
//     - moves with move_index <= lastSeenMoveIndex are echoes of our own
//       submission; ignored
//     - moves with move_index > lastSeenMoveIndex are opponent's — apply
//       via game.executeMove()
//
//   realtime: game.subscribe
//     - on UPDATE, forceUpdate() the clock to server-authoritative values
//       (drift correction, server-anchored)
//     - on terminal status (checkmate|stalemate|draw|resigned|aborted),
//       notify game via onGameEnd so it can settle the GameOverModal

import type { ApplyMoveInput, Side } from "@/types";
import type { MoveSink } from "./MoveSink";
import type { Game } from "./Game";
import {
  subscribeGame,
  subscribeMoves,
  sendOnlineMove,
  resignOnlineGame,
  type OnlineGameMeta,
  type OnlineMoveRow,
} from "@/net/online";

export interface OnlineSinkOptions {
  gameId: string;
  seated: Side;
  initialMeta: OnlineGameMeta;
  onGameEnd?: (status: OnlineGameMeta["status"]) => void;
}

export class OnlineSink implements MoveSink {
  /** Marker so Game.undoPair knows to refuse rewinds (desync risk). */
  public readonly isOnline = true;
  private gameRef: Game | null = null;
  private subGame: { unsubscribe: () => void } | null = null;
  private subMoves: { unsubscribe: () => void } | null = null;
  private lastSeenMoveIndex = 0;
  private writeInFlight = 0;

  constructor(private readonly opts: OnlineSinkOptions) {}

  /** Bind to the Game instance AFTER construction. Captures lastSeenMoveIndex
   *  at the moment we bind (so any moves already in the engine history won't
   *  be re-applied on reconnect). */
  bind(game: Game): void {
    this.gameRef = game;
    this.lastSeenMoveIndex = game.snapshot().history.length;
    this.subGame = subscribeGame(this.opts.gameId, (row) => this.onGameRow(row));
    this.subMoves = subscribeMoves(this.opts.gameId, (move) => this.onMoveRow(move));
  }

  destroy(): void {
    this.subGame?.unsubscribe();
    this.subMoves?.unsubscribe();
  }

  async resign(): Promise<void> {
    if (!this.gameRef) return;
    await resignOnlineGame(this.opts.gameId);
  }

  async submitMove(input: ApplyMoveInput): Promise<void> {
    const game = this.gameRef;
    if (!game) throw new Error("OnlineSink not bound");
    const from = input.from;
    const to = input.to;
    const promotion = input.promotion ?? null;
    // 1) Optimistic local apply: Game handles animation, clock, turn flip.
    await game.executeMove(input);
    // 2) Snapshot post-move state and queue the write.
    const snap = game.snapshot();
    const last = snap.history.at(-1);
    if (!last) return; // shouldn't happen — executeMove ran
    const cs = game.clockSnapshot();
    this.writeInFlight++;
    try {
      await sendOnlineMove({
        gameId: this.opts.gameId,
        san: last.san,
        from,
        to,
        promotion,
        fenAfter: snap.fen,
        turn: snap.turn,
        whiteTimeMs: cs.whiteMs,
        blackTimeMs: cs.blackMs,
        lastMoveAtIso: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("OnlineSink: move write rejected by RLS / network — local state remains optimistic.", e);
    } finally {
      this.writeInFlight--;
    }
  }

  private onMoveRow(move: OnlineMoveRow): void {
    if (!this.gameRef) return;
    if (move.move_index <= this.lastSeenMoveIndex) return; // dedupe
    this.lastSeenMoveIndex = move.move_index;
    const input: ApplyMoveInput = {
      from: move.from_square as ApplyMoveInput["from"],
      to: move.to_square as ApplyMoveInput["to"],
      ...(move.promotion ? { promotion: move.promotion } : {}),
    };
    void this.gameRef.executeMove(input);
  }

  private onGameRow(row: OnlineGameMeta): void {
    if (!this.gameRef) return;
    // Drift correction: server-authoritative remaining time.
    this.gameRef.clock.forceUpdate(
      row.whiteTimeRemainingMs,
      row.blackTimeRemainingMs,
      row.status === "active" ? row.turn : null,
    );
    if (row.status !== "waiting" && row.status !== "active") {
      this.opts.onGameEnd?.(row.status);
    }
  }

  /** Read-only view of pending writes, exposed for tests / debug. */
  get pendingWrites(): number { return this.writeInFlight; }
  get seat(): Side { return this.opts.seated; }
  get gameId(): string { return this.opts.gameId; }
}
