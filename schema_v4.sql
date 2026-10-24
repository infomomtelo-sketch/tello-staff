-- Tello Staff — Time clock schema (clock in/out, breaks, shift times)
-- Run in the Supabase SQL editor for project nwlhsshvqmbhemhxcran, AFTER
-- schema.sql, schema_v2.sql and schema_v3.sql. Safe to run more than once.

-- Shift times + break rules live on the org's existing config row, so
-- everyone in the org can read them and only admins can change them
-- (existing "config select" / "config write" policies already cover this).
alter table tello_staff_config add column if not exists clock_settings jsonb;

create table if not exists tello_staff_time_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  staff_member_id uuid references tello_staff_members(id) on delete set null,
  shift_key text,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  -- [{label, allowed, paid, start, end}] — actual break start/end as tapped
  breaks jsonb not null default '[]'::jsonb,
  -- Set the first time an admin adjusts a time, so the original is never lost.
  orig_clock_in timestamptz,
  orig_clock_out timestamptz,
  adjusted_by uuid references auth.users(id) on delete set null,
  adjusted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_tello_time_owner on tello_staff_time_entries(owner_id, clock_in desc);
create index if not exists idx_tello_time_user on tello_staff_time_entries(user_id, clock_in desc);

-- One open (not clocked out) entry per person.
create unique index if not exists uniq_tello_time_open
  on tello_staff_time_entries(user_id) where clock_out is null;

alter table tello_staff_time_entries enable row level security;

drop policy if exists "time select" on tello_staff_time_entries;
create policy "time select" on tello_staff_time_entries
  for select using (
    user_id = auth.uid()
    or (owner_id = tello_staff_org() and tello_staff_role() = 'admin')
  );

drop policy if exists "time insert own" on tello_staff_time_entries;
create policy "time insert own" on tello_staff_time_entries
  for insert with check (
    user_id = auth.uid() and owner_id = tello_staff_org()
  );

-- A person can update their own entry only while it is still open
-- (breaks, clock out). After clock-out only an admin can adjust it.
drop policy if exists "time update own open" on tello_staff_time_entries;
create policy "time update own open" on tello_staff_time_entries
  for update using (user_id = auth.uid() and clock_out is null)
  with check (user_id = auth.uid() and owner_id = tello_staff_org());

drop policy if exists "time admin update" on tello_staff_time_entries;
create policy "time admin update" on tello_staff_time_entries
  for update using (owner_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (owner_id = tello_staff_org() and tello_staff_role() = 'admin');

drop policy if exists "time admin delete" on tello_staff_time_entries;
create policy "time admin delete" on tello_staff_time_entries
  for delete using (owner_id = tello_staff_org() and tello_staff_role() = 'admin');

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name = 'tello_staff_time_entries') as time_entries_table_created,
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'tello_staff_config' and column_name = 'clock_settings') as clock_settings_column_added;
