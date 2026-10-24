-- =====================================================================
-- SSOMA ECO CHALLENGE · 002 · Lógica de juego en el servidor (RPC)
-- El servidor controla el tiempo, valida respuestas y calcula puntajes.
-- =====================================================================

-- Margen de latencia de red aceptado después de que el cronómetro llega a 0.
create or replace function public._grace()
returns interval language sql immutable as $$ select interval '1 second' $$;

-- Cuenta regresiva "¡Prepárate!" antes de que empiece a correr el tiempo:
-- compensa la latencia con la que cada celular recibe el inicio de ronda.
create or replace function public._lead_in()
returns interval language sql immutable as $$ select interval '3 seconds' $$;

create or replace function public._token_hash(p_token text)
returns bytea language sql immutable as $$ select sha256(convert_to(coalesce(p_token, ''), 'UTF8')) $$;

-- ---------------------------------------------------------------------
-- Ayudantes internos
-- ---------------------------------------------------------------------
create or replace function public._assert_owner(p_game_id uuid)
returns public.games
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games;
begin
  if not public.is_staff() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  select * into g from public.games where id = p_game_id for update;
  if not found or (g.instructor_id <> auth.uid() and not public.is_admin()) then
    raise exception 'PARTIDA_NO_ENCONTRADA' using errcode = 'P0002';
  end if;
  return g;
end;
$$;

-- Cierra de forma perezosa (idempotente) la ronda cuyo tiempo ya venció.
create or replace function public._sync_game(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update public.rounds
     set status = 'ended', ended_at = ends_at
   where game_id = p_game_id and status = 'running' and now() > ends_at + public._grace();
  if found then
    update public.games set status = 'between_rounds'
     where id = p_game_id and status = 'running';
  end if;
end;
$$;

create or replace function public._player_by_token(p_token text)
returns public.players
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  p public.players;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'SESION_INVALIDA' using errcode = '28000';
  end if;
  select * into p from public.players where token_hash = public._token_hash(p_token);
  if not found then
    raise exception 'SESION_INVALIDA' using errcode = '28000';
  end if;
  return p;
end;
$$;

-- Ranking con desempate: 1) mayor puntaje, 2) más aciertos,
-- 3) menor tiempo acumulado en respuestas correctas.
create or replace function public._scores(p_game_id uuid, p_exclude_round uuid default null)
returns table (player_id uuid, alias text, score bigint, correct bigint, correct_ms bigint,
               answered bigint, pos bigint)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with s as (
    select p.id, p.alias, p.joined_at,
           coalesce(sum(a.points), 0)::bigint                                  as score,
           count(a.id) filter (where a.is_correct)::bigint                     as correct,
           coalesce(sum(a.response_ms) filter (where a.is_correct), 0)::bigint as correct_ms,
           count(a.id)::bigint                                                  as answered
      from public.players p
      left join public.answers a
        on a.player_id = p.id
       and (p_exclude_round is null or a.round_id <> p_exclude_round)
     where p.game_id = p_game_id and not p.kicked
     group by p.id
  )
  select id, alias, score, correct, correct_ms, answered,
         rank() over (order by score desc, correct desc, correct_ms asc) as pos
    from s
   order by pos, joined_at;
$$;

create or replace function public._bins_json(p_scope text)
returns json language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(json_agg(json_build_object(
           'code', code, 'color_name', color_name, 'label', label, 'color_hex', color_hex,
           'text_hex', text_hex, 'icon', icon, 'description', description) order by sort_order), '[]'::json)
    from public.bins where scope = p_scope;
$$;

-- ---------------------------------------------------------------------
-- Instructor
-- ---------------------------------------------------------------------
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
  if p_scope not in ('municipal', 'no_municipal') then
    raise exception 'AMBITO_REQUERIDO: indique ámbito municipal o no municipal' using errcode = '22023';
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
    raise exception 'BANCO_VACIO: no hay residuos aprobados y activos para este ámbito/banco'
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

create or replace function public.update_game_settings(
  p_game_id          uuid,
  p_round_duration_s int  default null,
  p_base_points      int  default null,
  p_speed_bonus_max  int  default null,
  p_items_per_round  int  default null,
  p_total_rounds     int  default null,
  p_feedback_mode    text default null
)
returns public.games
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
begin
  perform public._sync_game(p_game_id);
  select * into g from public.games where id = p_game_id;
  if g.status = 'lobby' then
    update public.games set
      round_duration_s = coalesce(p_round_duration_s, round_duration_s),
      base_points      = coalesce(p_base_points, base_points),
      speed_bonus_max  = coalesce(p_speed_bonus_max, speed_bonus_max),
      items_per_round  = coalesce(p_items_per_round, items_per_round),
      total_rounds     = coalesce(p_total_rounds, total_rounds),
      feedback_mode    = coalesce(p_feedback_mode, feedback_mode)
    where id = p_game_id returning * into g;
  elsif g.status = 'between_rounds' then
    -- La puntuación no cambia a mitad de partida para no alterar el ranking.
    if p_base_points is not null or p_speed_bonus_max is not null then
      raise exception 'PUNTUACION_BLOQUEADA: la puntuación sólo se configura antes de iniciar'
        using errcode = 'P0001';
    end if;
    if p_total_rounds is not null and p_total_rounds < g.current_round then
      raise exception 'RONDAS_INVALIDAS' using errcode = '22023';
    end if;
    update public.games set
      round_duration_s = coalesce(p_round_duration_s, round_duration_s),
      items_per_round  = coalesce(p_items_per_round, items_per_round),
      total_rounds     = coalesce(p_total_rounds, total_rounds),
      feedback_mode    = coalesce(p_feedback_mode, feedback_mode)
    where id = p_game_id returning * into g;
  else
    raise exception 'ESTADO_INVALIDO: no se puede configurar durante una ronda' using errcode = 'P0001';
  end if;
  return g;
end;
$$;

create or replace function public.start_round(p_game_id uuid)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
  v_round public.rounds;
  v_count int;
begin
  perform public._sync_game(p_game_id);
  select * into g from public.games where id = p_game_id;
  if g.status not in ('lobby', 'between_rounds') then
    raise exception 'ESTADO_INVALIDO: ya hay una ronda en curso o la partida terminó' using errcode = 'P0001';
  end if;
  if g.current_round >= g.total_rounds then
    raise exception 'SIN_RONDAS: se completaron las % rondas configuradas', g.total_rounds using errcode = 'P0001';
  end if;

  insert into public.rounds (game_id, round_no, duration_s, started_at, ends_at)
  values (g.id, g.current_round + 1, g.round_duration_s,
          now() + public._lead_in(),
          now() + public._lead_in() + make_interval(secs => g.round_duration_s))
  returning * into v_round;

  -- Selección aleatoria; se priorizan residuos aún no usados en esta partida.
  insert into public.round_items (round_id, item_id, position, name, image_url, explanation, correct_bin)
  select v_round.id, c.id, row_number() over (), c.name, c.image_url, c.explanation, c.bin_code
    from (
      select w.*
        from public.waste_items w
       where w.scope = g.scope and w.active and w.status = 'aprobado'
         and (g.bank_id is null or exists (select 1 from public.bank_items bi
                                            where bi.bank_id = g.bank_id and bi.item_id = w.id))
       order by exists (select 1 from public.round_items ri
                          join public.rounds r on r.id = ri.round_id
                         where r.game_id = g.id and ri.item_id = w.id),
                random()
       limit g.items_per_round
    ) c;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'BANCO_VACIO: no hay residuos aprobados y activos para este ámbito/banco'
      using errcode = 'P0001';
  end if;

  update public.games
     set status = 'running', current_round = v_round.round_no,
         started_at = coalesce(started_at, now())
   where id = g.id;

  return json_build_object('round_id', v_round.id, 'round_no', v_round.round_no,
                           'started_at', v_round.started_at, 'ends_at', v_round.ends_at,
                           'items', v_count);
end;
$$;

create or replace function public.pause_round(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
begin
  perform public._sync_game(p_game_id);
  update public.rounds set status = 'paused', paused_at = now()
   where game_id = p_game_id and round_no = g.current_round and status = 'running'
     and now() <= ends_at;
  if not found then
    raise exception 'ESTADO_INVALIDO: no hay ronda en curso' using errcode = 'P0001';
  end if;
  update public.games set status = 'paused' where id = p_game_id;
end;
$$;

create or replace function public.resume_round(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
  r public.rounds;
  d interval;
begin
  select * into r from public.rounds
   where game_id = p_game_id and round_no = g.current_round and status = 'paused' for update;
  if not found then
    raise exception 'ESTADO_INVALIDO: la ronda no está en pausa' using errcode = 'P0001';
  end if;
  d := now() - r.paused_at;
  if r.paused_at < r.started_at then
    -- Pausa durante la cuenta regresiva: se desplaza todo el bloque.
    update public.rounds set status = 'running', paused_at = null,
           started_at = started_at + d, ends_at = ends_at + d
     where id = r.id;
  else
    update public.rounds set status = 'running', paused_at = null,
           ends_at = ends_at + d,
           paused_total_ms = paused_total_ms + (extract(epoch from d) * 1000)::bigint
     where id = r.id;
  end if;
  update public.games set status = 'running' where id = p_game_id;
end;
$$;

create or replace function public.end_round(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
begin
  perform public._sync_game(p_game_id);
  update public.rounds set status = 'ended', ended_at = now(), paused_at = null
   where game_id = p_game_id and round_no = g.current_round and status in ('running', 'paused');
  update public.games set status = 'between_rounds'
   where id = p_game_id and status in ('running', 'paused');
end;
$$;

create or replace function public.finish_game(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
begin
  if g.status in ('finished', 'closed') then
    return;
  end if;
  update public.rounds set status = 'ended', ended_at = least(now(), ends_at), paused_at = null
   where game_id = p_game_id and status in ('running', 'paused');
  update public.games set status = 'finished', finished_at = now() where id = p_game_id;
end;
$$;

create or replace function public.close_game(p_game_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
begin
  update public.rounds set status = 'ended', ended_at = least(now(), ends_at), paused_at = null
   where game_id = p_game_id and status in ('running', 'paused');
  update public.games
     set status = 'closed', closed_at = now(), finished_at = coalesce(finished_at, now())
   where id = p_game_id;
end;
$$;

create or replace function public.kick_player(p_game_id uuid, p_player_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform public._assert_owner(p_game_id);
  update public.players set kicked = true where id = p_player_id and game_id = p_game_id;
end;
$$;

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
                  -- La respuesta correcta no se envía a la pantalla proyectada
                  -- hasta que la ronda termina.
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

create or replace function public.game_results(p_game_id uuid)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games := public._assert_owner(p_game_id);
begin
  return json_build_object(
    'game', to_json(g),
    'ranking', (select coalesce(json_agg(to_json(s)), '[]'::json) from public._scores(g.id) s),
    'answers', (select coalesce(json_agg(json_build_object(
                  'alias', p.alias, 'round_no', r.round_no, 'item', ri.name,
                  'chosen_bin', a.chosen_bin, 'correct_bin', ri.correct_bin,
                  'is_correct', a.is_correct, 'points', a.points, 'response_ms', a.response_ms,
                  'answered_at', a.created_at)
                  order by r.round_no, p.alias, ri.position), '[]'::json)
                  from public.answers a
                  join public.players p on p.id = a.player_id
                  join public.rounds r on r.id = a.round_id
                  join public.round_items ri on ri.round_id = a.round_id and ri.item_id = a.item_id
                 where a.game_id = g.id)
  );
end;
$$;

create or replace function public.my_games(p_limit int default 50)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_staff() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  return (
    select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
      select g.id, g.code, g.title, g.scope, g.status, g.bank_name, g.created_at, g.finished_at,
             g.current_round, g.total_rounds,
             (select count(*) from public.players p where p.game_id = g.id and not p.kicked) as players,
             (select string_agg(s.alias, ', ') from public._scores(g.id) s
               where s.pos = 1 and s.score > 0) as winner
        from public.games g
       where g.instructor_id = auth.uid() or public.is_admin()
       order by g.created_at desc
       limit least(greatest(p_limit, 1), 200)
    ) x
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Participantes (rol anon; identificados por token de sesión aleatorio)
-- ---------------------------------------------------------------------
create or replace function public.join_game(p_code text, p_alias text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g public.games;
  v_alias text := regexp_replace(btrim(coalesce(p_alias, '')), '\s+', ' ', 'g');
  v_token text;
  v_player_id uuid;
begin
  if char_length(v_alias) < 2 or char_length(v_alias) > 20
     or v_alias !~ '^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ _.-]+$' then
    raise exception 'ALIAS_INVALIDO: use de 2 a 20 letras, números, espacio, punto o guion'
      using errcode = '22023';
  end if;
  select * into g from public.games
   where code = btrim(coalesce(p_code, '')) and status <> 'closed'
   for update;
  if not found then
    raise exception 'CODIGO_INVALIDO' using errcode = 'P0002';
  end if;
  if g.status = 'finished' then
    raise exception 'PARTIDA_FINALIZADA' using errcode = 'P0001';
  end if;
  if (select count(*) from public.players where game_id = g.id) >= g.max_players then
    raise exception 'SALA_LLENA' using errcode = 'P0001';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  begin
    insert into public.players (game_id, alias, token_hash)
    values (g.id, v_alias, public._token_hash(v_token))
    returning id into v_player_id;
  exception when unique_violation then
    raise exception 'ALIAS_EN_USO' using errcode = '23505';
  end;

  return json_build_object('player_id', v_player_id, 'token', v_token, 'game_id', g.id,
                           'code', g.code, 'alias', v_alias);
end;
$$;

create or replace function public.player_state(p_token text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  p public.players := public._player_by_token(p_token);
  g public.games;
  r public.rounds;
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

  select * into r from public.rounds where game_id = g.id and round_no = g.current_round;
  v_has_round := found;
  v_ended := v_has_round and r.status = 'ended';
  v_hide := v_has_round and g.feedback_mode = 'al_final' and not v_ended;

  if v_has_round then
    v_round := json_build_object(
      'id', r.id, 'round_no', r.round_no, 'status', r.status, 'duration_s', r.duration_s,
      'started_at', r.started_at, 'ends_at', r.ends_at, 'paused_at', r.paused_at,
      -- Los residuos se envían SIN su contenedor correcto mientras la ronda está abierta.
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

  select json_build_object('score', s.score, 'correct', s.correct, 'correct_ms', s.correct_ms,
                           'pos', s.pos,
                           'total_players', (select count(*) from public.players x
                                              where x.game_id = g.id and not x.kicked))
    into v_me
    from public._scores(g.id, case when v_hide then r.id end) s
   where s.player_id = p.id;

  return json_build_object(
    'server_now', now(),
    'player', json_build_object('id', p.id, 'alias', p.alias, 'kicked', false),
    'game', json_build_object(
      'id', g.id, 'code', g.code, 'title', g.title, 'scope', g.scope, 'status', g.status,
      'current_round', g.current_round, 'total_rounds', g.total_rounds,
      'round_duration_s', g.round_duration_s, 'base_points', g.base_points,
      'speed_bonus_max', g.speed_bonus_max, 'feedback_mode', g.feedback_mode),
    'bins', public._bins_json(g.scope),
    'round', v_round,
    'me', v_me,
    'leaderboard', case when g.status in ('between_rounds', 'finished') then
      (select coalesce(json_agg(json_build_object('alias', s.alias, 'score', s.score,
                                                  'correct', s.correct, 'pos', s.pos)), '[]'::json)
         from (select * from public._scores(g.id) limit 10) s) end
  );
end;
$$;

create or replace function public.submit_answer(p_token text, p_round_id uuid, p_item_id uuid, p_bin text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  p public.players := public._player_by_token(p_token);
  g public.games;
  r public.rounds;
  ri public.round_items;
  a public.answers;
  v_elapsed_ms bigint;
  v_duration_ms bigint;
  v_correct boolean;
  v_points int;
  v_status text := 'registrado';
  v_show boolean;
begin
  if p.kicked then
    raise exception 'EXPULSADO' using errcode = '42501';
  end if;
  perform public._sync_game(p.game_id);
  select * into g from public.games where id = p.game_id;
  select * into r from public.rounds where id = p_round_id and game_id = p.game_id;
  if not found or r.round_no <> g.current_round then
    raise exception 'RONDA_INVALIDA' using errcode = 'P0001';
  end if;
  if r.status = 'paused' then
    raise exception 'RONDA_PAUSADA' using errcode = 'P0001';
  end if;
  if r.status <> 'running' or now() > r.ends_at + public._grace() then
    raise exception 'TIEMPO_AGOTADO' using errcode = 'P0001';
  end if;
  if now() < r.started_at then
    raise exception 'AUN_NO_INICIA' using errcode = 'P0001';
  end if;
  select * into ri from public.round_items where round_id = r.id and item_id = p_item_id;
  if not found then
    raise exception 'ELEMENTO_INVALIDO' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.bins where scope = g.scope and code = p_bin) then
    raise exception 'CONTENEDOR_INVALIDO' using errcode = '22023';
  end if;

  v_duration_ms := r.duration_s * 1000;
  v_elapsed_ms := least(v_duration_ms, greatest(0,
                    (extract(epoch from (now() - r.started_at)) * 1000)::bigint - r.paused_total_ms));
  v_correct := ri.correct_bin = p_bin;
  v_points := case when v_correct
                then g.base_points
                     + round(g.speed_bonus_max * (1 - v_elapsed_ms::numeric / v_duration_ms))::int
                else 0 end;

  insert into public.answers (game_id, round_id, item_id, player_id, chosen_bin, is_correct,
                              points, response_ms)
  values (g.id, r.id, ri.item_id, p.id, p_bin, v_correct, v_points, v_elapsed_ms)
  on conflict (player_id, round_id, item_id) do nothing
  returning * into a;

  if a.id is null then
    -- Ya respondido: se conserva la primera respuesta (sin puntos duplicados).
    v_status := 'duplicado';
    select * into a from public.answers
     where player_id = p.id and round_id = r.id and item_id = ri.item_id;
  end if;

  v_show := g.feedback_mode = 'inmediata';
  return json_build_object(
    'status', v_status, 'item_id', a.item_id, 'chosen_bin', a.chosen_bin,
    'is_correct', case when v_show then a.is_correct end,
    'points', case when v_show then a.points end,
    'correct_bin', case when v_show then ri.correct_bin end,
    'explanation', case when v_show then ri.explanation end);
end;
$$;

-- ---------------------------------------------------------------------
-- Administración de personal
-- ---------------------------------------------------------------------
create or replace function public.admin_list_staff()
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  return (select coalesce(json_agg(json_build_object(
            'user_id', s.user_id, 'email', u.email, 'role', s.role,
            'display_name', s.display_name, 'created_at', s.created_at) order by s.created_at), '[]'::json)
            from public.staff s join auth.users u on u.id = s.user_id);
end;
$$;

-- p_role = null quita el acceso.
create or replace function public.admin_set_role(p_email text, p_role text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
begin
  if not public.is_admin() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(btrim(p_email));
  if not found then
    raise exception 'USUARIO_NO_ENCONTRADO: primero cree el usuario en Supabase Auth' using errcode = 'P0002';
  end if;
  if v_uid = auth.uid() and p_role is distinct from 'admin' then
    raise exception 'NO_PUEDE_QUITARSE_ADMIN' using errcode = 'P0001';
  end if;
  if p_role is null then
    delete from public.staff where user_id = v_uid;
  elsif p_role in ('admin', 'instructor') then
    insert into public.staff (user_id, role) values (v_uid, p_role)
    on conflict (user_id) do update set role = excluded.role;
  else
    raise exception 'ROL_INVALIDO' using errcode = '22023';
  end if;
  return public.admin_list_staff();
end;
$$;

create or replace function public.my_role()
returns text language sql stable security definer
set search_path = public, pg_temp
as $$ select role from public.staff where user_id = auth.uid() $$;

-- ---------------------------------------------------------------------
-- Permisos de ejecución (Supabase concede EXECUTE a anon por defecto:
-- se revoca todo y se concede explícitamente).
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_staff(), public.is_admin(), public.my_role() to anon, authenticated;

grant execute on function
  public.join_game(text, text),
  public.player_state(text),
  public.submit_answer(text, uuid, uuid, text)
to anon, authenticated;

grant execute on function
  public.create_game(text, uuid, text, int, int, int, int, int, text),
  public.update_game_settings(uuid, int, int, int, int, int, text),
  public.start_round(uuid),
  public.pause_round(uuid),
  public.resume_round(uuid),
  public.end_round(uuid),
  public.finish_game(uuid),
  public.close_game(uuid),
  public.kick_player(uuid, uuid),
  public.host_state(uuid),
  public.game_results(uuid),
  public.my_games(int),
  public.admin_list_staff(),
  public.admin_set_role(text, text)
to authenticated;
