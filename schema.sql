-- Tello Staff — Session 1 schema (Schedule Board + Today's Board)
-- Run in the Supabase SQL editor for project nwlhsshvqmbhemhxcran.
-- Safe to run more than once.

create table if not exists tello_staff_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  homes jsonb not null default '[]'::jsonb,
  relievers jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists tello_staff_schedule (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  assignments jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

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

alter table tello_staff_config enable row level security;
alter table tello_staff_schedule enable row level security;
alter table tello_staff_reminders enable row level security;
alter table tello_staff_birthdays enable row level security;

drop policy if exists "own config" on tello_staff_config;
create policy "own config" on tello_staff_config
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own schedule" on tello_staff_schedule;
create policy "own schedule" on tello_staff_schedule
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own reminders" on tello_staff_reminders;
create policy "own reminders" on tello_staff_reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own birthdays" on tello_staff_birthdays;
create policy "own birthdays" on tello_staff_birthdays
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name like 'tello_staff_%') as tello_staff_tables;
