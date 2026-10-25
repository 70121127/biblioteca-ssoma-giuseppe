-- SSOMA ECO CHALLENGE · instalación completa (generado por `npm run sql:bundle`).
-- Pegue TODO este archivo en Supabase > SQL Editor y ejecútelo una vez.

-- >>>>>>>>>> 20261024000001_schema.sql
-- =====================================================================
-- SSOMA ECO CHALLENGE · 001 · Esquema, roles y RLS
-- Clasificación según NTP 900.058:2019 (Perú).
-- Ejecutar en Supabase (SQL Editor o `supabase db push`) en orden.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Contenedores (código de colores NTP 900.058:2019)
-- ---------------------------------------------------------------------
create table if not exists public.bins (
  scope       text not null check (scope in ('municipal', 'no_municipal')),
  code        text not null check (code ~ '^[a-z_]{3,20}$'),
  color_name  text not null,
  label       text not null,
  color_hex   text not null check (color_hex ~ '^#[0-9a-fA-F]{6}$'),
  text_hex    text not null check (text_hex ~ '^#[0-9a-fA-F]{6}$'),
  icon        text not null,
  description text not null,
  sort_order  int  not null,
  primary key (scope, code)
);

-- ---------------------------------------------------------------------
-- Personal autorizado (instructores y administradores).
-- Los participantes NO tienen cuenta: usan alias + token de sesión.
-- ---------------------------------------------------------------------
create table if not exists public.staff (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('admin', 'instructor')),
  display_name text,
  created_at   timestamptz not null default now()
);

create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and role = 'admin');
$$;

-- ---------------------------------------------------------------------
-- Banco de residuos (imágenes + clasificación validada)
-- ---------------------------------------------------------------------
create table if not exists public.waste_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 2 and 80),
  scope         text not null check (scope in ('municipal', 'no_municipal')),
  bin_code      text not null,
  image_url     text not null check (image_url ~ '^(https://|/)[^\s"''<>]+$'),
  image_source  text not null default 'propia'
                check (image_source in ('propia', 'storage', 'externa_autorizada')),
  image_credit  text,
  explanation   text not null check (char_length(btrim(explanation)) between 5 and 600),
  is_hazardous  boolean generated always as (bin_code = 'rojo') stored,
  active        boolean not null default true,
  status        text not null default 'pendiente'
                check (status in ('pendiente', 'aprobado', 'rechazado')),
  review_note   text,
  validated_by  uuid references auth.users (id) on delete set null,
  validated_at  timestamptz,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (scope, bin_code) references public.bins (scope, code),
  -- Una imagen externa sólo se acepta con autor/licencia declarados.
  check (image_source <> 'externa_autorizada' or coalesce(btrim(image_credit), '') <> '')
);
create index if not exists waste_items_scope_idx on public.waste_items (scope, status, active);

-- Validación por administrador: un no-admin nunca puede aprobar, y cualquier
-- cambio de clasificación hecho por un no-admin vuelve el registro a "pendiente".
create or replace function public.tg_waste_items_guard()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_admin boolean := public.is_admin();
begin
  new.updated_at := now();
  new.name := btrim(new.name);
  new.explanation := btrim(new.explanation);

  if tg_op = 'INSERT' then
    if not v_admin then
      new.status := 'pendiente';
      new.validated_by := null;
      new.validated_at := null;
      new.review_note := null;
    end if;
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
    if not v_admin then
      new.status := old.status;
      new.validated_by := old.validated_by;
      new.validated_at := old.validated_at;
      new.review_note := old.review_note;
      if (new.name, new.scope, new.bin_code, new.image_url, new.explanation, new.image_source,
          coalesce(new.image_credit, ''))
         is distinct from
         (old.name, old.scope, old.bin_code, old.image_url, old.explanation, old.image_source,
          coalesce(old.image_credit, '')) then
        new.status := 'pendiente';
        new.validated_by := null;
        new.validated_at := null;
      end if;
    end if;
  end if;

  if v_admin and new.status in ('aprobado', 'rechazado')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    new.validated_by := auth.uid();
    new.validated_at := now();
  end if;
  if new.status = 'pendiente' then
    new.validated_by := null;
    new.validated_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists waste_items_guard on public.waste_items;
create trigger waste_items_guard
  before insert or update on public.waste_items
  for each row execute function public.tg_waste_items_guard();

-- ---------------------------------------------------------------------
-- Bancos de preguntas (conjuntos de residuos de UN solo ámbito)
-- ---------------------------------------------------------------------
create table if not exists public.question_banks (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 3 and 80),
  scope       text not null check (scope in ('municipal', 'no_municipal')),
  description text,
  owner_id    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.bank_items (
  bank_id uuid not null references public.question_banks (id) on delete cascade,
  item_id uuid not null references public.waste_items (id) on delete cascade,
  primary key (bank_id, item_id)
);
create index if not exists bank_items_item_idx on public.bank_items (item_id);

-- No se mezclan ámbitos: el residuo debe pertenecer al ámbito del banco.
create or replace function public.tg_bank_items_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select scope from public.question_banks where id = new.bank_id)
     is distinct from (select scope from public.waste_items where id = new.item_id) then
    raise exception 'AMBITO_DISTINTO: el residuo no pertenece al ámbito del banco'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists bank_items_scope on public.bank_items;
create trigger bank_items_scope
  before insert or update on public.bank_items
  for each row execute function public.tg_bank_items_scope();

-- Un residuo no puede cambiar de ámbito si ya está en un banco de otro ámbito.
create or replace function public.tg_waste_items_scope_lock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.scope is distinct from old.scope
     and exists (select 1 from public.bank_items where item_id = new.id) then
    raise exception 'AMBITO_EN_USO: quite el residuo de sus bancos antes de cambiar el ámbito'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists waste_items_scope_lock on public.waste_items;
create trigger waste_items_scope_lock
  before update of scope on public.waste_items
  for each row execute function public.tg_waste_items_scope_lock();

-- ---------------------------------------------------------------------
-- Partidas, rondas, participantes y respuestas
-- ---------------------------------------------------------------------
create table if not exists public.games (
  id               uuid primary key default gen_random_uuid(),
  code             text not null check (code ~ '^[0-9]{6}$'),
  title            text,
  instructor_id    uuid not null references auth.users (id) on delete cascade,
  bank_id          uuid references public.question_banks (id) on delete set null,
  bank_name        text,
  scope            text not null check (scope in ('municipal', 'no_municipal')),
  status           text not null default 'lobby'
                   check (status in ('lobby', 'running', 'paused', 'between_rounds', 'finished', 'closed')),
  round_duration_s int  not null default 60  check (round_duration_s between 10 and 600),
  base_points      int  not null default 100 check (base_points between 10 and 1000),
  speed_bonus_max  int  not null default 50  check (speed_bonus_max between 0 and 50),
  items_per_round  int  not null default 8   check (items_per_round between 1 and 30),
  total_rounds     int  not null default 3   check (total_rounds between 1 and 20),
  feedback_mode    text not null default 'inmediata' check (feedback_mode in ('inmediata', 'al_final')),
  max_players      int  not null default 250 check (max_players between 1 and 500),
  current_round    int  not null default 0,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  closed_at        timestamptz
);
-- El código sólo es único entre partidas no cerradas (se recicla al cerrar).
create unique index if not exists games_code_open_idx on public.games (code) where status <> 'closed';
create index if not exists games_instructor_idx on public.games (instructor_id, created_at desc);

create table if not exists public.rounds (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid not null references public.games (id) on delete cascade,
  round_no        int  not null,
  status          text not null default 'running' check (status in ('running', 'paused', 'ended')),
  duration_s      int  not null,
  started_at      timestamptz not null,
  ends_at         timestamptz not null,
  paused_at       timestamptz,
  paused_total_ms bigint not null default 0,
  ended_at        timestamptz,
  unique (game_id, round_no)
);

-- Copia (snapshot) de la clasificación al iniciar la ronda: editar el banco
-- durante una partida no altera la calificación ni el historial.
create table if not exists public.round_items (
  round_id    uuid not null references public.rounds (id) on delete cascade,
  item_id     uuid not null references public.waste_items (id) on delete restrict,
  position    int  not null,
  name        text not null,
  image_url   text not null,
  explanation text not null,
  correct_bin text not null,
  primary key (round_id, item_id)
);
create index if not exists round_items_item_idx on public.round_items (item_id);

create table if not exists public.players (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references public.games (id) on delete cascade,
  alias      text not null,
  token_hash bytea not null unique,
  kicked     boolean not null default false,
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create unique index if not exists players_alias_idx on public.players (game_id, lower(alias));

create table if not exists public.answers (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references public.games (id) on delete cascade,
  round_id    uuid not null,
  item_id     uuid not null,
  player_id   uuid not null references public.players (id) on delete cascade,
  chosen_bin  text not null,
  is_correct  boolean not null,
  points      int not null check (points >= 0),
  response_ms int not null check (response_ms >= 0),
  created_at  timestamptz not null default now(),
  -- Un participante responde UNA sola vez cada residuo de la ronda.
  unique (player_id, round_id, item_id),
  foreign key (round_id, item_id) references public.round_items (round_id, item_id) on delete cascade
);
create index if not exists answers_game_idx on public.answers (game_id, player_id);
create index if not exists answers_round_idx on public.answers (round_id);

-- ---------------------------------------------------------------------
-- Row Level Security
-- Todas las escrituras de juego pasan por funciones RPC validadas
-- (migración 002). Los participantes (anon) no leen tablas directamente.
-- ---------------------------------------------------------------------
alter table public.bins           enable row level security;
alter table public.staff          enable row level security;
alter table public.waste_items    enable row level security;
alter table public.question_banks enable row level security;
alter table public.bank_items     enable row level security;
alter table public.games          enable row level security;
alter table public.rounds         enable row level security;
alter table public.round_items    enable row level security;
alter table public.players        enable row level security;
alter table public.answers        enable row level security;

-- Defensa en profundidad: anon sólo puede leer los contenedores.
revoke all on public.staff, public.waste_items, public.question_banks, public.bank_items,
  public.games, public.rounds, public.round_items, public.players, public.answers from anon;
revoke insert, update, delete, truncate on public.bins from anon;
grant select on public.bins to anon, authenticated;

-- Los juegos se modifican sólo mediante RPC.
revoke insert, update, delete, truncate on public.games, public.rounds, public.round_items,
  public.players, public.answers from authenticated;

-- bins
drop policy if exists bins_read on public.bins;
create policy bins_read on public.bins for select to anon, authenticated using (true);
drop policy if exists bins_admin_write on public.bins;
create policy bins_admin_write on public.bins for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- staff
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists staff_admin_write on public.staff;
create policy staff_admin_write on public.staff for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- waste_items
drop policy if exists waste_items_read on public.waste_items;
create policy waste_items_read on public.waste_items for select to authenticated
  using (public.is_staff());
drop policy if exists waste_items_insert on public.waste_items;
create policy waste_items_insert on public.waste_items for insert to authenticated
  with check (public.is_staff());
drop policy if exists waste_items_update on public.waste_items;
create policy waste_items_update on public.waste_items for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists waste_items_delete on public.waste_items;
create policy waste_items_delete on public.waste_items for delete to authenticated
  using (public.is_admin());

-- question_banks
drop policy if exists banks_read on public.question_banks;
create policy banks_read on public.question_banks for select to authenticated
  using (public.is_staff());
drop policy if exists banks_insert on public.question_banks;
create policy banks_insert on public.question_banks for insert to authenticated
  with check (public.is_staff() and (owner_id = auth.uid() or public.is_admin()));
drop policy if exists banks_update on public.question_banks;
create policy banks_update on public.question_banks for update to authenticated
  using (public.is_staff() and (owner_id = auth.uid() or public.is_admin()))
  with check (public.is_staff() and (owner_id = auth.uid() or public.is_admin()));
drop policy if exists banks_delete on public.question_banks;
create policy banks_delete on public.question_banks for delete to authenticated
  using (public.is_staff() and (owner_id = auth.uid() or public.is_admin()));

-- bank_items
drop policy if exists bank_items_read on public.bank_items;
create policy bank_items_read on public.bank_items for select to authenticated
  using (public.is_staff());
drop policy if exists bank_items_write on public.bank_items;
create policy bank_items_write on public.bank_items for all to authenticated
  using (public.is_staff() and exists (
    select 1 from public.question_banks b
    where b.id = bank_id and (b.owner_id = auth.uid() or public.is_admin())))
  with check (public.is_staff() and exists (
    select 1 from public.question_banks b
    where b.id = bank_id and (b.owner_id = auth.uid() or public.is_admin())));

-- games y datos asociados: el instructor dueño (o un admin) puede leer.
drop policy if exists games_read on public.games;
create policy games_read on public.games for select to authenticated
  using (public.is_staff() and (instructor_id = auth.uid() or public.is_admin()));

drop policy if exists rounds_read on public.rounds;
create policy rounds_read on public.rounds for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id
                 and public.is_staff() and (g.instructor_id = auth.uid() or public.is_admin())));

drop policy if exists round_items_read on public.round_items;
create policy round_items_read on public.round_items for select to authenticated
  using (exists (select 1 from public.rounds r join public.games g on g.id = r.game_id
                 where r.id = round_id
                 and public.is_staff() and (g.instructor_id = auth.uid() or public.is_admin())));

drop policy if exists players_read on public.players;
create policy players_read on public.players for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id
                 and public.is_staff() and (g.instructor_id = auth.uid() or public.is_admin())));

drop policy if exists answers_read on public.answers;
create policy answers_read on public.answers for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id
                 and public.is_staff() and (g.instructor_id = auth.uid() or public.is_admin())));

-- El hash del token del participante nunca se expone, ni siquiera al instructor.
-- (privilegios por columna: se revoca la tabla y se conceden sólo las columnas seguras)
revoke select on public.players from authenticated;
grant select (id, game_id, alias, kicked, joined_at, last_seen) on public.players to authenticated;


-- >>>>>>>>>> 20261024000002_game_functions.sql
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


-- >>>>>>>>>> 20261024000003_storage.sql
-- =====================================================================
-- SSOMA ECO CHALLENGE · 003 · Almacenamiento de imágenes del banco
-- Bucket público de sólo lectura; sólo el personal autorizado sube imágenes.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('residuos', 'residuos', true, 2097152,
        array['image/png', 'image/jpeg', 'image/webp'])  -- sin SVG: puede contener scripts
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists residuos_staff_insert on storage.objects;
create policy residuos_staff_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'residuos' and public.is_staff());

drop policy if exists residuos_staff_update on storage.objects;
create policy residuos_staff_update on storage.objects for update to authenticated
  using (bucket_id = 'residuos' and public.is_staff())
  with check (bucket_id = 'residuos' and public.is_staff());

drop policy if exists residuos_admin_delete on storage.objects;
create policy residuos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'residuos' and public.is_admin());


-- >>>>>>>>>> 20261024000004_seed.sql
-- =====================================================================
-- SSOMA ECO CHALLENGE · 004 · Datos iniciales
-- Contenedores NTP 900.058:2019 y ejemplos ilustrativos del banco.
-- Las imágenes de ejemplo son ilustraciones SVG propias del proyecto
-- (carpeta public/img/residuos, licencia CC0).
-- Los ejemplos se crean como "pendiente": un administrador debe validarlos
-- en el módulo administrativo antes de usarlos en una partida.
-- =====================================================================

insert into public.bins (scope, code, color_name, label, color_hex, text_hex, icon, description, sort_order) values
  ('municipal', 'verde',  'Verde',  'Aprovechables',    '#2E9E44', '#FFFFFF', '♻️',
   'Papel, cartón, plásticos, metales, vidrio y otros residuos que pueden reciclarse.', 1),
  ('municipal', 'marron', 'Marrón', 'Orgánicos',        '#7B4A2A', '#FFFFFF', '🍂',
   'Restos de alimentos, cáscaras, restos de poda y otros residuos biodegradables.', 2),
  ('municipal', 'negro',  'Negro',  'No aprovechables', '#1F1F1F', '#FFFFFF', '🗑️',
   'Residuos que no pueden reciclarse: papel higiénico, envolturas metalizadas, tecnopor sucio.', 3),
  ('municipal', 'rojo',   'Rojo',   'Peligrosos',       '#D32F2F', '#FFFFFF', '☣️',
   'Pilas, focos, envases de productos químicos y otros residuos peligrosos.', 4),

  ('no_municipal', 'azul',     'Azul',     'Papel y cartón',   '#1E63C6', '#FFFFFF', '📦',
   'Papel, cartón, periódicos y revistas limpios y secos.', 1),
  ('no_municipal', 'blanco',   'Blanco',   'Plástico',         '#FFFFFF', '#1D2630', '🧴',
   'Botellas, envases y otros plásticos limpios.', 2),
  ('no_municipal', 'amarillo', 'Amarillo', 'Metales',          '#F2C200', '#1D2630', '🥫',
   'Latas, chatarra menor y otros metales.', 3),
  ('no_municipal', 'plomo',    'Plomo',    'Vidrio',           '#8A8F96', '#FFFFFF', '🍾',
   'Botellas y frascos de vidrio.', 4),
  ('no_municipal', 'marron',   'Marrón',   'Orgánicos',        '#7B4A2A', '#FFFFFF', '🍂',
   'Restos de alimentos y otros residuos biodegradables.', 5),
  ('no_municipal', 'rojo',     'Rojo',     'Peligrosos',       '#D32F2F', '#FFFFFF', '☣️',
   'Residuos con características de peligrosidad: pilas, trapos con hidrocarburos, envases de químicos.', 6),
  ('no_municipal', 'negro',    'Negro',    'No aprovechables', '#1F1F1F', '#FFFFFF', '🗑️',
   'Residuos generales que no pueden reciclarse.', 7)
on conflict (scope, code) do update set
  color_name = excluded.color_name, label = excluded.label, color_hex = excluded.color_hex,
  text_hex = excluded.text_hex, icon = excluded.icon, description = excluded.description,
  sort_order = excluded.sort_order;

-- Ejemplos ilustrativos (identificador fijo para poder re-ejecutar el script).
insert into public.waste_items (id, name, scope, bin_code, image_url, image_source, image_credit, explanation) values
  -- Ámbito municipal
  ('a0000000-0000-4000-8000-000000000001', 'Hoja de papel', 'municipal', 'verde', '/img/residuos/papel.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel limpio y seco es aprovechable: se recicla para fabricar papel nuevo.'),
  ('a0000000-0000-4000-8000-000000000002', 'Caja de cartón', 'municipal', 'verde', '/img/residuos/carton.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El cartón es aprovechable. Pliégalo para ocupar menos espacio y mantenlo seco.'),
  ('a0000000-0000-4000-8000-000000000003', 'Periódico', 'municipal', 'verde', '/img/residuos/periodico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Periódicos y revistas son aprovechables si están limpios y secos.'),
  ('a0000000-0000-4000-8000-000000000004', 'Botella de plástico PET', 'municipal', 'verde', '/img/residuos/botella-pet.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las botellas PET son aprovechables. Vacíalas y aplástalas antes de depositarlas.'),
  ('a0000000-0000-4000-8000-000000000005', 'Lata de aluminio', 'municipal', 'verde', '/img/residuos/lata.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las latas de metal son aprovechables y pueden reciclarse indefinidamente.'),
  ('a0000000-0000-4000-8000-000000000006', 'Botella de vidrio', 'municipal', 'verde', '/img/residuos/botella-vidrio.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'En el ámbito municipal el vidrio va con los aprovechables (contenedor verde).'),
  ('a0000000-0000-4000-8000-000000000007', 'Cáscara de plátano', 'municipal', 'marron', '/img/residuos/cascara-platano.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las cáscaras de frutas son residuos orgánicos: pueden convertirse en compost.'),
  ('a0000000-0000-4000-8000-000000000008', 'Restos de manzana', 'municipal', 'marron', '/img/residuos/manzana.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de frutas y verduras son orgánicos y biodegradables.'),
  ('a0000000-0000-4000-8000-000000000009', 'Restos de comida', 'municipal', 'marron', '/img/residuos/restos-comida.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de alimentos van al contenedor de orgánicos, sin envases ni cubiertos.'),
  ('a0000000-0000-4000-8000-000000000010', 'Cáscaras de huevo', 'municipal', 'marron', '/img/residuos/cascara-huevo.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las cáscaras de huevo son orgánicas y aportan calcio al compost.'),
  ('a0000000-0000-4000-8000-000000000011', 'Papel higiénico usado', 'municipal', 'negro', '/img/residuos/papel-higienico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel higiénico usado no es aprovechable: está contaminado y no se recicla.'),
  ('a0000000-0000-4000-8000-000000000012', 'Envoltura metalizada de snack', 'municipal', 'negro', '/img/residuos/envoltura.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las envolturas multicapa (plástico + aluminio) no son aprovechables en la mayoría de sistemas.'),
  ('a0000000-0000-4000-8000-000000000013', 'Servilleta sucia', 'municipal', 'negro', '/img/residuos/servilleta.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel con grasa o restos de comida pierde su valor de reciclaje: es no aprovechable.'),
  ('a0000000-0000-4000-8000-000000000014', 'Tecnopor con restos de comida', 'municipal', 'negro', '/img/residuos/tecnopor.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El tecnopor sucio no es aprovechable. Prefiere envases reutilizables.'),
  ('a0000000-0000-4000-8000-000000000015', 'Pilas usadas', 'municipal', 'rojo', '/img/residuos/pila.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las pilas contienen metales pesados: son residuos peligrosos. No las abras ni manipules; entrégalas en un punto de acopio autorizado.'),
  ('a0000000-0000-4000-8000-000000000016', 'Fluorescente o foco ahorrador', 'municipal', 'rojo', '/img/residuos/fluorescente.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los fluorescentes contienen mercurio: son peligrosos. No los rompas; entrégalos completos al personal responsable.'),
  ('a0000000-0000-4000-8000-000000000017', 'Aerosol o envase de pintura', 'municipal', 'rojo', '/img/residuos/aerosol.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los envases de productos químicos son peligrosos. No los perfores ni quemes; sepáralos para su gestión especial.'),

  -- Ámbito no municipal
  ('b0000000-0000-4000-8000-000000000001', 'Hoja de papel', 'no_municipal', 'azul', '/img/residuos/papel.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel limpio y seco va al contenedor azul de papel y cartón.'),
  ('b0000000-0000-4000-8000-000000000002', 'Caja de cartón', 'no_municipal', 'azul', '/img/residuos/carton.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El cartón va al contenedor azul. Pliégalo y mantenlo seco.'),
  ('b0000000-0000-4000-8000-000000000003', 'Periódico', 'no_municipal', 'azul', '/img/residuos/periodico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Periódicos y revistas van al contenedor azul de papel y cartón.'),
  ('b0000000-0000-4000-8000-000000000004', 'Botella de plástico PET', 'no_municipal', 'blanco', '/img/residuos/botella-pet.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las botellas de plástico van al contenedor blanco. Vacíalas y aplástalas.'),
  ('b0000000-0000-4000-8000-000000000005', 'Envase de plástico', 'no_municipal', 'blanco', '/img/residuos/envase-plastico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los envases plásticos limpios (que no contuvieron sustancias peligrosas) van al contenedor blanco.'),
  ('b0000000-0000-4000-8000-000000000006', 'Lata de aluminio', 'no_municipal', 'amarillo', '/img/residuos/lata.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las latas y otros metales van al contenedor amarillo.'),
  ('b0000000-0000-4000-8000-000000000007', 'Retazos metálicos y clavos', 'no_municipal', 'amarillo', '/img/residuos/clavos.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'La chatarra menor va al contenedor amarillo de metales. Manipúlala con guantes por riesgo de cortes.'),
  ('b0000000-0000-4000-8000-000000000008', 'Botella de vidrio', 'no_municipal', 'plomo', '/img/residuos/botella-vidrio.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'En el ámbito no municipal el vidrio va al contenedor plomo.'),
  ('b0000000-0000-4000-8000-000000000009', 'Frasco de vidrio', 'no_municipal', 'plomo', '/img/residuos/frasco-vidrio.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los frascos de vidrio limpios van al contenedor plomo.'),
  ('b0000000-0000-4000-8000-000000000010', 'Cáscara de plátano', 'no_municipal', 'marron', '/img/residuos/cascara-platano.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las cáscaras de frutas van al contenedor marrón de orgánicos.'),
  ('b0000000-0000-4000-8000-000000000011', 'Restos de comida', 'no_municipal', 'marron', '/img/residuos/restos-comida.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de alimentos del comedor van al contenedor marrón.'),
  ('b0000000-0000-4000-8000-000000000012', 'Restos de manzana', 'no_municipal', 'marron', '/img/residuos/manzana.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los restos de frutas son orgánicos: contenedor marrón.'),
  ('b0000000-0000-4000-8000-000000000013', 'Pilas usadas', 'no_municipal', 'rojo', '/img/residuos/pila.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las pilas son residuos peligrosos (contenedor rojo). No las abras; entrégalas al almacén de residuos peligrosos.'),
  ('b0000000-0000-4000-8000-000000000014', 'Fluorescente o foco ahorrador', 'no_municipal', 'rojo', '/img/residuos/fluorescente.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los fluorescentes contienen mercurio: contenedor rojo. No los rompas; entrégalos completos.'),
  ('b0000000-0000-4000-8000-000000000015', 'Trapo con aceite o hidrocarburo', 'no_municipal', 'rojo', '/img/residuos/trapo-aceite.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los materiales impregnados con hidrocarburos son peligrosos (contenedor rojo). Manipúlalos sólo con EPP y según el procedimiento.'),
  ('b0000000-0000-4000-8000-000000000016', 'Aerosol o envase de pintura', 'no_municipal', 'rojo', '/img/residuos/aerosol.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Los envases de químicos son peligrosos (contenedor rojo). No los perfores ni reutilices.'),
  ('b0000000-0000-4000-8000-000000000017', 'Papel higiénico usado', 'no_municipal', 'negro', '/img/residuos/papel-higienico.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel higiénico usado va al contenedor negro de no aprovechables.'),
  ('b0000000-0000-4000-8000-000000000018', 'Envoltura metalizada de snack', 'no_municipal', 'negro', '/img/residuos/envoltura.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'Las envolturas multicapa van al contenedor negro de no aprovechables.'),
  ('b0000000-0000-4000-8000-000000000019', 'Tecnopor con restos de comida', 'no_municipal', 'negro', '/img/residuos/tecnopor.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El tecnopor sucio va al contenedor negro de no aprovechables.'),
  ('b0000000-0000-4000-8000-000000000020', 'Servilleta sucia', 'no_municipal', 'negro', '/img/residuos/servilleta.svg', 'propia', 'Ilustración propia SSOMA Eco Challenge (CC0)',
   'El papel con grasa o comida no se recicla: contenedor negro.')
on conflict (id) do nothing;

-- Bancos de preguntas base, uno por ámbito.
insert into public.question_banks (id, name, scope, description, owner_id) values
  ('c0000000-0000-4000-8000-000000000001', 'Básico · Ámbito municipal', 'municipal',
   'Residuos domiciliarios y de oficina. Contenedores verde, marrón, negro y rojo.', null),
  ('c0000000-0000-4000-8000-000000000002', 'Básico · Ámbito no municipal', 'no_municipal',
   'Residuos de actividades productivas (obra, planta, campamento). Siete colores.', null)
on conflict (id) do nothing;

insert into public.bank_items (bank_id, item_id)
select 'c0000000-0000-4000-8000-000000000001', id from public.waste_items
 where id::text like 'a0000000-%'
on conflict do nothing;

insert into public.bank_items (bank_id, item_id)
select 'c0000000-0000-4000-8000-000000000002', id from public.waste_items
 where id::text like 'b0000000-%'
on conflict do nothing;

