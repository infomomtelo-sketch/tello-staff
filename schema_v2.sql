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

-- ===========================================================================
-- Part 2 — Staff Directory
-- ===========================================================================
-- `home_id` is a soft reference to an entry in tello_staff_config.homes
-- (which lives in a jsonb array, so it can't be a real foreign key) —
-- resolved client-side against the caller's current config.

create table if not exists tello_staff_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'caregiver' check (role in ('admin', 'caregiver')),
  home_id uuid,
  auth_user_id uuid references auth.users(id) on delete set null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tello_staff_members_owner on tello_staff_members(owner_id);

alter table tello_staff_members enable row level security;

drop policy if exists "staff select" on tello_staff_members;
create policy "staff select" on tello_staff_members
  for select using (owner_id = tello_staff_org());

drop policy if exists "staff write" on tello_staff_members;
create policy "staff write" on tello_staff_members
  for all using (owner_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (owner_id = tello_staff_org() and tello_staff_role() = 'admin');

-- Now that tello_staff_members exists, wire up the FK left dangling in Part 1.
alter table tello_staff_roles drop constraint if exists tello_staff_roles_staff_member_id_fkey;
alter table tello_staff_roles add constraint tello_staff_roles_staff_member_id_fkey
  foreign key (staff_member_id) references tello_staff_members(id) on delete set null;

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name = 'tello_staff_members') as staff_table_created;

-- ===========================================================================
-- Part 3 — Day Off Requests
-- ===========================================================================

create table if not exists tello_staff_dayoff_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  staff_member_id uuid references tello_staff_members(id) on delete set null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  date date not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_tello_dayoff_owner on tello_staff_dayoff_requests(owner_id);
create index if not exists idx_tello_dayoff_requester on tello_staff_dayoff_requests(requested_by);

-- Caller's own linked staff row, so a caregiver can only file requests
-- against their own directory entry (not someone else's).
create or replace function tello_staff_member() returns uuid
language sql security definer stable set search_path = public as $$
  select staff_member_id from tello_staff_roles where user_id = auth.uid();
$$;

alter table tello_staff_dayoff_requests enable row level security;

drop policy if exists "dayoff select" on tello_staff_dayoff_requests;
create policy "dayoff select" on tello_staff_dayoff_requests
  for select using (
    requested_by = auth.uid()
    or (owner_id = tello_staff_org() and tello_staff_role() = 'admin')
  );

drop policy if exists "dayoff insert own" on tello_staff_dayoff_requests;
create policy "dayoff insert own" on tello_staff_dayoff_requests
  for insert with check (
    requested_by = auth.uid()
    and owner_id = tello_staff_org()
    and (staff_member_id is null or staff_member_id = tello_staff_member())
  );

drop policy if exists "dayoff admin decide" on tello_staff_dayoff_requests;
create policy "dayoff admin decide" on tello_staff_dayoff_requests
  for update using (owner_id = tello_staff_org() and tello_staff_role() = 'admin')
  with check (owner_id = tello_staff_org() and tello_staff_role() = 'admin');

drop policy if exists "dayoff delete" on tello_staff_dayoff_requests;
create policy "dayoff delete" on tello_staff_dayoff_requests
  for delete using (
    (requested_by = auth.uid() and status = 'pending')
    or (owner_id = tello_staff_org() and tello_staff_role() = 'admin')
  );

select
  (select count(*) from information_schema.tables
   where table_schema = 'public' and table_name = 'tello_staff_dayoff_requests') as dayoff_table_created;
