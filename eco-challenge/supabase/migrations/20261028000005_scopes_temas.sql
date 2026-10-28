-- =====================================================================
-- SSOMA ECO CHALLENGE · 005 · Ámbitos configurables y temas
-- Generaliza el juego: además de residuos sólidos (municipal / no
-- municipal) admite otros temas, como Riesgos Críticos, cuyos
-- "contenedores" son los riesgos y cuyas tarjetas son los controles.
-- Los datos de cada tema se cargan aparte (no se incluyen en el
-- repositorio cuando son confidenciales).
-- =====================================================================

create table if not exists public.scopes (
  code        text primary key check (code ~ '^[a-z_]{3,30}$'),
  theme       text not null check (theme in ('residuos', 'riesgos')),
  name        text not null check (char_length(btrim(name)) between 3 and 80),
  description text,
  prompt      text,
  sort_order  int  not null default 0
);

insert into public.scopes (code, theme, name, description, prompt, sort_order) values
  ('municipal', 'residuos', 'Municipal',
   '4 contenedores: verde, marrón, negro y rojo (NTP 900.058:2019).',
   'Arrastra cada residuo a su contenedor.', 1),
  ('no_municipal', 'residuos', 'No municipal',
   '7 contenedores: azul, blanco, amarillo, plomo, marrón, rojo y negro (NTP 900.058:2019).',
   'Arrastra cada residuo a su contenedor.', 2)
on conflict (code) do nothing;

alter table public.scopes enable row level security;
drop policy if exists scopes_read on public.scopes;
drop policy if exists scopes_admin_write on public.scopes;
create policy scopes_read on public.scopes for select to anon, authenticated using (true);
create policy scopes_admin_write on public.scopes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke insert, update, delete, truncate on public.scopes from anon;
grant select on public.scopes to anon, authenticated;

-- Las restricciones fijas de ámbito se reemplazan por claves foráneas.
alter table public.bins           drop constraint if exists bins_scope_check;
alter table public.waste_items    drop constraint if exists waste_items_scope_check;
alter table public.question_banks drop constraint if exists question_banks_scope_check;
alter table public.games          drop constraint if exists games_scope_check;

alter table public.bins           drop constraint if exists bins_scope_fk;
alter table public.waste_items    drop constraint if exists waste_items_scope_fk;
alter table public.question_banks drop constraint if exists question_banks_scope_fk;
alter table public.games          drop constraint if exists games_scope_fk;
alter table public.bins           add constraint bins_scope_fk           foreign key (scope) references public.scopes (code);
alter table public.waste_items    add constraint waste_items_scope_fk    foreign key (scope) references public.scopes (code);
alter table public.question_banks add constraint question_banks_scope_fk foreign key (scope) references public.scopes (code);
alter table public.games          add constraint games_scope_fk          foreign key (scope) references public.scopes (code);

-- Los controles de riesgos críticos son textos más largos que los nombres de residuos.
alter table public.waste_items drop constraint if exists waste_items_name_check;
alter table public.waste_items add constraint waste_items_name_check
  check (char_length(btrim(name)) between 2 and 160);

create or replace function public._scope_json(p_scope text)
returns json language sql stable security definer
set search_path = public, pg_temp
as $$
  select json_build_object('code', code, 'theme', theme, 'name', name,
                           'description', description, 'prompt', prompt)
    from public.scopes where code = p_scope;
$$;

-- create_game: el ámbito debe existir en la tabla de ámbitos.
create or replace function public.create_game(
  p_scope            text,
  p_bank_id          uuid default null,
  p_title            text default null,
  p_round_duration_s int  default 60,
  p_base_points      int  default 100,
  p_speed_bonus_max  int  default 50,
  p_items_per_round  int  default 8,
  p_total_rounds     int  default 3,
  p_feedback_mode    text default 'inmediata'
)
returns public.games
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_bank public.question_banks;
  v_available int;
  v_code text;
  g public.games;
  i int := 0;
begin
  if not public.is_staff() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  if p_scope is null or not exists (select 1 from public.scopes where code = p_scope) then
    raise exception 'AMBITO_REQUERIDO: indique un ámbito válido' using errcode = '22023';
  end if;
  if p_bank_id is not null then
    select * into v_bank from public.question_banks where id = p_bank_id;
    if not found then
      raise exception 'BANCO_NO_ENCONTRADO' using errcode = 'P0002';
    end if;
    if v_bank.scope <> p_scope then
      raise exception 'AMBITO_DISTINTO: el banco es de ámbito %', v_bank.scope using errcode = '22023';
    end if;
  end if;

  select count(*) into v_available
    from public.waste_items w
   where w.scope = p_scope and w.active and w.status = 'aprobado'
     and (p_bank_id is null or exists (select 1 from public.bank_items bi
                                        where bi.bank_id = p_bank_id and bi.item_id = w.id));
  if v_available = 0 then
    raise exception 'BANCO_VACIO: no hay elementos aprobados y activos para este ámbito/banco'
      using errcode = 'P0001';
  end if;

  loop
    i := i + 1;
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.games (code, title, instructor_id, bank_id, bank_name, scope,
                                round_duration_s, base_points, speed_bonus_max, items_per_round,
                                total_rounds, feedback_mode)
      values (v_code, nullif(btrim(p_title), ''), auth.uid(), p_bank_id, v_bank.name, p_scope,
              p_round_duration_s, p_base_points, p_speed_bonus_max, p_items_per_round,
              p_total_rounds, p_feedback_mode)
      returning * into g;
      return g;
    exception when unique_violation then
      if i > 20 then raise; end if;
    end;
  end loop;
end;
$$;

-- host_state: incluye la información del ámbito/tema.
create or replace function public.host_state(p_game_id uuid)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games;
  r public.rounds;
  v_round json;
begin
  perform public._assert_owner(p_game_id);
  perform public._sync_game(p_game_id);
  select * into g from public.games where id = p_game_id;
  select * into r from public.rounds where game_id = g.id and round_no = g.current_round;

  if found then
    v_round := json_build_object(
      'id', r.id, 'round_no', r.round_no, 'status', r.status, 'duration_s', r.duration_s,
      'started_at', r.started_at, 'ends_at', r.ends_at, 'paused_at', r.paused_at,
      'items', (select coalesce(json_agg(json_build_object(
                  'id', ri.item_id, 'name', ri.name, 'image_url', ri.image_url,
                  'correct_bin', case when r.status = 'ended' then ri.correct_bin end,
                  'explanation', case when r.status = 'ended' then ri.explanation end,
                  'answers', (select count(*) from public.answers a
                               where a.round_id = r.id and a.item_id = ri.item_id),
                  'correct', case when r.status = 'ended' then
                               (select count(*) from public.answers a
                                 where a.round_id = r.id and a.item_id = ri.item_id and a.is_correct) end
                ) order by ri.position), '[]'::json)
                  from public.round_items ri where ri.round_id = r.id),
      'answers_total', (select count(*) from public.answers a where a.round_id = r.id),
      'players_done', (select count(*) from (
                         select a.player_id from public.answers a where a.round_id = r.id
                          group by a.player_id
                         having count(*) >= (select count(*) from public.round_items ri where ri.round_id = r.id)
                       ) x)
    );
  end if;

  return json_build_object(
    'server_now', now(),
    'game', to_json(g),
    'scope_info', public._scope_json(g.scope),
    'bins', public._bins_json(g.scope),
    'round', v_round,
    'players', (select coalesce(json_agg(json_build_object(
                  'id', p.id, 'alias', p.alias, 'kicked', p.kicked, 'joined_at', p.joined_at,
                  'connected', p.last_seen > now() - interval '30 seconds') order by p.joined_at), '[]'::json)
                  from public.players p where p.game_id = g.id),
    'leaderboard', (select coalesce(json_agg(to_json(s)), '[]'::json)
                      from public._scores(g.id) s)
  );
end;
$$;

-- player_state: incluye nombre del ámbito y tema.
create or replace function public.player_state(p_token text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  p public.players := public._player_by_token(p_token);
  g public.games;
  r public.rounds;
  s public.scopes;
  v_has_round boolean;
  v_hide boolean;
  v_ended boolean;
  v_round json;
  v_me json;
begin
  update public.players set last_seen = now()
   where id = p.id and last_seen < now() - interval '5 seconds';
  perform public._sync_game(p.game_id);
  select * into g from public.games where id = p.game_id;

  if p.kicked or g.status = 'closed' then
    return json_build_object('server_now', now(),
      'player', json_build_object('id', p.id, 'alias', p.alias, 'kicked', p.kicked),
      'game', json_build_object('id', g.id, 'code', g.code, 'status', g.status));
  end if;

  select * into s from public.scopes where code = g.scope;
  select * into r from public.rounds where game_id = g.id and round_no = g.current_round;
  v_has_round := found;
  v_ended := v_has_round and r.status = 'ended';
  v_hide := v_has_round and g.feedback_mode = 'al_final' and not v_ended;

  if v_has_round then
    v_round := json_build_object(
      'id', r.id, 'round_no', r.round_no, 'status', r.status, 'duration_s', r.duration_s,
      'started_at', r.started_at, 'ends_at', r.ends_at, 'paused_at', r.paused_at,
      'items', (select coalesce(json_agg(json_build_object(
                  'id', ri.item_id, 'name', ri.name, 'image_url', ri.image_url,
                  'correct_bin', case when v_ended then ri.correct_bin end,
                  'explanation', case when v_ended then ri.explanation end
                ) order by ri.position), '[]'::json)
                  from public.round_items ri where ri.round_id = r.id),
      'my_answers', (select coalesce(json_agg(json_build_object(
                       'item_id', a.item_id, 'chosen_bin', a.chosen_bin,
                       'is_correct', case when v_hide then null else a.is_correct end,
                       'points', case when v_hide then null else a.points end,
                       'correct_bin', case when v_hide then null else ri.correct_bin end,
                       'explanation', case when v_hide then null else ri.explanation end)), '[]'::json)
                       from public.answers a
                       join public.round_items ri on ri.round_id = a.round_id and ri.item_id = a.item_id
                      where a.round_id = r.id and a.player_id = p.id)
    );
  end if;

  select json_build_object('score', sc.score, 'correct', sc.correct, 'correct_ms', sc.correct_ms,
                           'pos', sc.pos,
                           'total_players', (select count(*) from public.players x
                                              where x.game_id = g.id and not x.kicked))
    into v_me
    from public._scores(g.id, case when v_hide then r.id end) sc
   where sc.player_id = p.id;

  return json_build_object(
    'server_now', now(),
    'player', json_build_object('id', p.id, 'alias', p.alias, 'kicked', false),
    'game', json_build_object(
      'id', g.id, 'code', g.code, 'title', g.title, 'scope', g.scope,
      'scope_name', s.name, 'theme', s.theme, 'prompt', s.prompt, 'status', g.status,
      'current_round', g.current_round, 'total_rounds', g.total_rounds,
      'round_duration_s', g.round_duration_s, 'base_points', g.base_points,
      'speed_bonus_max', g.speed_bonus_max, 'feedback_mode', g.feedback_mode),
    'bins', public._bins_json(g.scope),
    'round', v_round,
    'me', v_me,
    'leaderboard', case when g.status in ('between_rounds', 'finished') then
      (select coalesce(json_agg(json_build_object('alias', x.alias, 'score', x.score,
                                                  'correct', x.correct, 'pos', x.pos)), '[]'::json)
         from (select * from public._scores(g.id) limit 10) x) end
  );
end;
$$;

revoke execute on function public._scope_json(text) from public, anon, authenticated;
