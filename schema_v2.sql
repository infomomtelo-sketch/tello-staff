-- Tello Staff — Session 2 schema
-- Run in the Supabase SQL editor for project nwlhsshvqmbhemhxcran, AFTER schema.sql.
-- Safe to run more than once. Sections are appended as each Session 2 part lands.

-- ===========================================================================
-- Part 1 — Roles (admin / caregiver)
-- ===========================================================================
-- One organization per admin. `owner_id` is the admin's auth uid — for an
-- admin's own row, owner_id = user_id. Caregivers get owner_id pointed at
-- the admin whose org they belong to, so both roles resolve to the same
-- shared data via tello_staff_org() below.

create table if not exists tello_staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin', 'caregiver')),
  staff_member_id uuid, -- linked once the Staff Directory (Session 2 part 2) exists
  created_at timestamptz not null default now()
);

create index if not exists idx_tello_staff_roles_owner on tello_staff_roles(owner_id);

-- SECURITY DEFINER so RLS policies (here and on other tables) can look up
-- the caller's role/org without recursively re-evaluating this table's own
-- policies.
create or replace function tello_staff_role() returns text
language sql security definer stable set search_path = public as $$
  select role from tello_staff_roles where user_id = auth.uid();
$$;

create or replace function tello_staff_org() returns uuid
language sql security definer stable set search_path = public as $$
  select owner_id from tello_staff_roles where user_id = auth.uid();
$$;

alter table tello_staff_roles enable row level security;

drop policy if exists "read own or org role" on tello_staff_roles;
create policy "read own or org role" on tello_staff_roles
  for select using (auth.uid() = user_id or owner_id = tello_staff_org());

-- A brand-new account with no role row yet bootstraps itself as the admin
-- of its own org on first login (keeps the existing Session 1 admin account
-- working untouched after this migration runs).
drop policy if exists "bootstrap own admin role" on tello_staff_roles;
create policy "bootstrap own admin role" on tello_staff_roles
  for insert with check (
    auth.uid() = user_id and role = 'admin' and owner_id = user_id
  );

-- An existing admin can add caregiver (or additional admin) rows to their
-- own org, e.g. when provisioning a caregiver login from the Staff tab.
drop policy if exists "admin adds org role" on tello_staff_roles;
create policy "admin adds org role" on tello_staff_roles
  for insert with check (
    tello_staff_role() = 'admin' and owner_id = tello_staff_org()
  );

drop policy if exists "admin updates org role" on tello_staff_roles;
create policy "admin updates org role" on tello_staff_roles
  for update using (
    tello_staff_role() = 'admin' and owner_id = tello_staff_org()
  );

drop policy if exists "admin deletes org role" on tello_staff_roles;
create policy "admin deletes org role" on tello_staff_roles
  for delete using (
    tello_staff_role() = 'admin' and owner_id = tello_staff_org() and user_id != auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Re-scope the Session 1 tables from "owned by the signed-in user" to
-- "owned by the org, read by anyone in the org, written by admins only".
-- The `user_id` column keeps its name (now meaning "org id") so existing
-- rows for the current admin need no data migration — their own uid already
-- equals their org id once their bootstrap role row is created.
-- ---------------------------------------------------------------------------

drop policy if exists "own config" on tello_staff_config;
drop policy if exists "config select" on tello_staff_config;
drop policy if exists "config write" on tello_staff_config;
create policy "config select" on tello_staff_config
  for select using (user_id = tello_staff_org());
create policy "config write" on tello_staff_config
  for all using (user_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (user_id = tello_staff_org() and tello_staff_role() = 'admin');

drop policy if exists "own schedule" on tello_staff_schedule;
drop policy if exists "schedule select" on tello_staff_schedule;
drop policy if exists "schedule write" on tello_staff_schedule;
create policy "schedule select" on tello_staff_schedule
  for select using (user_id = tello_staff_org());
create policy "schedule write" on tello_staff_schedule
  for all using (user_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (user_id = tello_staff_org() and tello_staff_role() = 'admin');

drop policy if exists "own reminders" on tello_staff_reminders;
drop policy if exists "reminders select" on tello_staff_reminders;
drop policy if exists "reminders write" on tello_staff_reminders;
create policy "reminders select" on tello_staff_reminders
  for select using (user_id = tello_staff_org());
create policy "reminders write" on tello_staff_reminders
  for all using (user_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (user_id = tello_staff_org() and tello_staff_role() = 'admin');

drop policy if exists "own birthdays" on tello_staff_birthdays;
drop policy if exists "birthdays select" on tello_staff_birthdays;
drop policy if exists "birthdays write" on tello_staff_birthdays;
create policy "birthdays select" on tello_staff_birthdays
  for select using (user_id = tello_staff_org());
create policy "birthdays write" on tello_staff_birthdays
  for all using (user_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (user_id = tello_staff_org() and tello_staff_role() = 'admin');

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name = 'tello_staff_roles') as roles_table_created;
