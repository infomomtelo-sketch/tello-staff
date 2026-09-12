-- Tello Staff — Session 2 (round 2) schema
-- Run in the Supabase SQL editor for project nwlhsshvqmbhemhxcran, AFTER
-- schema.sql and schema_v2.sql. Safe to run more than once. A fresh file
-- (not appended to schema_v2.sql) per this round's instructions — sections
-- are appended here as each part of this round lands.

-- ===========================================================================
-- Part 1 — Staff contact field
-- ===========================================================================
-- Everything else in Part 1 of this round (staff directory, dropdowns in
-- the Schedule Board, admin-provisioned caregiver logins) already exists
-- from the prior round (tello_staff_members, schema_v2.sql). This is the
-- only new piece: a contact (phone) field per staff member.

alter table tello_staff_members add column if not exists contact text;

select
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'tello_staff_members' and column_name = 'contact') as contact_column_added;
