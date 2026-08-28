# tello-staff

**Tello Staff** — care home staff operations app. A separate, standalone tool
from the Tello AI advisor (`tello.html` / `tello-runp8`): this app is for
day-to-day scheduling and shift operations, no AI involved yet.

Single static file (`index.html`), no build step — matches the other RunP8 apps.

## Session 1 — what's built

- **Schedule Board** — configurable homes (default 8), each with Caregiver 1 /
  Caregiver 2 / Night Shift slots, an 11-slot reliever pool, a Mon–Sun weekly
  view, and a printable layout.
- **Today's Board** — today's date, admin-added reminder cards (title, note,
  due time), manually-entered staff birthdays, and a shift summary pulled
  live from the Schedule Board.
- Bottom nav: **Schedule**, **Today**, **Staff** (placeholder), **Chat**
  (placeholder) — both land in a future session.
- Auth: Supabase email/password sign in, sign up, and password reset.

## Setup

### 1. Database (Supabase project `nwlhsshvqmbhemhxcran`)

Paste `schema.sql` into the Supabase SQL editor and run it. It creates four
tables (`tello_staff_config`, `tello_staff_schedule`, `tello_staff_reminders`,
`tello_staff_birthdays`), each with RLS scoped to `auth.uid()`, and is safe to
re-run.

### 2. Fill in the anon key

Open `index.html` and set `SUPABASE_ANON_KEY` (Supabase → Project Settings →
API → anon public key) — it ships with a placeholder that will not
authenticate anyone until replaced.

### 3. Cloudflare Pages

- Connect this repo, no build command, output directory = repo root.
- Once you know the real production URL, update `REDIRECT_URL` in
  `index.html` to match exactly (currently hardcoded to the placeholder
  `https://tello-staff.pages.dev`) and add that same URL to Supabase →
  Authentication → URL Configuration → Redirect URLs.

## Notes

- All data is scoped per signed-in user via Supabase RLS — one admin account
  today, matching the current single-user usage.
- Reliever pool "slots" are just a nameable roster with their own Mon–Sun
  grid, same as homes — type where a reliever is deployed into any cell.
