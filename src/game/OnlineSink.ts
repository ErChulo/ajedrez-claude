// OnlineSink — Supabase-backed implementation of MoveSink.
// Owns two realtime subscriptions plus the move-write flow:
//
//   submitMove(input)
//     - apply locally → engine state, animations, clock tick (optimistic UI)
//     - read snapshot.history[-1] to get the just-applied MoveRecord
//     - INSERT one row into `moves` and UPDATE `games.{fen,pgn,status,turn,clocks,last_move_at}`
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
  fetchOnlineGame,
  fetchOnlineMoves,
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
  private serverTurn: Side;
  private serverStatus: OnlineGameMeta["status"];
  /** Serializes incoming-move application (realtime + reconcile) so they can't
   *  race against each other and so a single rejection can't strand the chain. */
  private applyChain: Promise<void> = Promise.resolve();
  private reconciling = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(private readonly opts: OnlineSinkOptions) {
    this.serverTurn = opts.initialMeta.turn;
    this.serverStatus = opts.initialMeta.status;
  }

  /** Bind to the Game instance AFTER construction. Captures lastSeenMoveIndex
   *  at the moment we bind (so any moves already in the engine history won't
   *  be re-applied on reconnect). */
  bind(game: Game): void {
    this.gameRef = game;
    this.lastSeenMoveIndex = game.snapshot().history.length;
    this.subGame = subscribeGame(this.opts.gameId, (row) => this.onGameRow(row));
    this.subMoves = subscribeMoves(this.opts.gameId, (move) => this.onMoveRow(move));
    // Backstop for realtime events lost during WebSocket gaps (tab throttle,
    // reconnect, supabase channel backlog). The 5s cadence is a deliberate
    // trade-off: keeps the game recoverable without hammering the REST API.
    this.heartbeat = setInterval(() => { void this.reconcile(); }, 5000);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
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
    const localMoveIndex = snap.history.length;
    this.lastSeenMoveIndex = Math.max(this.lastSeenMoveIndex, localMoveIndex);
    const cs = game.clockSnapshot();
    const status: OnlineGameMeta["status"] = snap.status === "playing" ? "active" : snap.status;
    this.writeInFlight++;
    try {
      const writtenMoveIndex = await sendOnlineMove({
        gameId: this.opts.gameId,
        san: last.san,
        from,
        to,
        promotion,
        fenAfter: snap.fen,
        pgn: snap.pgn,
        turn: snap.turn,
        status,
        whiteTimeMs: cs.whiteMs,
        blackTimeMs: cs.blackMs,
        lastMoveAtIso: new Date().toISOString(),
      });
      this.lastSeenMoveIndex = Math.max(this.lastSeenMoveIndex, writtenMoveIndex);
    } catch (e) {
      console.warn("OnlineSink: move write rejected by RLS / network — local state remains optimistic.", e);
    } finally {
      this.writeInFlight--;
    }
  }

  private onMoveRow(move: OnlineMoveRow): void {
    if (!this.gameRef) return;
    this.enqueue(() => this.applyMoveRow(move));
  }

  private enqueue(task: () => Promise<void>): void {
    const next = this.applyChain.then(task).catch((e) => {
      console.warn("OnlineSink: queued move apply rejected", e);
    });
    this.applyChain = next.then(() => undefined);
  }

  private async applyMoveRow(move: OnlineMoveRow): Promise<void> {
    if (!this.gameRef) return;
    // Dedupe across realtime + reconcile paths: a move already claimed on a
    // previous iteration (by either path) must never be applied twice.
    if (move.move_index <= this.lastSeenMoveIndex) return;
    this.lastSeenMoveIndex = move.move_index;
    const input: ApplyMoveInput = {
      from: move.from_square as ApplyMoveInput["from"],
      to: move.to_square as ApplyMoveInput["to"],
      ...(move.promotion ? { promotion: move.promotion } : {}),
    };
    await this.gameRef.executeMove(input, { deferTurnControl: true });
    await this.waitForServerTurn(this.gameRef.snapshot().turn);
    this.syncTurnControlIfServerCaughtUp();
  }

  private onGameRow(row: OnlineGameMeta): void {
    this.syncFromServerMeta(row);
  }

  /** Re-anchor server-authoritative state (turn/status/clocks/terminal) into
   *  the local Game. Shared by realtime UPDATE handling and reconciliation so
   *  both paths end up at the same ground truth. */
  private syncFromServerMeta(row: OnlineGameMeta): void {
    if (!this.gameRef) return;
    this.serverTurn = row.turn;
    this.serverStatus = row.status;
    this.gameRef.clock.forceUpdate(
      row.whiteTimeRemainingMs,
      row.blackTimeRemainingMs,
      row.status === "active" ? row.turn : null,
    );
    this.syncTurnControlIfServerCaughtUp();
    if (row.status !== "waiting" && row.status !== "active") {
      this.opts.onGameEnd?.(row.status);
    }
  }

  /** Best-effort catch-up for realtime events missed during WebSocket gaps
   *  (tab throttle, reconnect, supabase channel backlog). Runs on a 5s
   *  heartbeat and is reentrancy-guarded so it never overlaps itself. */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    if (this.destroyed) return;
    this.reconciling = true;
    try {
      const game = this.gameRef;
      if (!game) return;
      // Only meaningful while a live board is in play.
      if (game.snapshot().status !== "playing") return;
      // 1) Replay any move inserts the realtime subscription never delivered.
      //    Each is funneled through the same serial apply queue so it can't
      //    double-apply with a concurrent onMoveRow; the dedupe check in
      //    applyMoveRow handles a move already claimed by realtime.
      const missed = await fetchOnlineMoves(this.opts.gameId, this.lastSeenMoveIndex);
      for (const m of missed) this.enqueue(() => this.applyMoveRow(m));
      // Let queued applies land before comparing notes against the game row.
      await this.applyChain;
      if (this.destroyed) return;
      // 2) Re-anchor turn + clocks + terminal status to the server row.
      const row = await fetchOnlineGame(this.opts.gameId);
      if (row && !this.destroyed) this.syncFromServerMeta(row);
    } catch (e) {
      console.warn("OnlineSink: reconcile attempt failed", e);
    } finally {
      this.reconciling = false;
    }
  }

  private syncTurnControlIfServerCaughtUp(): void {
    if (!this.gameRef) return;
    const snap = this.gameRef.snapshot();
    if (this.serverStatus === "active" && this.serverTurn === snap.turn) {
      this.gameRef.syncTurnControl();
    }
  }

  private async waitForServerTurn(turn: Side): Promise<void> {
    // Backstop until the realtime game UPDATE arrives; the 5s reconcile
    // heartbeat is the real safety net for lost events. Extended from 2s →
    // ~5s (10×~500ms) to ride brief realtime jitter.
    for (let i = 0; i < 10; i++) {
      if (this.serverStatus === "active" && this.serverTurn === turn) return;
      const row = await fetchOnlineGame(this.opts.gameId);
      if (row) {
        this.serverTurn = row.turn;
        this.serverStatus = row.status;
        if (this.serverStatus === "active" && this.serverTurn === turn) return;
      }
      await delay(400);
    }
  }

  /** Read-only view of pending writes, exposed for tests / debug. */
  get pendingWrites(): number { return this.writeInFlight; }
  get seat(): Side { return this.opts.seated; }
  get gameId(): string { return this.opts.gameId; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
