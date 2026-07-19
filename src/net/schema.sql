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
