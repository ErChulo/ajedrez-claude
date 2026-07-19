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

export async function fetchOnlineGame(gameId: string): Promise<OnlineGameMeta | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.from("games").select("*").eq("id", gameId).maybeSingle();
  return data ? rowToMeta(data) : null;
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
  turn: Side;
  whiteTimeMs: number;
  blackTimeMs: number;
  lastMoveAtIso: string;
}): Promise<void> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");
  const { data: auth } = await sb.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) throw new Error("Anonymous sign-in not established");
  // 1) Determine next move_index from the current moves list.
  const { data: last } = await sb.from("moves")
    .select("move_index")
    .eq("game_id", opts.gameId)
    .order("move_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextIdx = (last?.move_index ?? 0) + 1;
  // 2) Insert move. RLS `moves_insert_only_on_turn` + `is_my_turn()` is the
  //    server-side gate that protects against out-of-turn inserts.
  const { error: moveErr } = await sb.from("moves").insert({
    game_id: opts.gameId,
    move_index: nextIdx,
    san: opts.san,
    from_square: opts.from,
    to_square: opts.to,
    promotion: opts.promotion,
    fen_after: opts.fenAfter,
    by_player_id: uid,
  });
  if (moveErr) throw new Error("Move rejected by RLS: " + moveErr.message);
  // 3) Update game row: turn flips, clocks reflect post-increment values,
  //    last_move_at anchors for client clock drift correction.
  const { error: gameErr } = await sb.from("games").update({
    fen: opts.fenAfter,
    turn: opts.turn,
    white_time_remaining_ms: opts.whiteTimeMs,
    black_time_remaining_ms: opts.blackTimeMs,
    last_move_at: opts.lastMoveAtIso,
  }).eq("id", opts.gameId);
  if (gameErr) throw new Error("Game update rejected by RLS: " + gameErr.message);
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
