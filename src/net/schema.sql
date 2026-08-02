-- Ajedrez — Postgres schema for online multiplayer.
-- Apply this in the Supabase SQL editor after creating your project.
-- Realtime should be enabled on both tables (Database -> Replication) so that
-- the opponent's moves/clocks push to each client the moment they're written.

create extension if not exists "pgcrypto";

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  white_player_id uuid,
  black_player_id uuid,
  white_display_name text not null check (char_length(white_display_name) between 1 and 20),
  black_display_name text check (char_length(black_display_name) between 1 and 20),
  fen text not null default 'start',
  pgn text not null default '',
  status text not null default 'waiting'
    check (status in ('waiting','active','checkmate','stalemate','draw','resigned','aborted')),
  turn text not null default 'white' check (turn in ('white','black')),
  initial_seconds int not null check (initial_seconds > 0 and initial_seconds <= 86400),
  increment_seconds int not null default 0 check (increment_seconds >= 0 and increment_seconds <= 600),
  white_time_remaining_ms bigint not null check (white_time_remaining_ms >= 0),
  black_time_remaining_ms bigint not null check (black_time_remaining_ms >= 0),
  last_move_at timestamptz,
  join_code text unique not null check (char_length(join_code) between 4 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists games_status_idx on games (status);
create index if not exists games_join_code_idx on games (join_code);

create table if not exists moves (
  id bigint generated always as identity primary key,
  game_id uuid not null references games(id) on delete cascade,
  move_index int not null check (move_index > 0),
  san text not null check (char_length(san) between 1 and 9),
  from_square text not null check (from_square ~ '^[a-h][1-8]$'),
  to_square text not null check (to_square ~ '^[a-h][1-8]$'),
  promotion text check (promotion is null or promotion in ('q','r','b','n')),
  fen_after text not null,
  by_player_id uuid not null,
  created_at timestamptz not null default now(),
  unique (game_id, move_index)
);

create index if not exists moves_game_id_idx on moves (game_id, move_index);

-- Touch updated_at automatically.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists games_touch_updated_at on games;
create trigger games_touch_updated_at
  before update on games
  for each row execute function touch_updated_at();

-- Realtime publication: in the dashboard OR via SQL:
--   alter publication supabase_realtime add table games, moves;
-- (Realtime UPDATEs on `games` speed up turn/clock recovery; the client polls
--  as a backstop even if this publication step is skipped, so it is NOT required
--  for correctness.)

-- -----------------------------------------------------------------------------
-- Online move submission (source of truth for OnlineSink.sendOnlineMove).
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS: the JS client writes a move as "INSERT moves THEN UPDATE
-- games". Those are two separate REST round-trips; if the INSERT lands but the
-- game-row UPDATE is dropped (transient 429 / network blip / tab-throttle),
-- `games.turn` never flips and the OPPONENT is permanently frozen (its
-- turn-control gate waits for a row update that never comes). The client's 5s
-- reconcile can replay *moves*, but it cannot fabricate a games-row that was
-- never written — so the freeze survives the heartbeat fix.
--
-- `record_move` performs INSERT + UPDATE inside ONE transaction, so the games
-- row can never be left ahead of (or behind) the moves table. OnlineSink calls
-- it via `sb.rpc`; if the function is absent (SQL not yet deployed to the live
-- project), the client transparently falls back to INSERT+UPDATE-with-retry,
-- and the same reconcile's CAS self-heal repairs any row corrupted before
-- deployment. So: works without the SQL, strictly better with it.
-- DEPLOY: paste the whole function into the Supabase SQL editor (no args).
create or replace function record_move(
  p_game_id            uuid,
  p_by_player_id       uuid,
  p_san                text,
  p_from               text,
  p_to                 text,
  p_promotion          text,
  p_fen_after          text,
  p_pgn                text,
  p_turn               text,
  p_status             text,
  p_white_time_remaining_ms bigint,
  p_black_time_remaining_ms bigint,
           p_last_move_at       timestamptz
)
returns int
language plpgsql
security definer
as $$
declare
  v_next_idx int;
begin
  -- Server-side turn gate (replaces the moves-table RLS check inside the
  -- function body; the RLS `is_my_turn` function is owned by this project).
  if not is_my_turn(p_game_id) then
    raise exception 'not_your_turn' using ERRCODE = '45000';
  end if;
  -- Compute the next move_index atomically (no client↔server race on
  -- max(move_index) between a SELECT and the INSERT).
  select max(move_index) into v_next_idx from moves where game_id = p_game_id;
  v_next_idx := coalesce(v_next_idx, 0) + 1;
  insert into moves (game_id, move_index, san, from_square, to_square,
                     promotion, fen_after, by_player_id)
  values (p_game_id, v_next_idx, p_san, p_from, p_to,
          p_promotion, p_fen_after, p_by_player_id);
  -- Turn flip + clock/commit happen in the SAME transaction as the INSERT:
  -- either both persist or the whole statement rolls back (no half-written row).
  update games
    set fen                       = p_fen_after,
        pgn                       = p_pgn,
        status                    = p_status,
        turn                      = p_turn,
        white_time_remaining_ms   = p_white_time_remaining_ms,
        black_time_remaining_ms   = p_black_time_remaining_ms,
        last_move_at              = p_last_move_at,
        updated_at                = now()
  where id = p_game_id;
  return v_next_idx;
end;
$$;
