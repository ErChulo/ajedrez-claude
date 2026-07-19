-- Row Level Security for online play.
-- A user who has completed `signInAnonymously()` carries a JWT with role
-- "authenticated" — NOT "anon". The "anon" Postgres role in Supabase is for
-- *unauthenticated* requests. Policies must therefore target `to authenticated`.
--
-- Apply schema.sql FIRST, then this file.

alter table games enable row level security;
alter table moves enable row level security;

-- Anyone authenticated can read any game.
create policy games_read_authenticated
  on games
  for select
  to authenticated
  using (true);

-- A client may *claim* the black seat on a waiting game they did not create.
create policy games_join_open
  on games
  for update
  to authenticated
  using (
    status = 'waiting'
    and black_player_id is null
    and white_player_id <> auth.uid()
  )
  with check (
    status in ('waiting','active')
    and white_player_id is not null
    and (black_player_id = auth.uid() or black_player_id is null)
  );

-- Only the two seated players can update an in-flight game.
create policy games_update_seated
  on games
  for update
  to authenticated
  using (auth.uid() in (white_player_id, black_player_id))
  with check (auth.uid() in (white_player_id, black_player_id) or status in ('waiting','aborted'));

-- Rate-limited game creation: at most 3 active games per user.
create policy games_create_limited
  on games
  for insert
  to authenticated
  with check (
    white_player_id = auth.uid()
    and (
      select count(*) from games
        where white_player_id = auth.uid()
          and status in ('waiting','active')
    ) < 3
  );

-- Insert helper: only allow moves when it is the inserting user's turn,
-- implemented server-side.
create or replace function is_my_turn(game_uuid uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from games g
      where g.id = game_uuid
        and g.status = 'active'
        and (
          (g.turn = 'white' and g.white_player_id = auth.uid())
          or (g.turn = 'black' and g.black_player_id = auth.uid())
        )
  );
$$;

create policy moves_insert_only_on_turn
  on moves
  for insert
  to authenticated
  with check (
    by_player_id = auth.uid()
    and is_my_turn(game_id)
  );

create policy moves_read_authenticated
  on moves
  for select
  to authenticated
  using (true);
