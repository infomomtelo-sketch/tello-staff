-- Tello Staff — clock-in/out photo + location verification.
-- Run in the Supabase SQL editor for project nwlhsshvqmbhemhxcran, AFTER
-- schema_clock.sql and BEFORE deploying the matching code (the staff clock
-- endpoint reads the consent table, so it errors until this has been run).
-- Safe to run more than once. Only touches tello_staff_* objects plus one new
-- private storage bucket, 'clock-photos' (nothing Title22 uses).
--
-- What this adds
--   * a selfie taken at the moment of each clock-in / clock-out (private bucket,
--     only the owning admin can read it; deleted automatically after 90 days by
--     functions/api/staff-clock.js)
--   * the phone's location AT THE MOMENT of the punch (never tracked in the
--     background) and its distance from the home's saved location
--   * a record that each staff member saw and agreed to that notice
-- No face matching is done and no face template is stored.

-- 1. Photo + location columns on each punch.
alter table tello_staff_clock_entries
  add column if not exists in_photo text,      -- storage path in 'clock-photos'
  add column if not exists out_photo text,
  add column if not exists in_lat double precision,
  add column if not exists in_lng double precision,
  add column if not exists in_accuracy_m real,
  add column if not exists in_distance_m real,  -- metres from the home's saved location
  add column if not exists out_lat double precision,
  add column if not exists out_lng double precision,
  add column if not exists out_accuracy_m real,
  add column if not exists out_distance_m real;

-- 2. Consent record. Staff have no login, so the endpoint (service role) writes
--    this; the admin who owns the staff member can read it.
create table if not exists tello_staff_clock_consent (
  user_id uuid not null references auth.users(id) on delete cascade,
  staff_id text not null,
  consent_version text not null,
  consented_at timestamptz not null default now(),
  primary key (user_id, staff_id, consent_version)
);
alter table tello_staff_clock_consent enable row level security;
drop policy if exists "own clock consent" on tello_staff_clock_consent;
create policy "own clock consent" on tello_staff_clock_consent
  for select using (auth.uid() = user_id);

-- 3. Private bucket for the selfies. Objects are stored as
--    <admin user_id>/<entry id>-in.jpg / -out.jpg. The endpoint uploads with the
--    service role; an admin can read only the folder named after their own id.
insert into storage.buckets (id, name, public)
values ('clock-photos', 'clock-photos', false)
on conflict (id) do nothing;

drop policy if exists "tello clock photos owner read" on storage.objects;
create policy "tello clock photos owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'clock-photos' and (storage.foldername(name))[1] = auth.uid()::text);

select
  (select count(*) from information_schema.columns
     where table_name = 'tello_staff_clock_entries' and column_name = 'in_photo') as photo_columns_ready,
  (select count(*) from information_schema.tables
     where table_name = 'tello_staff_clock_consent') as consent_table_ready,
  (select count(*) from storage.buckets where id = 'clock-photos') as photo_bucket_ready;
