import type { GameSnapshot } from "@/types";
import type { OnlineGameMeta, OnlineMoveRow } from "@/net/online";
import type { ApplyMoveInput, MoveRecord, Side, Square } from "@/types";
import type { Game } from "./Game";
import { OnlineSink } from "./OnlineSink";
import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchOnlineMoves: vi.fn(),
  fetchOnlineGame: vi.fn(),
  subscribeGame: vi.fn(),
  subscribeMoves: vi.fn(),
  sendOnlineMove: vi.fn(),
  selfHealGameRow: vi.fn(),
  resignOnlineGame: vi.fn(),
}));

vi.mock("@/net/online", () => ({
  fetchOnlineMoves: (...args: unknown[]) => mocks.fetchOnlineMoves(...args),
  fetchOnlineGame: (...args: unknown[]) => mocks.fetchOnlineGame(...args),
  subscribeGame: (...args: unknown[]) => mocks.subscribeGame(...args),
  subscribeMoves: (...args: unknown[]) => mocks.subscribeMoves(...args),
  sendOnlineMove: (...args: unknown[]) => mocks.sendOnlineMove(...args),
  selfHealGameRow: (...args: unknown[]) => mocks.selfHealGameRow(...args),
  resignOnlineGame: (...args: unknown[]) => mocks.resignOnlineGame(...args),
}));

function freshSnapshot(turn: Side, status: GameSnapshot["status"], historyLen: number): GameSnapshot {
  const history: MoveRecord[] = Array.from({ length: historyLen }, (_, i) => ({
    from: "e2" as Square,
    to: "e4" as Square,
    piece: "p" as MoveRecord["piece"],
    san: "e4",
    lan: "e2e4",
    fen: "fen",
    ply: i + 1,
  }));
  return {
    fen: "start",
    pgn: "",
    turn,
    history,
    inCheck: false,
    isCheckmate: false,
    isStalemate: false,
    isInsufficientMaterial: false,
    isThreefoldRepetition: false,
    is50MoveRule: false,
    canWhiteCastleKingside: false,
    canWhiteCastleQueenside: false,
    canBlackCastleKingside: false,
    canBlackCastleQueenside: false,
    status,
    winner: null,
  };
}

function makeMoveRow(
  gameId: string,
  move_index: number,
  from = "e7",
  to = "e8",
  promotion: OnlineMoveRow["promotion"] = null,
): OnlineMoveRow {
  return {
    id: move_index,
    game_id: gameId,
    move_index,
    san: `${from}-${to}`,
    from_square: from,
    to_square: to,
    promotion,
    fen_after: "after",
    by_player_id: "remote",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeMeta(turn: Side, status: OnlineGameMeta["status"]): OnlineGameMeta {
  return {
    id: "g1",
    whitePlayerId: "w",
    blackPlayerId: "b",
    whiteDisplayName: "W",
    blackDisplayName: "B",
    status,
    turn,
    initialSeconds: 5,
    incrementSeconds: 0,
    whiteTimeRemainingMs: 5000,
    blackTimeRemainingMs: 5000,
    lastMoveAt: "2026-01-01T00:00:00Z",
    joinCode: "AAAAAA",
    fen: "start",
    pgn: "",
  };
}

class StubGame {
  public snap: GameSnapshot;
  public executed: ApplyMoveInput[] = [];
  public executeOpts: Array<{ deferTurnControl?: boolean } | undefined> = [];
  public loadedFens: string[] = [];
  public syncTurnControlCalls = 0;
  public clockForceUpdates: Array<[number, number, Side | null]> = [];
  public executeThrows = false;
  public executeFailures = 0;
  private executeCalls = 0;

  constructor(turn: Side, status: GameSnapshot["status"], historyLen: number) {
    this.snap = freshSnapshot(turn, status, historyLen);
  }
  snapshot(): GameSnapshot {
    return this.snap;
  }
  async executeMove(input: ApplyMoveInput, opts?: { deferTurnControl?: boolean }): Promise<void> {
    if (this.executeThrows && this.executeCalls++ < this.executeFailures) {
      throw new Error("boom");
    }
    this.executed.push(input);
    this.executeOpts.push(opts);
    const next = this.snap.turn === "white" ? "black" : "white";
    this.snap = freshSnapshot(next, this.snap.status, this.snap.history.length + 1);
  }
  loadFEN(fen: string): void {
    this.loadedFens.push(fen);
  }
  syncTurnControl(): void {
    this.syncTurnControlCalls++;
  }
  clockSnapshot() {
    return { whiteMs: 5000, blackMs: 5000 };
  }
  get clock() {
    return {
      forceUpdate: (w: number, b: number, a: Side | null) => {
        this.clockForceUpdates.push([w, b, a]);
      },
    };
  }
}

describe("OnlineSink.reconcile (missed realtime recovery)", () => {
  let capturedMovesHandler: ((m: OnlineMoveRow) => void) | null;

  beforeEach(() => {
    mocks.fetchOnlineMoves.mockReset();
    mocks.fetchOnlineGame.mockReset();
    mocks.sendOnlineMove.mockReset();
    mocks.resignOnlineGame.mockReset();
    capturedMovesHandler = null;
    mocks.subscribeGame.mockImplementation((_id, _handler) => {
      return { unsubscribe: vi.fn() };
    });
    mocks.subscribeMoves.mockImplementation((_id, handler) => {
      capturedMovesHandler = handler;
      return { unsubscribe: vi.fn() };
    });
  });

  it("applies moves the realtime subscription missed and re-enables local control", async () => {
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"),
    });
    // After bind: lastSeenMoveIndex == history.length == 1; local turn is black.
    sink.bind(stub as unknown as Game);

    // Server has a remote move #2 that never arrived via realtime...
    mocks.fetchOnlineMoves.mockResolvedValueOnce([makeMoveRow("g1", 2)]);
    // ...and the game row reflects white to move (post move #2).
    mocks.fetchOnlineGame.mockResolvedValueOnce(makeMeta("white", "active"));

    await sink.reconcile();

    expect(stub.executed).toHaveLength(1);
    expect(stub.executed[0]).toEqual({ from: "e7", to: "e8" });
    expect(stub.executeOpts[0]).toEqual({ deferTurnControl: true });
    expect(stub.syncTurnControlCalls).toBeGreaterThan(0);
  });

  it("does not double-apply when the same move is delivered again after reconcile", async () => {
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"),
    });
    sink.bind(stub as unknown as Game);

    mocks.fetchOnlineMoves.mockResolvedValueOnce([makeMoveRow("g1", 2)]);
    mocks.fetchOnlineGame.mockResolvedValue(makeMeta("white", "active"));

    await sink.reconcile();
    const afterFirst = stub.executed.length;

    // A 2nd reconcile finds no new moves and does not re-apply.
    mocks.fetchOnlineMoves.mockResolvedValueOnce([]);
    await sink.reconcile();

    expect(stub.executed).toHaveLength(afterFirst);
  });

  it("ignores realtime echoes of already-seen moves (dedupe across paths)", async () => {
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"),
    });
    sink.bind(stub as unknown as Game);

    // Realtime delivers the missed move directly.
    mocks.fetchOnlineGame.mockResolvedValue(makeMeta("white", "active"));

    expect(capturedMovesHandler).not.toBeNull();
    capturedMovesHandler!(makeMoveRow("g1", 2));
    // Flush the apply chain via a reconcile (which awaits applyChain).
    mocks.fetchOnlineMoves.mockResolvedValue([]);
    await sink.reconcile();

    const afterRealtime = stub.executed.length;
    expect(afterRealtime).toBe(1);

    // Delivering the same move again is an echo → skipped.
    capturedMovesHandler!(makeMoveRow("g1", 2));
    mocks.fetchOnlineMoves.mockResolvedValue([]);
    await sink.reconcile();

    expect(stub.executed).toHaveLength(afterRealtime);
  });

  it("preserves the promoted piece on the observer's board (Bug: opponent saw pawn)", async () => {
    // Regression: a remote promotion must reach executeMove with the chosen
    // promotion (e.g. 'r', not defaulted to 'q') so the observer's view renders
    // the pawn->rook transform with kind 'promote'. The watcher's OnlineMoveRow
    // carries promotion='r' from record_move's p_promotion column.
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"), // serverTurn=white, stub.local=black
    });
    sink.bind(stub as unknown as Game);
    mocks.fetchOnlineGame.mockResolvedValue(makeMeta("white", "active"));

    expect(capturedMovesHandler).not.toBeNull();
    // Mover (white) promoted e7e8, choosing a rook.
    capturedMovesHandler!(makeMoveRow("g1", 2, "e7", "e8", "r"));
    // Drain the serialized apply queue so executeMove has run.
    mocks.fetchOnlineMoves.mockResolvedValue([]);
    await sink.reconcile();

    expect(stub.executed).toHaveLength(1);
    expect(stub.executed[0]).toEqual({ from: "e7", to: "e8", promotion: "r" });
    // Local turn should have flipped to white (server caught up) so the
    // opponent is never frozen after a promotion.
    expect(stub.syncTurnControlCalls).toBeGreaterThan(0);
  });

  it("falls back to the server FEN when executeMove rejects a remote move", async () => {
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"),
    });
    sink.bind(stub as unknown as Game);

    mocks.fetchOnlineGame.mockResolvedValue(makeMeta("white", "active"));

    stub.executeThrows = true;
    stub.executeFailures = 1;

    expect(capturedMovesHandler).not.toBeNull();
    capturedMovesHandler!(makeMoveRow("g1", 2));
    mocks.fetchOnlineMoves.mockResolvedValue([]);
    await sink.reconcile();

    expect(stub.loadedFens).toEqual(["after"]);
    expect(stub.syncTurnControlCalls).toBe(0);
  });

  it("no-ops after destroy() (heartbeat safe to fire)", async () => {
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"),
    });
    sink.bind(stub as unknown as Game);
    sink.destroy();

    await sink.reconcile();

    expect(mocks.fetchOnlineMoves).not.toHaveBeenCalled();
    expect(mocks.fetchOnlineGame).not.toHaveBeenCalled();
  });

  it("self-heals a stale games row (dropped UPDATE) and unfreezes the opponent", async () => {
    // Corruption scenario from the freeze bug: the writer's `moves` INSERT
    // landed but the `games` UPDATE was dropped, so games.turn never flipped
    // while the local engine has already applied the move. syncTurnControl
    // only flips when serverTurn === snap.turn -> without repair the opponent
    // is frozen forever. The reconcile self-heal repairs the row.
    const stub = new StubGame("black", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "black",
      initialMeta: makeMeta("white", "active"), // stale server turn = "white"
    });
    sink.bind(stub as unknown as Game);
    // No missed moves (the move IS in the table) — just the stale row.
    mocks.fetchOnlineMoves.mockResolvedValue([]);
    mocks.fetchOnlineGame.mockResolvedValue(makeMeta("white", "active")); // stale turn
    mocks.selfHealGameRow.mockResolvedValueOnce(true);

    await sink.reconcile();

    // Self-heal may run more than once across reconcile + local mirror paths,
    // but it must at least be invoked with the corrected turn + current engine fen/pgn.
    expect(mocks.selfHealGameRow).toHaveBeenCalledWith("g1", {
      staleTurn: "white",
      turn: "black",
      fen: "start",
      pgn: "",
      status: "active",
    });
    // ...and turn control flipped so the opponent can move again.
    expect(stub.syncTurnControlCalls).toBeGreaterThan(0);
  });

  it("does not snap the clock back on an unchanged 5s heartbeat pull", async () => {
    // Bug B regression: syncFromServerMeta used to call clock.forceUpdate on
    // EVERY pull, including the unchanged 5s heartbeat. The games-row clock
    // values are only refreshed when a move is written, so an unchanged pull
    // yanked the live-ticking clock back to the turn-start value every 5 s.
    const stub = new StubGame("white", "playing", 1);
    const sink = new OnlineSink({
      gameId: "g1",
      seated: "white",
      initialMeta: makeMeta("white", "active"),
    });
    sink.bind(stub as unknown as Game);
    mocks.fetchOnlineMoves.mockResolvedValue([]);
    mocks.fetchOnlineGame.mockResolvedValue(makeMeta("white", "active"));

    await sink.reconcile();           // 1st pull: changed -> one forceUpdate
    await sink.reconcile();           // 2nd pull: identical -> NO forceUpdate
    await sink.reconcile();           // 3rd pull: identical -> NO forceUpdate

    expect(stub.clockForceUpdates).toHaveLength(1);
  });
});
