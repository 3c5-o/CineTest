-- CineTest database schema
create extension if not exists pgcrypto;

create table if not exists public.movies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  release_year smallint check (release_year is null or release_year between 1888 and 2100),
  genre text not null default '',
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.series (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  release_year smallint check (release_year is null or release_year between 1888 and 2100),
  genre text not null default '',
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.series(id) on delete cascade,
  season_number integer not null check (season_number > 0),
  title text not null default '',
  created_at timestamptz not null default now(),
  unique(series_id, season_number)
);

create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  episode_number integer not null check (episode_number > 0),
  title text not null default '',
  description text not null default '',
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  unique(season_id, episode_number)
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('movie','series','episode')),
  entity_id uuid not null,
  kind text not null check (kind in ('poster','video','backdrop','subtitle')),
  telegram_file_id text not null,
  telegram_unique_id text,
  mime_type text,
  file_name text,
  file_size bigint,
  channel_message_id bigint,
  created_at timestamptz not null default now(),
  unique(entity_type, entity_id, kind)
);

create table if not exists public.bot_sessions (
  telegram_user_id bigint primary key,
  flow text not null,
  step text not null,
  draft jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.movies enable row level security;
alter table public.series enable row level security;
alter table public.seasons enable row level security;
alter table public.episodes enable row level security;
alter table public.media_assets enable row level security;
alter table public.bot_sessions enable row level security;

drop policy if exists "public read published movies" on public.movies;
create policy "public read published movies"
on public.movies for select to anon, authenticated
using (is_published = true);

drop policy if exists "public read published series" on public.series;
create policy "public read published series"
on public.series for select to anon, authenticated
using (is_published = true);

drop policy if exists "public read seasons of published series" on public.seasons;
create policy "public read seasons of published series"
on public.seasons for select to anon, authenticated
using (
  exists (
    select 1 from public.series s
    where s.id = seasons.series_id and s.is_published = true
  )
);

drop policy if exists "public read published episodes" on public.episodes;
create policy "public read published episodes"
on public.episodes for select to anon, authenticated
using (
  is_published = true
  and exists (
    select 1
    from public.seasons se
    join public.series s on s.id = se.series_id
    where se.id = episodes.season_id
      and s.is_published = true
  )
);

grant select on public.movies, public.series, public.seasons, public.episodes to anon, authenticated;
revoke all on public.media_assets, public.bot_sessions from anon, authenticated;


-- CineTest 500MB / administration upgrade
create sequence if not exists public.movie_code_seq start 1;
create sequence if not exists public.series_code_seq start 1;
create sequence if not exists public.request_code_seq start 1;

alter table public.movies add column if not exists content_code text;
alter table public.movies add column if not exists is_featured boolean not null default false;
alter table public.movies add column if not exists view_count bigint not null default 0;
alter table public.series add column if not exists content_code text;
alter table public.series add column if not exists is_featured boolean not null default false;
alter table public.series add column if not exists view_count bigint not null default 0;
alter table public.episodes add column if not exists content_code text;
alter table public.episodes add column if not exists view_count bigint not null default 0;

create or replace function public.assign_movie_code()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.content_code is null or btrim(new.content_code)='' then
    new.content_code := 'MOV-' || lpad(nextval('public.movie_code_seq')::text,6,'0');
  end if;
  return new;
end $$;

create or replace function public.assign_series_code()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.content_code is null or btrim(new.content_code)='' then
    new.content_code := 'SER-' || lpad(nextval('public.series_code_seq')::text,6,'0');
  end if;
  return new;
end $$;

create or replace function public.assign_episode_code()
returns trigger language plpgsql set search_path=public as $$
declare v_series_code text; v_season_number integer;
begin
  select sr.content_code,se.season_number into v_series_code,v_season_number
  from public.seasons se join public.series sr on sr.id=se.series_id
  where se.id=new.season_id;
  if v_series_code is not null then
    new.content_code := v_series_code || '-S' || to_char(v_season_number,'FM00') || '-E' || to_char(new.episode_number,'FM00');
  end if;
  return new;
end $$;

drop trigger if exists trg_movies_content_code on public.movies;
create trigger trg_movies_content_code before insert on public.movies
for each row execute function public.assign_movie_code();
drop trigger if exists trg_series_content_code on public.series;
create trigger trg_series_content_code before insert on public.series
for each row execute function public.assign_series_code();
drop trigger if exists trg_episode_content_code on public.episodes;
create trigger trg_episode_content_code before insert or update of season_id,episode_number on public.episodes
for each row execute function public.assign_episode_code();

create unique index if not exists movies_content_code_key on public.movies(content_code);
create unique index if not exists series_content_code_key on public.series(content_code);
create unique index if not exists episodes_content_code_key on public.episodes(content_code);

create table if not exists public.admin_users(
  telegram_user_id bigint primary key,
  display_name text not null default '',
  role text not null default 'moderator'
    check(role in ('owner','secondary_admin','content_manager','requests_manager','moderator')),
  permissions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  added_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_logs(
  id uuid primary key default gen_random_uuid(),
  admin_telegram_id bigint not null,
  action text not null,
  entity_type text,
  entity_id uuid,
  content_code text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.content_requests(
  id uuid primary key default gen_random_uuid(),
  request_code text unique not null default ('REQ-' || lpad(nextval('public.request_code_seq')::text,6,'0')),
  request_type text not null check(request_type in ('movie','series')),
  title text not null check(char_length(btrim(title)) between 1 and 160),
  note text not null default '',
  requester_key text not null,
  status text not null default 'new' check(status in ('new','reviewing','added','rejected','duplicate')),
  handled_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_channels(
  channel_key text primary key,
  telegram_channel_id bigint unique,
  title text not null default '',
  purpose text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
alter table public.admin_logs enable row level security;
alter table public.content_requests enable row level security;
alter table public.telegram_channels enable row level security;
revoke all on public.admin_users, public.admin_logs, public.content_requests, public.telegram_channels from anon, authenticated;
