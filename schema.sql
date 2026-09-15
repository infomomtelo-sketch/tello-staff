-- Tello Staff schema. Run in the Supabase SQL editor for project
-- nwlhsshvqmbhemhxcran. Safe to run more than once.
--
-- NOTE: tello_staff_schedule (a JSONB blob per week, fixed CG1/CG2/Night
-- slots) has been replaced by tello_staff_schedule_days below — a flexible
-- day-by-day roster (free-text "Working" and "Day Off" lists per home/date)
-- matching how the schedule is actually kept on paper. This script does NOT
-- drop the old table — if you ran an earlier version of this schema and have
-- no data in tello_staff_schedule worth keeping, you can drop it yourself:
--   drop table if exists tello_staff_schedule;
--
-- NOTE: an earlier session created some of these tables with an owner_id
-- column instead of user_id. Every policy and app query below expects
-- user_id, so normalize first — a no-op on a fresh database (nothing to
-- rename yet) or one that's already on user_id.
do $$
declare
  t text;
begin
  foreach t in array array[
    'tello_staff_config', 'tello_staff_schedule_days', 'tello_staff_reminders',
    'tello_staff_birthdays', 'tello_staff_chat_messages', 'tello_staff_members',
    'tello_staff_share_links', 'tello_staff_requests'
  ]
  loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'owner_id')
       and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'user_id')
    then
      execute format('alter table %I rename column owner_id to user_id', t);
    end if;
  end loop;
end $$;

create table if not exists tello_staff_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  homes jsonb not null default '[]'::jsonb,
  relievers jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- One row per (home or reliever) per calendar date. entity_id is a home or
-- reliever id from tello_staff_config's homes/relievers JSONB, not an FK —
-- those ids live in JSONB, not their own table.
create table if not exists tello_staff_schedule_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_kind text not null check (entity_kind in ('home', 'reliever')),
  entity_id text not null,
  date date not null,
  working text not null default '',
  day_off text not null default '',
  -- Derived from "working" every time it's saved, never typed directly: one
  -- {name, start, end} object per line, start/end null when that line had no
  -- recognizable time (e.g. "Manpreet (N)"). The Working box itself is still
  -- plain free text — this just gives anything that needs an actual time
  -- (Chat, a future personal per-staff link) something structured to read.
  working_shifts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, entity_kind, entity_id, date)
);
create index if not exists tello_staff_schedule_days_lookup
  on tello_staff_schedule_days (user_id, entity_kind, entity_id, date);
-- Re-running this script on a database created before working_shifts existed:
alter table tello_staff_schedule_days add column if not exists working_shifts jsonb not null default '[]'::jsonb;

create table if not exists tello_staff_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  note text,
  due_time text,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists tello_staff_birthdays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  bday_month int not null check (bday_month between 1 and 12),
  bday_day int not null check (bday_day between 1 and 31),
  created_at timestamptz not null default now()
);

create table if not exists tello_staff_chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- home_id is a soft reference to a home id in tello_staff_config's homes
-- JSONB, not an FK — same pattern as tello_staff_schedule_days.
create table if not exists tello_staff_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  role text,
  contact text,
  home_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Shareable links (read-only, no caregiver login): either a per-home
-- schedule view (home_id set, read by functions/api/share-data.js) or a
-- per-staff-member "where + what time do I work" view (staff_id set, read
-- by functions/api/staff-share-data.js) — exactly one of the two per row.
-- Deliberately no public RLS policy here — both public pages read through
-- their Function using the Supabase service role key, which bypasses RLS
-- entirely server-side. Anon/authenticated clients get no special access to
-- this table beyond their own rows.
create table if not exists tello_staff_share_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  home_id text,
  staff_id text,
  token text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint tello_staff_share_links_kind check (
    (home_id is not null and staff_id is null) or (home_id is null and staff_id is not null)
  )
);
create index if not exists tello_staff_share_links_token on tello_staff_share_links (token);
-- Re-running this script on a database created before staff_id existed:
alter table tello_staff_share_links alter column home_id drop not null;
alter table tello_staff_share_links add column if not exists staff_id text;
alter table tello_staff_share_links drop constraint if exists tello_staff_share_links_kind;
alter table tello_staff_share_links add constraint tello_staff_share_links_kind check (
  (home_id is not null and staff_id is null) or (home_id is null and staff_id is not null)
);

-- Change requests submitted from a share page. home_name/staff_name are
-- denormalized snapshots (not FKs) since the public submitter has no
-- session to look anything up with — same reasoning as above, submission
-- goes through functions/api/share-request.js with the service role key.
create table if not exists tello_staff_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  home_id text not null,
  home_name text not null,
  staff_name text not null,
  request_date date,
  note text not null,
  status text not null default 'open' check (status in ('open', 'handled')),
  created_at timestamptz not null default now()
);

alter table tello_staff_config enable row level security;
alter table tello_staff_schedule_days enable row level security;
alter table tello_staff_reminders enable row level security;
alter table tello_staff_birthdays enable row level security;
alter table tello_staff_chat_messages enable row level security;
alter table tello_staff_members enable row level security;
alter table tello_staff_share_links enable row level security;
alter table tello_staff_requests enable row level security;

drop policy if exists "own config" on tello_staff_config;
create policy "own config" on tello_staff_config
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own schedule days" on tello_staff_schedule_days;
create policy "own schedule days" on tello_staff_schedule_days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own reminders" on tello_staff_reminders;
create policy "own reminders" on tello_staff_reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own birthdays" on tello_staff_birthdays;
create policy "own birthdays" on tello_staff_birthdays
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own chat messages" on tello_staff_chat_messages;
create policy "own chat messages" on tello_staff_chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own staff members" on tello_staff_members;
create policy "own staff members" on tello_staff_members
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own share links" on tello_staff_share_links;
create policy "own share links" on tello_staff_share_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own requests" on tello_staff_requests;
create policy "own requests" on tello_staff_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name like 'tello_staff_%') as tello_staff_tables;
