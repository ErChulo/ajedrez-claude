import { describe, expect, it, beforeEach } from "vitest";
import { sounds } from "@/audio/sounds";
import type { AIAdapter } from "@/ai/stockfish";
import { Game, type ChessView } from "./Game";
import type { MoveSink } from "./MoveSink";
import type { AIDifficulty, ApplyMoveInput, MoveRecord, PieceSymbol, Promotion, Side, Square } from "@/types";

class FakeView implements ChessView {
  public selectableCalls: (Side | null)[] = [];

  redraw(_board: Record<Square, PieceSymbol | null>): void {}
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
  setFlipped(_flipped: boolean): void {}
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
});
