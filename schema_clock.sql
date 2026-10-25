-- Tello Staff — time clock tables. Run in the Supabase SQL editor for project
-- nwlhsshvqmbhemhxcran. Safe to run more than once. Only touches tello_staff_*
-- objects (nothing Title22 uses).
--
-- NOTE: an earlier experiment created a differently shaped table called
-- tello_staff_time_entries. This live app does NOT use it — it uses the new
-- tello_staff_clock_entries below. The old one can stay (or be dropped later).

-- Optional per-owner clock settings: { "timezone": "America/Los_Angeles",
-- "breaks": [{ "label": "Rest break", "minutes": 10, "paid": true }, ...] }.
-- Already present if schema_v4 was run; harmless either way.
alter table tello_staff_config add column if not exists clock_settings jsonb;

-- One row per punch-in/punch-out. user_id is the ADMIN who owns the staff
-- member (same convention as every other table here); staff_id is the staff
-- member's id (tello_staff_members.id, kept as text like share links do).
-- Staff have no login: they punch through functions/api/staff-clock.js with
-- the service role key, using their personal link token. All times are
-- stamped by the server clock. orig_* keep the original punches so an admin
-- adjustment never erases what was first recorded.
create table if not exists tello_staff_clock_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  staff_id text not null,
  staff_name text not null,
  home_name text,
  sched_start timestamptz,
  sched_end timestamptz,
  clock_in timestamptz not null,
  clock_out timestamptz,
  -- [{ label, allowed, paid, start, end }]
  breaks jsonb not null default '[]'::jsonb,
  orig_clock_in timestamptz,
  orig_clock_out timestamptz,
  adjusted_at timestamptz,
  adjusted_note text,
  created_at timestamptz not null default now()
);
create index if not exists tello_staff_clock_entries_lookup
  on tello_staff_clock_entries (user_id, clock_in desc);
create index if not exists tello_staff_clock_entries_staff
  on tello_staff_clock_entries (user_id, staff_id, clock_in desc);
-- At most one open (not yet clocked-out) entry per person: a double tap can't
-- create two.
create unique index if not exists tello_staff_clock_entries_one_open
  on tello_staff_clock_entries (user_id, staff_id) where clock_out is null;

alter table tello_staff_clock_entries enable row level security;
drop policy if exists "own clock entries" on tello_staff_clock_entries;
create policy "own clock entries" on tello_staff_clock_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

select count(*) as clock_entries_table_ready
from information_schema.tables
where table_schema = 'public' and table_name = 'tello_staff_clock_entries';
