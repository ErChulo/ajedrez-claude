import type { ApplyMoveInput } from "@/types";
import type { Game } from "@/game/Game";
import type { MoveSink } from "@/game/MoveSink";

/**
 * MoveSink for AI / pass-and-play. Sends moves directly to the local
 * Game.executeMove() — no server write happens.
 *
 * `isOnline === false` so Game.undoPair is allowed to rewind the local
 * engine (it never has to keep a server row in sync).
 */
export class LocalSink implements MoveSink {
  public readonly isOnline = false;
  constructor(private readonly game: Game) {}
  async submitMove(input: ApplyMoveInput): Promise<void> {
    await this.game.executeMove(input);
  }
  // No-op: local resignation never talks to a server. Game.resign() calls
  // sink.resign?.() defensively so we satisfy the optional contract.
  async resign(): Promise<void> { /* local — nothing to publish */ }
}
