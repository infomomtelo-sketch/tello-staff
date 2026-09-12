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
  updated_at timestamptz not null default now(),
  unique (user_id, entity_kind, entity_id, date)
);
create index if not exists tello_staff_schedule_days_lookup
  on tello_staff_schedule_days (user_id, entity_kind, entity_id, date);

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

alter table tello_staff_config enable row level security;
alter table tello_staff_schedule_days enable row level security;
alter table tello_staff_reminders enable row level security;
alter table tello_staff_birthdays enable row level security;
alter table tello_staff_chat_messages enable row level security;
alter table tello_staff_members enable row level security;

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

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name like 'tello_staff_%') as tello_staff_tables;
