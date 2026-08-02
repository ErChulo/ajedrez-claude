// Online-play helpers built on top of src/net/supabase.ts.
// All functions are no-op or throw "not configured" if Supabase env is missing.
//
// Realtime channels live at:
//
//   channel "game:<id>"  — POSTGRES UPDATE on games where id = <id>
//   channel "moves:<id>" — POSTGRES INSERT on moves where game_id = <id>
//
// Each subscribe returns an `{ unsubscribe }` token. The OnlineSink stores
// both and clears them on destroy.

import { getSupabase } from "./supabase";
import type { Side } from "@/types";

// Whether the transactional `record_move` RPC is deployed on the live project.
// Feature-detected once per page-load (null=untried, true=available, false=not
// deployed -> use the REST INSERT+UPDATE-with-retry fallback in sendOnlineMove).
let rpcAvailable: boolean | null = null;

// Detects a "function does not exist" RPC error so the client can transparently
// fall back to the REST write path when the SQL hasn't been applied yet.
function isMissingRpcError(error: { code?: string; message?: string; details?: string } | null, status: number | undefined): boolean {
  if (!error) return false;
  const code = error.code;
  const msg = (error.message ?? "").toLowerCase();
  const details = (error.details ?? "").toLowerCase();
  // postgrest/GoTrue: undefined_function (PG code 4288/4274) or a 404 when the
  // rpc endpoint maps to a nonexistent function.
  return (
    code === "4288" ||
    code === "4274" ||
    code === "PG" && (msg.includes("does not exist") || msg.includes("record_move") || details.includes("record_move") || details.includes("does not exist")) ||
    status === 404
  );
}

export interface OnlineGameMeta {
  id: string;
  whitePlayerId: string | null;
  blackPlayerId: string | null;
  whiteDisplayName: string;
  blackDisplayName: string | null;
  status: "waiting" | "active" | "checkmate" | "stalemate" | "draw" | "resigned" | "aborted";
  turn: Side;
  initialSeconds: number;
  incrementSeconds: number;
  whiteTimeRemainingMs: number;
  blackTimeRemainingMs: number;
  lastMoveAt: string | null;
  joinCode: string;
  fen: string;
  pgn: string;
}

export interface OnlineMoveRow {
  id: number;
  game_id: string;
  move_index: number;
  san: string;
  from_square: string;
  to_square: string;
  promotion: "q" | "r" | "b" | "n" | null;
  fen_after: string;
  by_player_id: string;
  created_at: string;
}

// ---- Code generation ----
// Unambiguous chars (no 0/O, 1/I) so the code is typo-friendly when typing
// from a friend. The schema's unique constraint is the source of truth.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}
async function generateUniqueJoinCode(): Promise<string> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");
  for (let i = 0; i < 8; i++) {
    const code = generateJoinCode();
    const { data } = await sb.from("games").select("id").eq("join_code", code).maybeSingle();
    if (!data) return code;
  }
  // Last-resort fallback: trust the unique constraint on INSERT.
  return generateJoinCode();
}

export async function createOnlineGame(opts: {
  whiteDisplayName: string;
  initialSeconds: number;
  incrementSeconds: number;
}): Promise<OnlineGameMeta> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");
  const { data: auth } = await sb.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Anonymous sign-in not established");
  const code = await generateUniqueJoinCode();
  const initialMs = opts.initialSeconds * 1000;
  const { data, error } = await sb.from("games").insert({
    white_player_id: uid,
    white_display_name: opts.whiteDisplayName,
    join_code: code,
    initial_seconds: opts.initialSeconds,
    increment_seconds: opts.incrementSeconds,
    white_time_remaining_ms: initialMs,
    black_time_remaining_ms: initialMs,
  }).select("*").single();
  if (error || !data) throw new Error("Game insert failed: " + (error?.message ?? "no row returned"));
  return rowToMeta(data);
}

export async function joinOnlineGame(opts: {
  joinCode: string;
  blackDisplayName: string;
}): Promise<OnlineGameMeta> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");
  const { data: auth } = await sb.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Anonymous sign-in not established");
  // Single round-trip: UPDATE black seat on a waiting game; RLS `games_join_open`
  // enforces that we don't already own the white seat and black is null.
  const { data, error } = await sb.from("games").update({
    black_player_id: uid,
    black_display_name: opts.blackDisplayName,
    status: "active",
  })
    .eq("join_code", opts.joinCode)
    .eq("status", "waiting")
    .is("black_player_id", null)
    .select("*")
    .single();
  if (error || !data) throw new Error("Join failed: " + (error?.message ?? "no row updated"));
  return rowToMeta(data);
}

export async function fetchOnlineMoves(
  gameId: string,
  afterMoveIndex: number,
): Promise<OnlineMoveRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb.from("moves")
    .select("*")
    .eq("game_id", gameId)
    .gt("move_index", afterMoveIndex)
    .order("move_index", { ascending: true });
  return (data ?? []).map((row) => ({
    id: row.id,
    game_id: row.game_id,
    move_index: Number(row.move_index),
    san: row.san,
    from_square: row.from_square,
    to_square: row.to_square,
    promotion: row.promotion as OnlineMoveRow["promotion"],
    fen_after: row.fen_after,
    by_player_id: row.by_player_id,
    created_at: row.created_at,
  }));
}

export async function fetchOnlineGame(gameId: string): Promise<OnlineGameMeta | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.from("games").select("*").eq("id", gameId).maybeSingle();
  return data ? rowToMeta(data) : null;
}

/**
 * Self-heal for a games row left stale by a dropped games UPDATE (the root
 * cause of the permanent online freeze): `games.turn` never flipped even though
 * the `moves` table has the move. This is a single-statement CAS UPDATE, so it
 * is atomic at the row level; the OnlineSink reconcile loop invokes it.
 *
 * Safety: the caller must be at the HEAD of the moves table — we verify its
 * engine fen matches the latest move's `fen_after` before writing, so a
 * catching-up client can NEVER clobber the row with stale data. The
 * `eq("turn", staleTurn)` guard is a compare-and-swap: only the first repairer
 * wins (others match 0 rows and no-op). Returns true if this caller repaired.
 */
export async function selfHealGameRow(
  gameId: string,
  opts: {
    staleTurn: Side;
    turn: Side;
    fen: string;
    pgn: string;
    status: OnlineGameMeta["status"];
  },
): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  if (opts.staleTurn === opts.turn) return false; // already consistent
  const { data: latest } = await sb.from("moves")
    .select("fen_after")
    .eq("game_id", gameId)
    .order("move_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  // If the moves table's head doesn't match the caller's engine, the caller
  // isn't authoritative yet — wait for the next reconcile to re-apply.
  if (latest && latest.fen_after !== opts.fen) return false;
  const { data, error } = await sb.from("games")
    .update({
      fen: opts.fen,
      pgn: opts.pgn,
      status: opts.status,
      turn: opts.turn,
    })
    .eq("id", gameId)
    .eq("turn", opts.staleTurn)
    .select();
  if (error) {
    console.warn("OnlineSink self-heal failed", error);
    return false;
  }
  // .select() on an UPDATE returns the matched+updated rows; length>0 means
  // our CAS matched (we repaired), 0 means the row was already fixed by someone
  // else. Either way it's now consistent.
  return Array.isArray(data) && data.length > 0;
}

export async function listWaitingGames(): Promise<OnlineGameMeta[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data } = await sb.from("games").select("*")
    .eq("status", "waiting")
    .is("black_player_id", null)
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []).map(rowToMeta);
}

// ---- Realtime subscriptions ----

export function subscribeGame(
  gameId: string,
  handler: (row: OnlineGameMeta) => void,
): { unsubscribe: () => void } {
  const sb = getSupabase();
  if (!sb) return { unsubscribe: () => {} };
  const channel = sb.channel(`game:${gameId}`)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
      (payload) => { if (payload.new) handler(rowToMeta(payload.new as GameRow)); })
    .subscribe();
  return { unsubscribe: () => { void sb.removeChannel(channel); } };
}

export function subscribeMoves(
  gameId: string,
  handler: (move: OnlineMoveRow) => void,
): { unsubscribe: () => void } {
  const sb = getSupabase();
  if (!sb) return { unsubscribe: () => {} };
  const channel = sb.channel(`moves:${gameId}`)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "moves", filter: `game_id=eq.${gameId}` },
      (payload) => { if (payload.new) handler(payload.new as OnlineMoveRow); })
    .subscribe();
  return { unsubscribe: () => { void sb.removeChannel(channel); } };
}

// ---- Move submission ----

export async function sendOnlineMove(opts: {
  gameId: string;
  san: string;
  from: string;
  to: string;
  promotion: string | null;
  fenAfter: string;
  pgn: string;
  turn: Side;
  status: OnlineGameMeta["status"];
  whiteTimeMs: number;
  blackTimeMs: number;
  lastMoveAtIso: string;
}): Promise<number> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");
  const { data: auth } = await sb.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Anonymous sign-in not established");

  // Preferred path: the transactional `record_move` RPC (INSERT + UPDATE in one
  // Postgres transaction) so a move is never inserted without its games-row turn
  // flip — a dropped games UPDATE is the root cause of the online freeze.
  // Feature-detected once per page-load: if the function isn't deployed yet,
  // fall back to the REST INSERT+UPDATE-with-retry path below.
  if (rpcAvailable !== false) {
    const { data, error, status } = await sb.rpc("record_move", {
      p_game_id: opts.gameId,
      p_by_player_id: uid,
      p_san: opts.san,
      p_from: opts.from,
      p_to: opts.to,
      p_promotion: opts.promotion,
      p_fen_after: opts.fenAfter,
      p_pgn: opts.pgn,
      p_turn: opts.turn,
      p_status: opts.status,
      p_white_time_remaining_ms: Math.max(0, Math.round(opts.whiteTimeMs)),
      p_black_time_remaining_ms: Math.max(0, Math.round(opts.blackTimeMs)),
      p_last_move_at: opts.lastMoveAtIso,
    });
    if (!error) {
      rpcAvailable = true;
      return Number(data ?? 0) || 0;
    }
    // 404 / "function does not exist" -> the SQL hasn't been applied to the
    // live project yet; remember that and use the REST fallback.
    if (isMissingRpcError(error, status)) {
      rpcAvailable = false;
    } else {
      throw new Error("Move rejected by server: " + error.message);
    }
  }

  // REST fallback (used until record_move is deployed). INSERT the move, then
  // UPDATE the games row with a small retry: a transient blip on the games
  // UPDATE leaves games.turn stale, which permanently freezes the opponent.
  // Retrying the single-row UPDATE recovers it; OnlineSink.reconcile's CAS
  // self-heal is the guaranteed recovery for any row that still ends up corrupt.
  const { data: last } = await sb.from("moves")
    .select("move_index")
    .eq("game_id", opts.gameId)
    .order("move_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextIdx = (last?.move_index ?? 0) + 1;
  const { data: insertedMove, error: moveErr } = await sb.from("moves").insert({
    game_id: opts.gameId,
    move_index: nextIdx,
    san: opts.san,
    from_square: opts.from,
    to_square: opts.to,
    promotion: opts.promotion,
    fen_after: opts.fenAfter,
    by_player_id: uid,
  }).select("move_index").single();
  if (moveErr) throw new Error("Move rejected by RLS: " + moveErr.message);
  let gameErr: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await sb.from("games").update({
      fen: opts.fenAfter,
      pgn: opts.pgn,
      status: opts.status,
      turn: opts.turn,
      white_time_remaining_ms: Math.max(0, Math.round(opts.whiteTimeMs)),
      black_time_remaining_ms: Math.max(0, Math.round(opts.blackTimeMs)),
      last_move_at: opts.lastMoveAtIso,
    }).eq("id", opts.gameId);
    if (!error) return insertedMove?.move_index ?? nextIdx;
    gameErr = error;
  }
  throw new Error("Game update rejected by RLS after retries: " + (gameErr?.message ?? "unknown"));
}

export async function resignOnlineGame(gameId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb.from("games").update({ status: "resigned" }).eq("id", gameId);
}

export async function abortOnlineGame(gameId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb.from("games").update({ status: "aborted" }).eq("id", gameId);
}

// ---- Type conversion ----
// Supabase returns plain rows cast as `any` from `.select("*")`. This helper
// narrows them into our `OnlineGameMeta` shape (snake_case → camelCase) and
// coerces bigint-ish numerics to plain JS numbers.
function rowToMeta(row: GameRow): OnlineGameMeta {
  return {
    id: row.id,
    whitePlayerId: row.white_player_id,
    blackPlayerId: row.black_player_id,
    whiteDisplayName: row.white_display_name,
    blackDisplayName: row.black_display_name,
    status: row.status,
    turn: row.turn,
    initialSeconds: row.initial_seconds,
    incrementSeconds: row.increment_seconds,
    whiteTimeRemainingMs: Number(row.white_time_remaining_ms),
    blackTimeRemainingMs: Number(row.black_time_remaining_ms),
    lastMoveAt: row.last_move_at,
    joinCode: row.join_code,
    fen: row.fen,
    pgn: row.pgn,
  };
}

interface GameRow {
  id: string;
  white_player_id: string | null;
  black_player_id: string | null;
  white_display_name: string;
  black_display_name: string | null;
  status: OnlineGameMeta["status"];
  turn: Side;
  initial_seconds: number;
  increment_seconds: number;
  white_time_remaining_ms: number | string;
  black_time_remaining_ms: number | string;
  last_move_at: string | null;
  join_code: string;
  fen: string;
  pgn: string;
}
