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
