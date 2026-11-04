-- Tello Staff — in-app time clock sign-in (employee number + PIN) and the
-- embeddable clock. Run in the Supabase SQL editor for project
-- nwlhsshvqmbhemhxcran, AFTER schema_clock.sql and schema_clock_v2.sql and
-- BEFORE deploying the matching code. Safe to run more than once. Only touches
-- tello_staff_* objects (nothing Title22 uses).
--
-- How it fits together
--   * The admin turns on the clock in the Time tab. That creates a public
--     "clock key" (identifies the company on the clock page / widget; it is NOT
--     a password) and a list of websites allowed to embed the widget.
--   * Each staff member gets an employee number and a PIN, set by the admin.
--     Only a salted hash of the PIN is stored, written by the server.
--   * Staff open the clock (own URL or embedded), sign in with number + PIN,
--     then punch with a selfie + location (schema_clock_v2.sql).

-- 1. Clock key + allowed websites on the admin's config row.
alter table tello_staff_config
  add column if not exists clock_key text,
  add column if not exists clock_allowed_origins jsonb not null default '[]'::jsonb;
create unique index if not exists tello_staff_config_clock_key_uniq
  on tello_staff_config (clock_key) where clock_key is not null;

-- 2. Staff sign-in. Written only by functions/api/clock-admin.js (service role);
--    the admin can read the non-secret columns of their own rows.
create table if not exists tello_staff_clock_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  staff_id text not null,
  emp_no text not null,
  pin_hash text,                       -- PBKDF2-SHA256, base64
  pin_salt text,
  pin_set boolean generated always as (pin_hash is not null) stored,
  failed_count int not null default 0, -- wrong PINs in a row; 5 = locked 15 min
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, staff_id)
);
create unique index if not exists tello_staff_clock_credentials_emp
  on tello_staff_clock_credentials (user_id, lower(emp_no));

alter table tello_staff_clock_credentials enable row level security;
drop policy if exists "own clock credentials" on tello_staff_clock_credentials;
create policy "own clock credentials" on tello_staff_clock_credentials
  for select using (auth.uid() = user_id);

-- The admin's browser may read status columns but never the hash or salt.
revoke all on tello_staff_clock_credentials from anon, authenticated;
grant select (user_id, staff_id, emp_no, pin_set, failed_count, locked_until, updated_at)
  on tello_staff_clock_credentials to authenticated;

select
  (select count(*) from information_schema.columns
     where table_name = 'tello_staff_config' and column_name = 'clock_key') as clock_key_ready,
  (select count(*) from information_schema.tables
     where table_name = 'tello_staff_clock_credentials') as credentials_table_ready;
