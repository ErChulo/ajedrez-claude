import type { ApplyMoveInput } from "@/types";

/**
 * MoveSink — the DI seam for "what happens when the user makes a move".
 *
 * The local-ai / pass-and-play flow installs `LocalSink` (immediate apply,
 * no network). The online-multiplayer flow installs `OnlineSink` (apply
 * optimistically, then write to Supabase + subscribe to realtime echoes).
 *
 * Two markers on this interface are used by `Game`:
 *
 *   - `isOnline`: true when the sink is backed by a server-authoritative
 *     game row (OnlineSink). Used by `Game.undoPair()` to refuse — rewinding
 *     locally would desync from the Supabase `games` row.
 *
 *   - `resign?`: optional lifetime-end path. OnlineSink implements it to
 *     flip `games.status` to `'resigned'`. Local sinks simply no-op.
 */
export interface MoveSink {
  /** Submit a move from the local seat. Local sinks apply synchronously;
   *  online sinks apply optimistically and then queue a server write. */
  submitMove(input: ApplyMoveInput): Promise<void>;
  /** True when the sink represents a multiplayer row backed by Supabase realtime. */
  readonly isOnline: boolean;
  /** Optional server-side resignation marker. Local sinks no-op. */
  resign?(): Promise<void>;
}
