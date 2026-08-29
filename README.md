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

## Session 2 (in progress)

**Part 1 — Roles**

- Two roles: **admin** (full access, unchanged UI) and **caregiver** (Schedule,
  Today's Board, Day Off — the latter two still placeholders pending Part 3).
- New `tello_staff_roles` table maps each signed-in account to an org
  (`owner_id`, the admin's uid) and a role. A brand-new account self-bootstraps
  as the admin of its own org on first login.
- The four Session 1 tables are now scoped by org instead of raw `auth.uid()`:
  anyone in the org can read; only admins can write. No data migration needed
  for the existing admin account.

**Part 2 — Staff Directory** (Staff tab)

- New `tello_staff_members` table: name, role, and a home assignment (soft
  reference to a home in `tello_staff_config.homes`), org-scoped like the rest
  — anyone in the org can read, only admins can add/edit/remove.
- Staff tab (admin only): add/edit/remove staff, inline-editable name/role/home.
- Schedule Board cells are now `<select>` dropdowns populated from the staff
  directory, with a "+ Custom name…" option for names not yet added, and
  existing free-text values still display even if they don't match a staff
  member.
- Caregiver logins are provisioned by the admin from a staff row's "+ Create
  Login" button (email + temporary password). This uses a second, non-session-
  persisting Supabase client to call `auth.signUp` so it doesn't sign the
  admin out; the new user is immediately linked into `tello_staff_roles` and
  the staff row. The caregiver resets their own password later via "Forgot
  password?" on the sign-in screen.

**Part 3 — Day Off Requests**

- New `tello_staff_dayoff_requests` table: date, reason, status
  (pending/approved/denied), tied to the requesting staff member. A caregiver
  can only file requests against their own linked staff row; admins see and
  decide every request in their org.
- Caregiver **Day Off** tab: submit a request, see status on past requests,
  cancel a still-pending one.
- Admin **Staff** tab: a Day Off Requests section lists everyone's requests
  (pending first) with Approve/Deny.
- An approved day off flags the matching cell(s) on the Schedule Board (🌴,
  tinted background) for that staff member on that date.
- Caregiver **My Schedule** (the Schedule tab) is now live: a read-only,
  week-by-week list of everywhere their name appears across homes and the
  reliever pool, plus their approved days off — no more placeholder.

**Part 4 — Birthdays on the Staff Directory**

- Birthdays moved off the standalone Today's Board list and onto each staff
  member's own record (`bday_month`/`bday_day` on `tello_staff_members`), set
  from the Staff tab — one source of truth instead of typing a name twice.
  Today's Board's Birthdays card now reads from the staff directory; the old
  add-birthday form is gone. The Session 1 `tello_staff_birthdays` table is
  left in the database, unused.

## Session 2, round 2 (in progress)

Staff directory, schedule dropdowns, admin-provisioned logins, and day off
requests from the first round of Session 2 already cover most of this
round's ask — see Parts 2–3 above. New work goes here.

**Part 1 — Staff contact field**

- Added `contact` (phone) to `tello_staff_members`, editable from the Add
  Staff Member form and inline on each staff row, alongside name/role/home/
  birthday. Schema change lives in a fresh `schema_v3.sql` rather than being
  appended to `schema_v2.sql`, per this round's instructions.

**Part 2 — Schedule Board Upgrade**

- **Gap-detection colors**: every Schedule Board cell (Homes and Reliever
  Pool, week and month views) is now tinted — filled = green, empty = red,
  approved day off = gray — instead of a plain background.
- **Location per reliever slot**: each Reliever Pool day-cell is now a Name
  dropdown *and* a Location dropdown (options = your configured homes, plus
  a custom-value escape hatch), since relievers float between homes. No DB
  migration needed — it's a shape change within the existing `assignments`
  jsonb column (old plain-string reliever values still display correctly:
  they're read as "name, no location").
- **Monthly view (Reliever Pool only)**: a Week/Month toggle above the
  Reliever Pool table. Month mode renders a read-only Sun–Sat calendar grid
  (leading/trailing days from adjacent months included), each day cell
  listing every reliever working that day (name + location) and anyone on
  an approved day off. Live editing stays in Week mode — a full month of
  inline dropdowns per reliever wouldn't be legible, especially on mobile.
  The Homes board stays weekly-only (24 data points/day across 8 homes × 3
  slots doesn't compact into a calendar cell the way a single reliever list
  does).
- Staff dropdown per slot was already in place from the prior round.

**Part 3 — Day Off Request**

No new work — already fully built in the prior round (caregiver submit/
cancel, admin approve/deny, approved days flagged on the Schedule Board)
and re-verified against this round's wording.

**Part 4 — Tello AI Gap Resolver**

- The **Chat** tab (previously a "coming in the next session" placeholder)
  is now **Tello**: a rule-based gap resolver, not an LLM call — no new
  infrastructure, works instantly, fully explainable.
- For the displayed week (shared with the Schedule tab), it finds every
  empty Home or Reliever Pool slot and suggests who's available: not
  already assigned elsewhere that day, and no approved day off that date.
  Suggestions are ranked by fewest shifts already assigned that week, to
  spread hours fairly.
- Each gap shows a plain-English explanation (e.g. "Jordan is available —
  not assigned Aug 29, 2 shifts this week"), a dropdown of every other
  available candidate to pick a different one, and an Assign button that
  writes directly to that slot — same effect as filling it by hand on the
  Schedule Board.
- Pure function of the current roster/schedule/day-off data — no hardcoded
  names, homes, or locations, so it works the same for any operator's data.

## Setup

### 1. Database (Supabase project `nwlhsshvqmbhemhxcran`)

Run, in order: `schema.sql`, then `schema_v2.sql`, then `schema_v3.sql`
(append new sections to whichever file matches the round they belong to).
Together they create `tello_staff_config`, `tello_staff_schedule`,
`tello_staff_reminders`, `tello_staff_birthdays`, `tello_staff_roles`,
`tello_staff_members`, and `tello_staff_dayoff_requests`, all RLS-scoped per
org, and are safe to re-run.

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

- Data is scoped per organization (one admin's `owner_id`) via Supabase RLS:
  everyone in the org can read, only admins can write. One org today, matching
  current usage — the schema doesn't assume more.
- Reliever pool "slots" are just a nameable roster with their own Mon–Sun
  grid, same as homes — pick or type who's deployed into any cell.
