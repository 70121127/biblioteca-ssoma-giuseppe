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
