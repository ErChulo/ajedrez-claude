import { describe, expect, it, beforeEach, vi } from "vitest";
import { sounds } from "@/audio/sounds";
import type { AIAdapter } from "@/ai/stockfish";
import { Game, type ChessView } from "./Game";
import type { MoveSink } from "./MoveSink";
import type { AIDifficulty, ApplyMoveInput, MoveRecord, PieceSymbol, Promotion, Side, Square } from "@/types";

class FakeView implements ChessView {
  public selectableCalls: (Side | null)[] = [];
  public events: string[] = [];

  redraw(_board: Record<Square, PieceSymbol | null>): void {
    this.events.push("redraw");
  }
  async animateMove(_rec: MoveRecord, _animate: { kind: "move" | "capture" | "castle" | "enpassant" | "promote" }): Promise<void> {}
  async animateRookMove(_from: Square, _to: Square): Promise<void> {}
  setSelectable(side: Side | null): void { this.selectableCalls.push(side); }
  setLegalTargets(_origin: Square, _targets: Square[], _captures: Square[]): void {}
  setLastMove(_from?: Square, _to?: Square): void {}
  setCheck(_square: Square | null): void {}
  async awaitPromotion(_from: Square, _to: Square): Promise<Promotion | null> { return null; }
  flashIllegal(_sq: Square): void {}
  clearSelection(): void {}
  highlightFromSquare(_sq: Square): void {}
  setHint(_from: Square, _to: Square): void {}
  setFlipped(flipped: boolean): void {
    this.events.push(`flip:${flipped}`);
  }
}

class CountingAI implements AIAdapter {
  public readonly kind = "fallback";
  public requestCount = 0;

  async requestMove(_fen: string, _difficulty: AIDifficulty): Promise<ApplyMoveInput | null> {
    this.requestCount++;
    return null;
  }

  cancel(): void {}
  shutdown(): void {}
}

class PassthroughOnlineSink implements MoveSink {
  public readonly isOnline = true;
  public destroyed = false;
  private game: Game | null = null;

  bind(game: Game): void { this.game = game; }
  async submitMove(input: ApplyMoveInput): Promise<void> { await this.game?.executeMove(input); }
  destroy(): void { this.destroyed = true; }
}

describe("Game online sink behavior", () => {
  beforeEach(() => {
    sounds.setMuted(true);
  });

  it("does not ask AI for a move while waiting for the remote player", () => {
    const view = new FakeView();
    const ai = new CountingAI();
    const sink = new PassthroughOnlineSink();
    const game = new Game(view, {
      humanSide: "black",
      aiDifficulty: "intermediate",
      ai,
      initialSeconds: 60,
      incrementSeconds: 0,
      sink,
    });
    sink.bind(game);

    game.start();

    expect(ai.requestCount).toBe(0);
    expect(view.selectableCalls.at(-1)).toBeNull();
    game.shutdown();
    expect(sink.destroyed).toBe(true);
  });

  it("does not ask AI after a local online move hands the turn to the opponent", async () => {
    const view = new FakeView();
    const ai = new CountingAI();
    const sink = new PassthroughOnlineSink();
    const game = new Game(view, {
      humanSide: "white",
      aiDifficulty: "intermediate",
      ai,
      initialSeconds: 60,
      incrementSeconds: 0,
      sink,
    });
    sink.bind(game);
    game.start();

    await game.attemptMove({ from: "e2", to: "e4" });

    expect(ai.requestCount).toBe(0);
    expect(view.selectableCalls.at(-1)).toBeNull();
    game.shutdown();
  });

  it("repaints the board after flipping it to the black side on start()", () => {
    const view = new FakeView();
    const ai = new CountingAI();
    const sink = new PassthroughOnlineSink();
    const game = new Game(view, {
      humanSide: "black",
      aiDifficulty: "intermediate",
      ai,
      initialSeconds: 60,
      incrementSeconds: 0,
      sink,
    });
    sink.bind(game);

    game.start();

    const lastFlip = view.events.lastIndexOf("flip:true");
    const lastRedraw = view.events.lastIndexOf("redraw");
    expect(lastFlip).toBeGreaterThanOrEqual(0);
    expect(lastRedraw).toBeGreaterThan(lastFlip);
    game.shutdown();
  });

  it("ignores a second move attempt while the promotion picker is awaiting (Bug D)", async () => {
    // Regression: isProcessingMove was only set inside executeMove, so it was
    // false during `await awaitPromotion` — a fast second click re-entered
    // attemptMove, double-firing executeMove + the online write and corrupting
    // the move sequence (freeze at the promotion). After the fix, the whole
    // human path is guarded end-to-end.
    let resolvePromo!: (v: Promotion | null) => void;
    const view = new FakeView();
    (view as any).awaitPromotion = () =>
      new Promise<Promotion | null>((r) => { resolvePromo = r; });
    const game = new Game(view, {
      humanSide: "white",
      aiDifficulty: "intermediate",
      ai: new CountingAI(),
      initialSeconds: 60,
      incrementSeconds: 0,
    });
    // White pawn on e7; e8 empty and ready to promote.
    game.loadFEN("8/4P3/8/8/8/8/8/4K1k1 w - - 0 1");
    game.start();
    const execSpy = vi.spyOn(game as any, "executeMove");

    let promoCalls = 0;
    const origAwait = (view as any).awaitPromotion;
    (view as any).awaitPromotion = () => {
      promoCalls++;
      return origAwait();
    };

    // First attempt enters the picker and awaits.
    const first = game.attemptMove({ from: "e7", to: "e8", promotion: "q" });
    await Promise.resolve();

    // A second attempt during the picker await must be a no-op: it must NOT
    // open a second picker (the whole human path is guarded end-to-end).
    await game.attemptMove({ from: "e7", to: "e8", promotion: "q" });
    expect(promoCalls).toBe(1);
    expect(execSpy).toHaveBeenCalledTimes(0);

    // Resolve the (single) picker -> the original move completes.
    resolvePromo("q");
    await first;
    expect(promoCalls).toBe(1); // picker invoked only once
    expect(execSpy).toHaveBeenCalledTimes(1);
    game.shutdown();
  });

  it("animates a promotion with kind 'promote' carrying the chosen promotion piece", async () => {
    // Regression for the observer-side promotion render: a promote move must
    // reach View.animateMove with kind 'promote' AND rec.promotion set to the
    // chosen piece, so both Board2D and Board3D paint the new piece (not a
    // lingering pawn). The online row's `promotion` is forwarded by
    // OnlineSink.applyMoveRow into executeMove; this test pins that contract
    // at the Game layer independent of any network/Supabase plumbing.
    const recorded: { rec: MoveRecord; kind: string }[] = [];
    const view = new FakeView();
    (view as any).animateMove = (_rec: MoveRecord, animate: { kind: string }) => {
      recorded.push({ rec: _rec, kind: animate.kind });
      return Promise.resolve();
    };
    (view as any).awaitPromotion = () => Promise.resolve("n" as Promotion);

    const game = new Game(view, {
      humanSide: "white",
      aiDifficulty: "intermediate",
      ai: new CountingAI(),
      initialSeconds: 60,
      incrementSeconds: 0,
    });
    // White pawn on e7, ready to promote on e8 (empty).
    game.loadFEN("8/4P3/8/8/8/8/8/4K1k1 w - - 0 1");
    game.start();
    void game.attemptMove({ from: "e7", to: "e8" });

    await Promise.resolve();
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].kind).toBe("promote");
    expect(recorded[0].rec.promotion).toBe("N");
    expect(recorded[0].rec.from).toBe("e7");
    expect(recorded[0].rec.to).toBe("e8");
    game.shutdown();
  });
});
